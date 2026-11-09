/**
 * Skill names have one hard rule from the host.
 *
 * `@deepseek-ai/dsh-skill` validates the SKILL.md frontmatter `name` with
 * `/^[a-z0-9]+(?:-[a-z0-9]+)*$/` and silently drops any skill file that fails
 * it. A marketplace row written with a Chinese title — `PPT内容生成`,
 * `Hike Planner`, or no `name:` line at all — therefore installs fine and then
 * never appears in the catalogue, which looks like "installed but cannot call".
 *
 * So a marketplace title is display text, never an identifier: the installers
 * rewrite `name:` to the kebab-case directory name and keep the vendor's own
 * title in `title:` for the panel.
 */

import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const SKILL_FILE = 'SKILL.md'
export const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u

export function isSkillName(name: string): boolean {
  return SKILL_NAME.test(name)
}

/** Kebab-case fallback for a title that cannot be an identifier. */
export function toSkillName(value: string, fallback = 'skill'): string {
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 80)
  return cleaned.length > 0 ? cleaned : fallback
}

function split(raw: string): { head: string[]; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/u.exec(raw)
  if (match === null) return { head: [], body: raw }
  return { head: (match[1] ?? '').split(/\r?\n/u), body: raw.slice(match[0].length) }
}

function unquote(value: string): string {
  const trimmed = value.trim()
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

function read(head: readonly string[], key: string): string | undefined {
  for (const line of head) {
    const separator = line.indexOf(':')
    if (separator <= 0) continue
    if (line.slice(0, separator).trim() !== key) continue
    return unquote(line.slice(separator + 1))
  }
  return undefined
}

function set(head: readonly string[], key: string, value: string): string[] {
  const next: string[] = []
  let replaced = false
  for (const line of head) {
    const separator = line.indexOf(':')
    if (separator > 0 && line.slice(0, separator).trim() === key) {
      if (!replaced) next.push(`${key}: ${value}`)
      replaced = true
      continue
    }
    next.push(line)
  }
  if (!replaced) next.unshift(`${key}: ${value}`)
  return next
}

export interface NormalizedSkill {
  /** The callable name now written into SKILL.md. */
  readonly name: string
  /** True when the file was rewritten. */
  readonly changed: boolean
  /** Human title found in the frontmatter before the rewrite, if any. */
  readonly title?: string
}

/**
 * Make `<directory>/SKILL.md` callable.
 *
 * Returns the name the host will register. An already-legal name is left byte
 * for byte alone; anything else is rewritten to `fallback` (the directory
 * name), with the old value preserved as `title:` so the panel keeps Chinese.
 */
export async function normalizeSkillName(directory: string, fallback: string): Promise<NormalizedSkill> {
  const file = join(directory, SKILL_FILE)
  let raw: string
  try {
    raw = await readFile(file, 'utf8')
  } catch {
    return { name: toSkillName(fallback), changed: false }
  }

  const { head, body } = split(raw)
  const current = read(head, 'name')
  const wanted = toSkillName(fallback, 'skill')
  const title = read(head, 'title') ?? (current !== undefined && !isSkillName(current) ? current : undefined)

  if (current !== undefined && isSkillName(current)) {
    return { name: current, changed: false, ...(title === undefined ? {} : { title }) }
  }

  let next = set(head, 'name', wanted.endsWith('-') ? wanted.slice(0, -1) : wanted)
  // A Chinese/space title is the only useful display text the bundle carries.
  if (title !== undefined && read(next, 'title') === undefined) {
    next = set(next, 'title', /[:#"'\\{}[\],&*?|>%@`]/u.test(title) ? JSON.stringify(title) : title)
  }
  await writeFile(file, `---\n${next.join('\n')}\n---\n${body}`, 'utf8')
  return { name: wanted, changed: true, ...(title === undefined ? {} : { title }) }
}
