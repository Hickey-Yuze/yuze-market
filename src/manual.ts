/**
 * Manual installs: the escape hatch for anything the three catalogues do not
 * carry.
 *
 * Each surface accepts the shape that actually exists on disk for that product:
 *
 * - skills/experts: a local directory holding `SKILL.md`, or a `.zip` that
 *   contains one (the market's own bundle format)
 * - connectors: the `mcp.json` body, so a server can be wired up without being
 *   in the catalogue at all
 * - plugins: an npm package name, a `.tgz`, or a local package directory
 *
 * Nothing here trusts the caller: a directory name must be a legal skill id, an
 * archive is extracted in a temp dir, and a connection string must be https or
 * a stdio command.
 */

import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, isAbsolute, join, resolve } from 'node:path'

import { extractZip } from './archive.js'
import { writeManualMarker } from './managed.js'
import { registerProfileBundle, type PnpmRunner } from './plugin-install.js'
import { collectSkillCandidates, isValidSkillId, SKILL_FILE } from './skill-install.js'
import type { MarketItem, MarketKind } from './wb/types.js'

/** Manual installs cover the plugin surface too, which the catalogues do not. */
export type ManualKind = MarketKind | 'plugin'

/** Same shape as the catalogue installs, widened for `plugin`. */
export interface ManualInstallResult {
  readonly ok: boolean
  readonly kind: ManualKind
  readonly target: string
  readonly code?: string
  readonly message?: string
  readonly warnings?: readonly string[]
}
import { installConnectorMcp, type McpDeps } from './wb/mcp-install.js'

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

function failure(kind: ManualKind, target: string, code: string, message: string): ManualInstallResult {
  return { ok: false, kind, target, code, message }
}

// -------------------------------------------------------------------- skills

export interface ManualSkillOptions {
  readonly source: string
  readonly skillRoot: string
  /** Rename the installed directory; defaults to the bundle's own name. */
  readonly name?: string
}

/**
 * Install a skill from a local directory or a local/remote `.zip`.
 *
 * The archive path reuses the market's extractor, so a zip that ships several
 * skills picks the one whose directory matches `name` and otherwise the first
 * one — the same rule the marketplace install uses.
 */
export async function installSkillManually(options: ManualSkillOptions): Promise<ManualInstallResult> {
  const source = options.source.trim()
  if (source.length === 0) return failure('skill', '', 'bad-request', '请填写目录或压缩包路径')

  const directory = await stat(source).then(
    info => info,
    () => undefined,
  )
  if (directory === undefined) {
    return failure('skill', source, 'not-found', `路径不存在：${source}`)
  }

  if (directory.isDirectory()) {
    if (!(await exists(join(source, SKILL_FILE)))) {
      return failure('skill', source, 'no-skill-found', `该目录没有 ${SKILL_FILE}`)
    }
    const name = (options.name ?? basename(source)).trim()
    if (!isValidSkillId(name)) {
      return failure('skill', name, 'bad-name', `技能名必须是 kebab-case：${name}`)
    }
    const target = join(options.skillRoot, name)
    await mkdir(options.skillRoot, { recursive: true, mode: 0o700 })
    await rm(target, { recursive: true, force: true })
    await cp(source, target, { recursive: true, dereference: false })
    await writeManualMarker(target, {
      source: 'manual',
      kind: 'skill',
      title: name,
      installedAt: new Date().toISOString(),
    })
    return { ok: true, kind: 'skill', target: name }
  }

  if (!/\.zip$/iu.test(source)) {
    return failure('skill', source, 'unsupported', '只支持目录或 .zip 压缩包')
  }

  const staging = await mkdtemp(join(tmpdir(), 'yuze-manual-skill-'))
  try {
    await extractZip(source, staging)
    const candidates = await collectSkillCandidates(staging)
    if (candidates.length === 0) return failure('skill', source, 'no-skill-found', '压缩包内没有 SKILL.md')
    const wanted = options.name?.trim()
    const picked = (wanted === undefined ? undefined : candidates.find(item => item.name === wanted)) ?? candidates[0]!
    const name = (wanted ?? picked.name).trim()
    if (!isValidSkillId(name)) {
      return failure('skill', name, 'bad-name', `技能名必须是 kebab-case：${name}`)
    }
    const target = join(options.skillRoot, name)
    await mkdir(options.skillRoot, { recursive: true, mode: 0o700 })
    await rm(target, { recursive: true, force: true })
    await cp(picked.directory, target, { recursive: true, dereference: false })
    await writeManualMarker(target, {
      source: 'manual',
      kind: 'skill',
      title: name,
      installedAt: new Date().toISOString(),
    })
    return { ok: true, kind: 'skill', target: name }
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------- connectors

interface LooseMcp {
  serverName?: unknown
  transport?: unknown
  url?: unknown
  command?: unknown
  args?: unknown
  env?: unknown
  headers?: unknown
}

function pickServer(parsed: unknown): LooseMcp | undefined {
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const record = parsed as Record<string, unknown>
  // A full `mcp.json` keeps servers under `mcpServers: { name: {...} }`.
  const servers = record.mcpServers
  if (typeof servers === 'object' && servers !== null) {
    for (const [name, value] of Object.entries(servers as Record<string, unknown>)) {
      if (typeof value !== 'object' || value === null) continue
      return { ...(value as LooseMcp), serverName: name }
    }
  }
  return record as LooseMcp
}

function stringList(value: unknown): readonly string[] | undefined {
  return Array.isArray(value) && value.every(item => typeof item === 'string') ? (value as string[]) : undefined
}

function stringMap(value: unknown): Readonly<Record<string, string>> | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const out: Record<string, string> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item === 'string') out[key] = item
  }
  return Object.keys(out).length === 0 ? undefined : out
}

export interface ManualConnectorOptions {
  readonly json: string
  readonly deps: McpDeps
}

/** Wire up an MCP server that is not in the catalogue. */
export async function installConnectorManually(options: ManualConnectorOptions): Promise<ManualInstallResult> {
  let parsed: unknown
  try {
    parsed = JSON.parse(options.json)
  } catch (cause) {
    return failure('connector', '', 'bad-json', `JSON 解析失败：${(cause as Error).message}`)
  }
  const server = pickServer(parsed)
  if (server === undefined) return failure('connector', '', 'bad-json', '没有找到 MCP 服务器配置')

  const serverName = typeof server.serverName === 'string' ? server.serverName.trim() : ''
  if (serverName.length === 0) return failure('connector', '', 'bad-json', '缺少 serverName')

  const url = typeof server.url === 'string' ? server.url.trim() : undefined
  const command = typeof server.command === 'string' ? server.command.trim() : undefined
  if (url === undefined && command === undefined) {
    return failure('connector', serverName, 'bad-json', '需要 url（远程）或 command（本地）之一')
  }
  if (url !== undefined && !/^https?:\/\//u.test(url)) {
    return failure('connector', serverName, 'bad-url', 'url 必须是 http(s) 地址')
  }

  const declared = typeof server.transport === 'string' ? server.transport : undefined
  const transport =
    declared === 'stdio' || declared === 'sse' || declared === 'streamable-http'
      ? declared
      : command !== undefined
        ? 'stdio'
        : 'streamable-http'
  if (transport === 'sse') {
    return failure('connector', serverName, 'unsupported-transport', 'DSH 只支持 stdio 与 streamable-http，SSE 无法接入')
  }

  const args = stringList(server.args)
  const env = stringMap(server.env)
  const headers = stringMap(server.headers)

  const item: MarketItem = {
    kind: 'connector',
    id: serverName,
    name: serverName.replace(/[^A-Za-z0-9._-]+/gu, '-'),
    title: serverName,
    description: '手动添加的 MCP 服务器',
    tags: [],
    mcp: {
      serverName,
      transport,
      ...(url === undefined ? {} : { url }),
      ...(command === undefined ? {} : { command }),
      ...(args === undefined ? {} : { args }),
      ...(env === undefined ? {} : { env }),
      ...(headers === undefined ? {} : { headers }),
    },
    installable: true,
  }
  return await installConnectorMcp(item, options.deps)
}

// ------------------------------------------------------------------- plugins

export interface ManualPluginOptions {
  readonly spec: string
  readonly profileDir: string
  readonly pnpm: PnpmRunner
  readonly registry?: string
  readonly timeoutMs?: number
}

/** Accept a package name, a `.tgz`, or a package directory. */
export async function installPluginManually(options: ManualPluginOptions): Promise<ManualInstallResult> {
  const spec = options.spec.trim()
  if (spec.length === 0) return failure('plugin', '', 'bad-request', '请填写包名、tgz 路径或目录')

  let argument = spec
  if (spec.startsWith('/') || spec.startsWith('.') || spec.startsWith('~')) {
    const absolute = resolve(spec.replace(/^~/u, process.env.HOME ?? '~'))
    if (!(await exists(absolute))) return failure('plugin', spec, 'not-found', `路径不存在：${absolute}`)
    argument = `file:${absolute}`
  } else if (spec.startsWith('file:')) {
    if (!isAbsolute(spec.slice(5))) return failure('plugin', spec, 'bad-request', 'file: 后面需要绝对路径')
  }

  const argv = ['add', argument]
  if (options.registry !== undefined && options.registry.length > 0) argv.push(`--registry=${options.registry}`)

  const child = options.pnpm.runPlugin(argv, options.profileDir)
  const chunks: string[] = []
  child.stderr.on('data', chunk => chunks.push(String(chunk)))
  child.stdout.on('data', chunk => chunks.push(String(chunk)))
  const timer = setTimeout(() => child.cancel(), options.timeoutMs ?? 120_000)
  try {
    const { exitCode } = await child.done
    if (exitCode !== 0) {
      return failure('plugin', spec, 'pnpm-failed', chunks.join('').slice(-600) || `pnpm 退出码 ${exitCode}`)
    }
  } finally {
    clearTimeout(timer)
  }

  // A local directory/tgz is already in `dependencies`; a bare npm name needs
  // the bundle registration for the Host to load it.
  if (!argument.startsWith('file:')) {
    await registerProfileBundle(options.profileDir, spec).catch(() => false)
  }
  return { ok: true, kind: 'plugin', target: spec, message: '安装完成，重启 Harness 后生效' }
}

/** Directory listing helper used by the panel's path hint. */
export async function listDirectory(path: string): Promise<readonly string[]> {
  try {
    return (await readdir(path)).slice(0, 200)
  } catch {
    return []
  }
}
