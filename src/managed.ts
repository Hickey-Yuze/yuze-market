/**
 * Unified view of everything this market writes into the skill root.
 *
 * Three products land in the same place — QuWork skills (`_meta.json`),
 * WorkBuddy skills and WorkBuddy experts (`.workbuddy-market.json`) — so the
 * 「已安装」surface needs one record shape for all of them, plus the two
 * operations the panel exposes on every entry: hide it from the Host, or delete
 * it.
 *
 * Disabling moves the directory under `<skillRoot>/.disabled/`. The Host's
 * filesystem provider only recognises `<root>/<name>/SKILL.md` (two segments),
 * so a stash directory never shows up as a skill and the move is reversible
 * byte for byte. Deleting first copies the directory into `<skillRoot>/.trash/`
 * so a misclick on a hand-written skill is still recoverable.
 */

import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile, readlink } from 'node:fs/promises'
import { join } from 'node:path'

export const SKILL_FILE = 'SKILL.md'
export const WB_MARKER = '.workbuddy-market.json'
export const QUWORK_META = '_meta.json'
export const DISABLED_DIR = '.disabled'
export const TRASH_DIR = '.trash'

export type ManagedKind = 'skill' | 'expert' | 'manual'

export interface ManagedEntry {
  readonly name: string
  readonly kind: ManagedKind
  readonly title: string
  readonly description: string
  readonly version?: string
  /** Catalog id this entry was installed from, when it came from a market. */
  readonly marketId?: string
  readonly enabled: boolean
  readonly path: string
  readonly installedAt?: string
}

interface Markers {
  readonly wb?: Record<string, unknown>
  readonly quwork?: Record<string, unknown>
}

async function readMarkers(directory: string): Promise<Markers> {
  const read = async (file: string): Promise<Record<string, unknown> | undefined> => {
    try {
      const parsed = JSON.parse(await readFile(join(directory, file), 'utf8')) as unknown
      return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : undefined
    } catch {
      return undefined
    }
  }
  return { wb: await read(WB_MARKER), quwork: await read(QUWORK_META) }
}

/** First `key: value` of the SKILL.md frontmatter, without a YAML dependency. */
function frontmatterField(text: string, key: string): string | undefined {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(text)
  if (match === null) return undefined
  for (const line of (match[1] ?? '').split(/\r?\n/u)) {
    const separator = line.indexOf(':')
    if (separator <= 0) continue
    if (line.slice(0, separator).trim() !== key) continue
    let value = line.slice(separator + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    return value.length > 0 ? value : undefined
  }
  return undefined
}

function stringOf(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * Read one installed directory. Returns undefined when it holds no SKILL.md —
 * a stash of `node_modules` or a half-finished copy is not a skill.
 */
export async function readManagedEntry(
  root: string,
  name: string,
  enabled: boolean,
): Promise<ManagedEntry | undefined> {
  const directory = enabled ? join(root, name) : join(root, DISABLED_DIR, name)
  const skillFile = join(directory, SKILL_FILE)
  try {
    const info = await stat(skillFile)
    if (!info.isFile()) return undefined
  } catch {
    return undefined
  }

  const text = await readFile(skillFile, 'utf8').catch(() => '')
  const { wb, quwork } = await readMarkers(directory)

  const markerKind = stringOf(wb, 'kind')
  const kind: ManagedKind = markerKind === 'expert' ? 'expert' : 'skill'

  const title =
    stringOf(wb, 'title') ??
    stringOf(quwork, 'nameCn') ??
    stringOf(quwork, 'slug') ??
    frontmatterField(text, 'name') ??
    name
  const description = frontmatterField(text, 'description') ?? ''
  const version = stringOf(wb, 'version') ?? stringOf(quwork, 'version')

  return {
    name,
    kind,
    title,
    description,
    ...(version === undefined ? {} : { version }),
    ...(stringOf(wb, 'id') === undefined ? {} : { marketId: stringOf(wb, 'id') }),
    enabled,
    path: directory,
    ...(stringOf(wb, 'installedAt') === undefined ? {} : { installedAt: stringOf(wb, 'installedAt') }),
  }
}

async function directoryNames(path: string): Promise<string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true })
    return entries.filter(entry => entry.isDirectory()).map(entry => entry.name).sort()
  } catch {
    return []
  }
}

/** Every installed skill and expert, enabled ones first. */
export async function listManaged(skillRoot: string): Promise<readonly ManagedEntry[]> {
  const [live, stashed] = await Promise.all([
    directoryNames(skillRoot),
    directoryNames(join(skillRoot, DISABLED_DIR)),
  ])
  const all = await Promise.all([
    ...live.map(name => readManagedEntry(skillRoot, name, true)),
    ...stashed.map(name => readManagedEntry(skillRoot, name, false)),
  ])
  return all.filter((entry): entry is ManagedEntry => entry !== undefined)
}

function isSafeName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(name) && !name.startsWith('.')
}

export interface ManagedOutcome {
  readonly ok: boolean
  readonly message?: string
  readonly code?: string
}

/**
 * Show or hide a skill without deleting it.
 *
 * A stash and a live directory cannot both hold the same name, so a stale copy
 * on the destination side is replaced only after the move source is confirmed.
 */
export async function setManagedEnabled(
  skillRoot: string,
  name: string,
  enabled: boolean,
): Promise<ManagedOutcome> {
  if (!isSafeName(name)) return { ok: false, code: 'bad-name', message: '非法的技能名' }

  const live = join(skillRoot, name)
  const stash = join(skillRoot, DISABLED_DIR, name)
  const from = enabled ? stash : live
  const to = enabled ? live : stash

  try {
    await stat(join(from, SKILL_FILE))
  } catch {
    return {
      ok: false,
      code: 'not-installed',
      message: enabled ? `${name} 当前未停用` : `${name} 未安装或缺少 SKILL.md`,
    }
  }

  try {
    await mkdir(join(skillRoot, DISABLED_DIR), { recursive: true })
    await rm(to, { recursive: true, force: true })
    await rename(from, to)
    return { ok: true }
  } catch (cause) {
    return { ok: false, code: 'move-failed', message: (cause as Error).message }
  }
}

/**
 * Delete an installed skill, keeping a copy under `.trash/` so it stays
 * recoverable from disk without another UI surface.
 */
export async function removeManaged(skillRoot: string, name: string): Promise<ManagedOutcome> {
  if (!isSafeName(name)) return { ok: false, code: 'bad-name', message: '非法的技能名' }

  const live = join(skillRoot, name)
  const stash = join(skillRoot, DISABLED_DIR, name)
  const source = await stat(join(live, SKILL_FILE)).then(
    () => live,
    () => stash,
  ).catch(() => undefined)

  if (source === undefined) return { ok: false, code: 'not-installed', message: `${name} 未安装` }

  try {
    const trash = join(skillRoot, TRASH_DIR)
    await mkdir(trash, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/gu, '-')
    await cp(source, join(trash, `${name}-${stamp}`), { recursive: true, dereference: false })
    await rm(source, { recursive: true, force: true })
    return { ok: true }
  } catch (cause) {
    return { ok: false, code: 'remove-failed', message: (cause as Error).message }
  }
}

// ------------------------------------------------------------------ archive

export interface TrashedEntry {
  readonly name: string
  readonly original: string
  readonly trashedAt: string
}

/** Entries waiting in `.trash/`, newest first. Visible so nothing is lost silently. */
export async function listTrash(skillRoot: string): Promise<readonly TrashedEntry[]> {
  const names = await directoryNames(join(skillRoot, TRASH_DIR))
  return names
    .map(name => {
      const split = name.lastIndexOf('-')
      return { name, original: split > 0 ? name.slice(0, split) : name, trashedAt: name.slice(split + 1) }
    })
    .reverse()
}

/** Marker written by a manual install so the entry survives in the listing. */
export async function writeManualMarker(
  directory: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await writeFile(join(directory, WB_MARKER), `${JSON.stringify(payload, null, 2)}\n`, 'utf8').catch(
    () => undefined,
  )
}

/** Resolve a possibly-symlinked skill directory to its real path. */
export async function realPath(path: string): Promise<string> {
  try {
    return await readlink(path)
  } catch {
    return path
  }
}
