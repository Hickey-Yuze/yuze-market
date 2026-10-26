/**
 * Connector install = write a `@deepseek-ai/dsh-mcp-client` entry into the
 * profile patch YAML.
 *
 * WorkBuddy connectors are MCP packages: each ships `mcp.json` with a
 * Streamable-HTTP endpoint (424 of 503) or a stdio command. Turning one on in
 * DSH means adding a loader entry, not copying a skill — so this module edits
 * `~/.dsh/profiles/<profile>/cordis.patch.yml` in place.
 *
 * The patch file is hand-authored and comment-heavy, so every edit is a
 * line-range insert/remove that preserves surrounding text byte for byte, and
 * every write is preceded by a timestamped backup. Entries this plugin owns
 * carry the `mcp-wbm-` id prefix, which is how we detect and remove them.
 */

import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import type { InstallResult, MarketItem, McpServerConfig } from './types.js'

export interface McpDeps {
  /** Absolute path of the profile's `cordis.patch.yml`. */
  readonly profilePath: string
  /** Where timestamped backups are written before each edit. */
  readonly backupDir: string
}

/** Id prefix that marks an entry as owned (and therefore removable) by us. */
export const MCP_ENTRY_PREFIX = 'mcp-wbm-'

/** Installed connectors are listed from the patch file, not from a marker dir. */
export interface InstalledConnector {
  readonly id: string
  readonly serverName: string
  readonly transport: string
  /** False when the entry is parked with `disabled: true`, so the Host skips it. */
  readonly enabled: boolean
}

/**
 * DSH requires `serverName` to match `[A-Za-z0-9_-]{1,32}` and to be unique
 * inside a registration scope. The upstream `mcp.json` names are already close
 * to that, but a few carry dots or run long.
 */
export function sanitizeServerName(raw: string): string {
  const cleaned = raw
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
  return cleaned.length > 0 ? cleaned : 'connector'
}

export function entryId(item: MarketItem): string {
  return `${MCP_ENTRY_PREFIX}${item.name}`
}

// ---------------------------------------------------------------- install

export async function installConnectorMcp(item: MarketItem, deps: McpDeps): Promise<InstallResult> {
  const mcp = item.mcp
  if (mcp === undefined) {
    return {
      ok: false,
      kind: 'connector',
      target: item.id,
      code: 'no-mcp',
      message: item.installNote ?? '该连接器没有声明 MCP 端点',
    }
  }
  if (mcp.transport === 'sse') {
    return {
      ok: false,
      kind: 'connector',
      target: item.id,
      code: 'unsupported-transport',
      message: 'DSH 的 MCP 客户端只支持 stdio 与 streamable-http，该连接器只提供 sse 端点',
    }
  }
  if (mcp.transport === 'streamable-http' && mcp.url === undefined) {
    return { ok: false, kind: 'connector', target: item.id, code: 'no-url', message: 'mcp.json 缺少 url' }
  }
  if (mcp.transport === 'stdio' && mcp.command === undefined) {
    return { ok: false, kind: 'connector', target: item.id, code: 'no-command', message: 'mcp.json 缺少 command' }
  }

  const id = entryId(item)
  let text: string
  try {
    text = await readFile(deps.profilePath, 'utf8')
  } catch (cause) {
    return {
      ok: false,
      kind: 'connector',
      target: item.id,
      code: 'profile-missing',
      message: `读不到 profile 配置：${(cause as Error).message}`,
    }
  }

  if (hasEntry(text, id)) {
    return {
      ok: true,
      kind: 'connector',
      target: id,
      code: 'already-installed',
      message: '该连接器已在 MCP 配置中',
      warnings: [restartHint],
    }
  }

  const lines = text.split('\n')
  const range = findInsertList(lines)
  if (range === null) {
    return {
      ok: false,
      kind: 'connector',
      target: item.id,
      code: 'no-insert-block',
      message: 'cordis.patch.yml 里没有 `- insert:` 列表，无法安全写入',
    }
  }

  const block = renderEntry(item, mcp, range.itemIndent)
  const next = [...lines.slice(0, range.end), ...block, ...lines.slice(range.end)]

  const backup = await backupProfile(deps)
  await writeFile(deps.profilePath, next.join('\n'), 'utf8')

  return {
    ok: true,
    kind: 'connector',
    target: id,
    message: `${item.title} 已写入 MCP 配置`,
    warnings: [restartHint, ...(backup === null ? [] : [`原配置已备份到 ${backup}`])],
  }
}

const restartHint = '需要重载或重启 Harness 后，该连接器的工具才会出现'

// ---------------------------------------------------------------- uninstall

export async function uninstallConnectorMcp(id: string, deps: McpDeps): Promise<InstallResult> {
  let text: string
  try {
    text = await readFile(deps.profilePath, 'utf8')
  } catch (cause) {
    return { ok: false, kind: 'connector', target: id, code: 'profile-missing', message: (cause as Error).message }
  }

  const lines = text.split('\n')
  const range = findEntryRange(lines, id)
  if (range === null) {
    return { ok: true, kind: 'connector', target: id, code: 'not-installed', message: '该连接器不在 MCP 配置中' }
  }

  const next = [...lines.slice(0, range.start), ...lines.slice(range.end)]
  await backupProfile(deps)
  await writeFile(deps.profilePath, next.join('\n'), 'utf8')

  return { ok: true, kind: 'connector', target: id, message: '已从 MCP 配置移除', warnings: [restartHint] }
}

// ---------------------------------------------------------------- headers

/**
 * Replace the `headers:` block of the connector entry whose `serverName`
 * matches. Used by the OAuth flow to drop a freshly issued bearer token into
 * the profile, and to strip it again on disconnect.
 *
 * An empty `headers` map removes the block entirely so the file returns to its
 * pre-authorization shape.
 */
export async function setConnectorHeaders(
  serverName: string,
  headers: Record<string, string>,
  deps: McpDeps,
): Promise<InstallResult> {
  let text: string
  try {
    text = await readFile(deps.profilePath, 'utf8')
  } catch (cause) {
    return { ok: false, kind: 'connector', target: serverName, code: 'profile-missing', message: (cause as Error).message }
  }

  const lines = text.split('\n')
  const block = findServerBlock(lines, serverName)
  if (block === null) {
    return {
      ok: false,
      kind: 'connector',
      target: serverName,
      code: 'not-installed',
      message: `MCP 配置里没有 serverName 为 ${serverName} 的条目，请先安装该连接器`,
    }
  }

  // Drop any existing headers list, recording the key indentation we saw.
  let keyIndent = ''
  let start = -1
  for (let index = block.start; index < block.end; index++) {
    const match = /^(\s*)headers:\s*$/.exec(lines[index] ?? '')
    if (match === null) continue
    start = index
    keyIndent = `${match[1] ?? ''}  `
    let end = index + 1
    while (end < block.end) {
      const line = lines[end] ?? ''
      if (line.trim().length === 0) {
        end++
        continue
      }
      const indent = /^\s*/.exec(line)?.[0] ?? ''
      if (indent.length <= (match[1] ?? '').length) break
      end++
    }
    lines.splice(index, end - index)
    block.end -= end - index
    break
  }

  if (Object.keys(headers).length > 0) {
    // Anchor on `url:`/`command:` so key order stays url → headers.
    let anchor = -1
    let anchorIndent = ''
    for (let index = block.start; index < block.end; index++) {
      const match = /^(\s*)(url|command):/.exec(lines[index] ?? '')
      if (match === null) continue
      anchor = index
      anchorIndent = (match[1] ?? '') + '  '
      break
    }
    if (anchor < 0) {
      return { ok: false, kind: 'connector', target: serverName, code: 'no-anchor', message: '条目里找不到 url/command 行' }
    }
    const baseIndent = anchorIndent.slice(0, Math.max(0, anchorIndent.length - 2))
    const block_ = [`${baseIndent}headers:`]
    for (const [key, value] of Object.entries(headers)) block_.push(`${anchorIndent}${key}: ${quote(value)}`)
    // Keep a previously observed indentation so replays stay byte-stable.
    if (keyIndent.length > 0 && keyIndent.length !== anchorIndent.length) {
      block_[0] = `${baseIndent}headers:`
    }
    lines.splice(anchor + 1, 0, ...block_)
  }

  await backupProfile(deps)
  await writeFile(deps.profilePath, lines.join('\n'), 'utf8')
  return { ok: true, kind: 'connector', target: serverName, message: '已更新 MCP 配置' }
}

interface ServerBlock {
  readonly start: number
  end: number
}

/** Line range of the `- id:` entry that declares `serverName: <name>`. */
function findServerBlock(lines: readonly string[], serverName: string): ServerBlock | null {
  for (let index = 0; index < lines.length; index++) {
    const match = /^(\s*)-\s+serverName:\s*(\S+)\s*$/.exec(lines[index] ?? '')
    if (match !== null && match[2] === serverName) {
      return blockAround(lines, index)
    }
  }
  // The `serverName:` normally sits under `config:` a few lines below the
  // `- id:` marker, so also scan entries by their config body.
  for (let index = 0; index < lines.length; index++) {
    if (!/^\s*-\s+id:\s*\S+\s*$/.test(lines[index] ?? '')) continue
    const block = blockAround(lines, index)
    for (let scan = block.start; scan < block.end; scan++) {
      const match = /^\s+serverName:\s*(\S+)\s*$/.exec(lines[scan] ?? '')
      if (match !== null && match[1] === serverName) return block
    }
    index = block.end - 1
  }
  return null
}

function blockAround(lines: readonly string[], anchor: number): ServerBlock {
  const indent = (/^\s*/.exec(lines[anchor] ?? '')?.[0] ?? '').length
  let end = lines.length
  for (let index = anchor + 1; index < lines.length; index++) {
    const match = /^(\s*)-\s+/.exec(lines[index] ?? '')
    if (match !== null && (match[1] ?? '').length <= indent) {
      end = index
      break
    }
  }
  return { start: anchor, end }
}

/** The `url` of an installed streamable-http connector, if it has one. */
export async function findConnectorUrl(serverName: string, deps: McpDeps): Promise<string | null> {
  let text: string
  try {
    text = await readFile(deps.profilePath, 'utf8')
  } catch {
    return null
  }
  const lines = text.split('\n')
  const block = findServerBlock(lines, serverName)
  if (block === null) return null
  for (let index = block.start; index < block.end; index++) {
    const match = /^\s*url:\s*'?([^'\s]+)'?\s*$/.exec(lines[index] ?? '')
    if (match !== null && match[1] !== undefined) return match[1]
  }
  return null
}

// ---------------------------------------------------------------- list

export async function listInstalledConnectors(deps: McpDeps): Promise<readonly InstalledConnector[]> {
  let text: string
  try {
    text = await readFile(deps.profilePath, 'utf8')
  } catch {
    return []
  }
  const out: InstalledConnector[] = []
  const lines = text.split('\n')
  for (let index = 0; index < lines.length; index++) {
    const match = /^\s*-\s+id:\s*(\S+)\s*$/.exec(lines[index] ?? '')
    const id = match?.[1]
    if (id === undefined || !id.startsWith(MCP_ENTRY_PREFIX)) continue
    let serverName = id.slice(MCP_ENTRY_PREFIX.length)
    let transport = 'streamable-http'
    let enabled = true
    // The entry's own `config:` sits on the following lines.
    for (let scan = index + 1; scan < lines.length; scan++) {
      const line = lines[scan] ?? ''
      if (/^\s*-\s+id:/.test(line)) break
      const server = /^\s+serverName:\s*(\S+)\s*$/.exec(line)?.[1]
      if (server !== undefined) serverName = server
      const kind = /^\s+transport:\s*(\S+)\s*$/.exec(line)?.[1]
      if (kind !== undefined) transport = kind
      // `disabled` is an entry option, so it sits beside `name:` rather than
      // under `config:` — but accept either indentation to stay forgiving.
      if (/^\s+disabled:\s*true\s*$/u.test(line)) enabled = false
    }
    out.push({ id, serverName, transport, enabled })
  }
  return out
}

// -------------------------------------------------------------- enable/disable

/**
 * Park or restore one MCP entry.
 *
 * The Host's loader already understands `disabled: true` on an entry and skips
 * it entirely, which is exactly the semantics the panel's switch promises: the
 * configuration stays in the file, the connector simply does not load until the
 * next boot. Removal is a separate operation.
 */
export async function setConnectorEnabled(
  serverName: string,
  enabled: boolean,
  deps: McpDeps,
): Promise<InstallResult> {
  let text: string
  try {
    text = await readFile(deps.profilePath, 'utf8')
  } catch (cause) {
    return {
      ok: false,
      kind: 'connector',
      target: serverName,
      code: 'profile-missing',
      message: (cause as Error).message,
    }
  }

  const lines = text.split('\n')
  const block = findServerBlock(lines, serverName)
  if (block === null) {
    return {
      ok: false,
      kind: 'connector',
      target: serverName,
      code: 'not-installed',
      message: `MCP 配置里没有 serverName 为 ${serverName} 的条目`,
    }
  }

  // Drop any existing flag first so the rewrite is idempotent.
  for (let index = block.end - 1; index >= block.start; index--) {
    if (/^\s+disabled:\s*(?:true|false)\s*$/u.test(lines[index] ?? '')) lines.splice(index, 1)
  }

  if (!enabled) {
    let anchor = -1
    let anchorIndent = ''
    for (let index = block.start; index < lines.length; index++) {
      const match = /^(\s*)name:\s*\S+/u.exec(lines[index] ?? '')
      if (match === null) continue
      anchor = index
      anchorIndent = match[1] ?? ''
      break
    }
    if (anchor < 0) {
      return {
        ok: false,
        kind: 'connector',
        target: serverName,
        code: 'malformed-entry',
        message: '该条目没有 name 字段，无法写入 disabled',
      }
    }
    lines.splice(anchor + 1, 0, `${anchorIndent}disabled: true`)
  }

  await backupProfile(deps)
  await writeFile(deps.profilePath, lines.join('\n'), 'utf8')

  return {
    ok: true,
    kind: 'connector',
    target: serverName,
    message: enabled ? '已启用，重启后生效' : '已停用，重启后生效',
    warnings: ['MCP 配置在宿主启动时读取，改动需重启 Harness 才生效'],
  }
}

// ---------------------------------------------------------------- yaml edit

interface InsertList {
  /** Index of the line that terminates the list (insert before it). */
  readonly end: number
  /** Indentation of list items inside `- insert:`. */
  readonly itemIndent: string
}

/** Locate the first `- insert:` block and the point where its list ends. */
function findInsertList(lines: readonly string[]): InsertList | null {
  let header = -1
  let baseIndent = ''
  for (let index = 0; index < lines.length; index++) {
    const match = /^(\s*)-\s+insert:\s*$/.exec(lines[index] ?? '')
    if (match === null) continue
    header = index
    baseIndent = match[1] ?? ''
    break
  }
  if (header < 0) return null

  let itemIndent = ''
  let end = lines.length
  for (let index = header + 1; index < lines.length; index++) {
    const line = lines[index] ?? ''
    if (line.trim().length === 0) continue
    const indent = /^\s*/.exec(line)?.[0] ?? ''
    if (itemIndent === '') itemIndent = indent
    // A line at or left of the `- insert:` marker starts the next patch entry.
    if (indent.length <= baseIndent.length) {
      end = index
      break
    }
  }
  if (itemIndent === '') itemIndent = `${baseIndent}    `
  return { end, itemIndent }
}

interface EntryRange {
  readonly start: number
  readonly end: number
}

/** Find `mcp-wbm-<id>` entry lines, swallowing its own comment banner. */
function findEntryRange(lines: readonly string[], id: string): EntryRange | null {
  let head = -1
  let indent = 0
  for (let index = 0; index < lines.length; index++) {
    const match = /^(\s*)-\s+id:\s*(\S+)\s*$/.exec(lines[index] ?? '')
    if (match === null || match[2] !== id) continue
    head = index
    indent = (match[1] ?? '').length
    break
  }
  if (head < 0) return null

  let start = head
  while (start > 0) {
    const prev = lines[start - 1] ?? ''
    const comment = /^\s*#/.exec(prev)
    if (comment === null) break
    start--
  }

  let end = lines.length
  for (let index = head + 1; index < lines.length; index++) {
    const line = lines[index] ?? ''
    if (line.trim().length === 0) continue
    const match = /^(\s*)-\s+/.exec(line)
    if (match !== null && (match[1] ?? '').length <= indent) {
      end = index
      break
    }
  }
  return { start, end }
}

function hasEntry(text: string, id: string): boolean {
  return new RegExp(`^\\s*-\\s+id:\\s*${escapeRegex(id)}\\s*$`, 'm').test(text)
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function quote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

function renderEntry(item: MarketItem, mcp: McpServerConfig, indent: string): string[] {
  const step = '  '
  const config = `${indent}${step}${step}`
  const lines: string[] = []

  lines.push(`${indent}# Yuze-MCP 连接器 · ${item.title}（由 Yuze-市场 安装，卸载时整段移除）`)
  lines.push(`${indent}- id: ${entryId(item)}`)
  lines.push(`${indent}${step}name: '@deepseek-ai/dsh-mcp-client'`)
  lines.push(`${indent}${step}config:`)
  lines.push(`${config}serverName: ${sanitizeServerName(mcp.serverName)}`)
  lines.push(`${config}transport: ${mcp.transport}`)

  if (mcp.transport === 'streamable-http') {
    lines.push(`${config}url: ${quote(mcp.url ?? '')}`)
    const headers = Object.entries(mcp.headers ?? {})
    if (headers.length > 0) {
      lines.push(`${config}headers:`)
      for (const [key, value] of headers) lines.push(`${config}${step}${key}: ${quote(value)}`)
    }
  } else {
    lines.push(`${config}command: ${quote(mcp.command ?? '')}`)
    const args = mcp.args ?? []
    if (args.length > 0) lines.push(`${config}args: [ ${args.map(quote).join(', ')} ]`)
    const env = Object.entries(mcp.env ?? {})
    if (env.length > 0) {
      lines.push(`${config}env:`)
      for (const [key, value] of env) lines.push(`${config}${step}${key}: ${quote(value)}`)
    }
  }
  return lines
}

async function backupProfile(deps: McpDeps): Promise<string | null> {
  try {
    if (!existsSync(deps.profilePath)) return null
    await mkdir(deps.backupDir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const target = join(deps.backupDir, `cordis.patch.${stamp}.yml`)
    await copyFile(deps.profilePath, target)
    return target
  } catch {
    return null
  }
}
