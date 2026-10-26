/**
 * Installers for the three WorkBuddy sources.
 *
 * All three end up as plain DSH skills under `~/.dsh/skills/<name>/SKILL.md`,
 * which is the only install format this plugin produces:
 *
 *   expert     → fetch the published agent markdown and rewrite its frontmatter
 *                into the DSH skill shape.
 *   skill      → copy the unpacked skill directory straight across (the two
 *                frontmatter dialects are compatible).
 *   connector  → copy each bundled `skills/<x>` directory, and convert each
 *                `agents/<x>.md` into its own skill.
 *
 * Nothing here shells out to a package manager; every write is a plain file
 * copy so an install is visible to DSH immediately.
 */

import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { installConnectorMcp, type McpDeps } from './mcp-install.js'
import type { InstallResult, MarketItem } from './types.js'

export interface InstallDeps extends McpDeps {
  /** `~/.dsh/workbuddy-market/cache` — the unpacked source trees live here. */
  readonly cacheRoot: string
  /** `~/.dsh/skills` — where every installed skill is written. */
  readonly skillRoot: string
}

/** Written into every installed directory so the UI can tell what it owns. */
const MARKER = '.workbuddy-market.json'

export async function installItem(item: MarketItem, deps: InstallDeps): Promise<InstallResult> {
  if (!item.installable) {
    return {
      ok: false,
      kind: item.kind,
      target: item.id,
      code: 'not-installable',
      message: item.installNote ?? '该条目不可安装',
    }
  }

  switch (item.kind) {
    case 'expert':
      return installExpert(item, deps)
    case 'skill':
      return installSkill(item, deps)
    case 'connector':
      return installConnectorMcp(item, deps)
  }
}

// ---------------------------------------------------------------- expert

async function installExpert(item: MarketItem, deps: InstallDeps): Promise<InstallResult> {
  if (item.promptUrl === undefined) {
    return { ok: false, kind: 'expert', target: item.id, code: 'missing-prompt', message: '缺少提示词地址' }
  }

  let markdown: string
  try {
    const response = await fetch(item.promptUrl, { signal: AbortSignal.timeout(30_000) })
    if (!response.ok) {
      return {
        ok: false,
        kind: 'expert',
        target: item.id,
        code: `http-${response.status}`,
        message: `提示词文件返回 ${response.status}，该专家可能已下架`,
      }
    }
    markdown = await response.text()
  } catch (cause) {
    return {
      ok: false,
      kind: 'expert',
      target: item.id,
      code: 'fetch-failed',
      message: `下载提示词失败：${(cause as Error).message}`,
    }
  }

  const { frontmatter, body } = splitFrontmatter(markdown)
  const dirName = item.name
  const target = join(deps.skillRoot, dirName)

  // Keep the expert's own metadata but guarantee the two keys DSH needs.
  const head: Record<string, string> = { ...frontmatter }
  head.name = dirName
  head.description = stripTags(head.description ?? item.description) || item.description || item.title

  const content = `---\n${Object.entries(head)
    .filter(([, value]) => typeof value === 'string' && value.trim().length > 0)
    .map(([key, value]) => `${key}: ${quoteIfNeeded(value)}`)
    .join('\n')}\n---\n\n${body.trim()}\n`

  await mkdir(target, { recursive: true })
  await writeFile(join(target, 'SKILL.md'), content, 'utf8')
  await writeMarker(target, item)

  return { ok: true, kind: 'expert', target }
}

// ---------------------------------------------------------------- skill

async function installSkill(item: MarketItem, deps: InstallDeps): Promise<InstallResult> {
  const source = item.source ?? item.name
  const zipName = item.zipName
  if (zipName === undefined) {
    return { ok: false, kind: 'skill', target: item.id, code: 'missing-source', message: '目录记录缺少 zipName' }
  }

  const from = join(deps.cacheRoot, 'skills', zipName, 'skills', source)
  if (!(await exists(from))) {
    return {
      ok: false,
      kind: 'skill',
      target: item.id,
      code: 'source-missing',
      message: `本地缓存缺少 ${from}，请重新运行 build-catalog.mjs`,
    }
  }

  // Install under the catalog name, not the bundle directory: the catalog name is
  // already kebab-case (the Host rejects anything else) and it is what the page
  // compares against `GET /installed`, so the "installed" badge stays accurate.
  const target = join(deps.skillRoot, item.name)
  await rm(target, { recursive: true, force: true })
  await cp(from, target, { recursive: true })
  await writeMarker(target, item)

  return { ok: true, kind: 'skill', target }
}

// ---------------------------------------------------------------- helpers

async function writeMarker(target: string, item: MarketItem): Promise<void> {
  const payload = {
    source: 'yuze-market',
    kind: item.kind,
    id: item.id,
    title: item.title,
    installedAt: new Date().toISOString(),
  }
  await writeFile(join(target, MARKER), `${JSON.stringify(payload, null, 2)}\n`, 'utf8').catch(() => {})
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/

function splitFrontmatter(raw: string): {
  frontmatter: Record<string, string>
  body: string
} {
  const match = FRONTMATTER.exec(raw)
  if (match === null) return { frontmatter: {}, body: raw }

  const frontmatter: Record<string, string> = {}
  for (const line of (match[1] ?? '').split(/\r?\n/)) {
    const sep = line.indexOf(':')
    if (sep <= 0) continue
    const key = line.slice(0, sep).trim()
    let value = line.slice(sep + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    if (key.length > 0) frontmatter[key] = value
  }
  return { frontmatter, body: raw.slice(match[0].length) }
}

function quoteIfNeeded(value: string): string {
  const needsQuote = /[:#"'\\{}\[\],&*?|>%@`]/.test(value) || value !== value.trim()
  if (!needsQuote) return value
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/** Descriptions land in one YAML line, so drop HTML/markdown noise. */
function stripTags(value: string): string {
  return value
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** DSH skill names are strict kebab-case; command file stems may not be. */
function skillSegment(raw: string): string {
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return cleaned.length > 0 ? cleaned : 'command'
}

/**
 * One connector can expose the same stem twice (`agents/bugfix.md` and
 * `commands/bugfix.md`); later ones get a numeric suffix so neither is lost.
 */
function uniqueDirName(base: string, taken: readonly string[]): string {
  if (!taken.includes(base)) return base
  for (let i = 2; i < 100; i += 1) {
    const candidate = `${base}-${i}`
    if (!taken.includes(candidate)) return candidate
  }
  return `${base}-${Date.now()}`
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function listDirs(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    return entries.filter(entry => entry.isDirectory()).map(entry => entry.name)
  } catch {
    return []
  }
}

async function listFiles(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    return entries.filter(entry => entry.isFile()).map(entry => entry.name)
  } catch {
    return []
  }
}
