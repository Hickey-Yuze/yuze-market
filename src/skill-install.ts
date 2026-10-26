/**
 * Skill installation.
 *
 * A marketplace skill is a zip that contains one or more skill directories.
 * Each skill directory holds a `SKILL.md` whose YAML frontmatter carries the
 * skill name, description and invocation flags. The DSH skill provider
 * (`@deepseek-ai/dsh-skill-filesystem`) watches the user skill root, so a
 * skill becomes usable the moment it lands on disk.
 *
 * Installation steps:
 *   1. download the zip into a private staging directory
 *   2. extract it with the traversal/symlink guards from `archive.ts`
 *   3. collect the skill directories (`SKILL.md` present)
 *   4. audit every skill body for obviously dangerous shell patterns
 *   5. copy into the DSH user skill root
 *
 * Nothing is written into the skill root before the audit passes.
 */

import type { Dirent } from 'node:fs'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { ArchiveError, downloadArchive, extractZip } from './archive.js'
import type { InstallResult, InstalledSkill, MarketSkill } from './shared/types.js'

export const SKILL_FILE = 'SKILL.md'
const META_FILE = '_meta.json'

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/u
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u
const SKILL_NAME_MAX = 200

/** Risk rules applied to a skill body before installation. */
const AUDIT_RULES: readonly {
  readonly pattern: RegExp
  readonly level: 'high' | 'medium'
  readonly code: string
  readonly message: string
}[] = [
  {
    pattern: /curl\s+[^\n|]+\|\s*(?:bash|sh)/iu,
    level: 'high',
    code: 'remote-shell',
    message: '检测到从网络下载并直接执行脚本',
  },
  {
    pattern: /rm\s+-rf\s+\//iu,
    level: 'high',
    code: 'destructive-delete',
    message: '检测到可能破坏系统的删除命令',
  },
  {
    pattern: /(?:api[_ -]?key|password|secret)\s*[:=]/iu,
    level: 'medium',
    code: 'secret-access',
    message: '检测到敏感凭据访问提示',
  },
]

export interface AuditFinding {
  readonly code: string
  readonly level: 'high' | 'medium'
  readonly message: string
}

export interface SkillAudit {
  readonly level: 'low' | 'medium' | 'high'
  readonly score: number
  readonly findings: readonly AuditFinding[]
}

/** Audit a skill body. The rules are intentionally narrow: they flag obvious
 *  hazards, they are not a sandbox. */
export function auditSkill(body: string): SkillAudit {
  const findings: AuditFinding[] = []
  for (const rule of AUDIT_RULES) {
    if (rule.pattern.test(body)) {
      findings.push({ code: rule.code, level: rule.level, message: rule.message })
    }
  }
  const score = findings.reduce((total, finding) => total + (finding.level === 'high' ? 50 : 20), 0)
  const level = findings.some(finding => finding.level === 'high') ? 'high' : findings.length > 0 ? 'medium' : 'low'
  return { level, score: Math.min(score, 100), findings }
}

function parseFrontmatter(body: string): Record<string, unknown> {
  const match = FRONTMATTER.exec(body)
  if (match === null) return {}
  const result: Record<string, unknown> = {}
  let currentKey: string | undefined
  for (const line of match[1]!.split(/\r?\n/u)) {
    if (line.trim().length === 0 || line.trimStart().startsWith('#')) continue
    const listItem = /^\s*-\s+(.*)$/u.exec(line)
    if (listItem !== null && currentKey !== undefined) {
      const existing = result[currentKey]
      if (Array.isArray(existing)) existing.push(String(listItem[1]).trim())
      continue
    }
    const pair = /^([A-Za-z0-9_-]+):\s*(.*)$/u.exec(line)
    if (pair === null) continue
    const key = pair[1]!
    const raw = pair[2]!.trim()
    currentKey = key
    if (raw.length === 0) {
      result[key] = []
      continue
    }
    if (raw.startsWith('[') && raw.endsWith(']')) {
      result[key] = raw.slice(1, -1).split(',').map(item => item.trim().replace(/^["']|["']$/gu, '')).filter(item => item.length > 0)
      continue
    }
    result[key] = raw.replace(/^["']|["']$/gu, '')
  }
  return result
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function readStringList(record: Record<string, unknown>, key: string): string[] {
  const value = record[key]
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string')
  if (typeof value === 'string' && value.length > 0) {
    return value.split(',').map(item => item.trim()).filter(item => item.length > 0)
  }
  return []
}

export interface SkillCandidate {
  readonly directory: string
  readonly name: string
  readonly description: string
  readonly body: string
  readonly audit: SkillAudit
}

/** Validate a skill id the same way the DSH skill provider does. */
export function isValidSkillId(value: string): boolean {
  if (value.length === 0 || value.length > SKILL_NAME_MAX) return false
  if (value === '.' || value === '..') return false
  if (/[/\\]/u.test(value)) return false
  if (/[\u0000-]/u.test(value)) return false
  return true
}

/** Collect the skill directories contained in an extracted archive. */
export async function collectSkillCandidates(extracted: string): Promise<SkillCandidate[]> {
  const candidates: SkillCandidate[] = []
  const rootSkill = join(extracted, SKILL_FILE)
  if (await isFile(rootSkill)) {
    const candidate = await readCandidate(extracted)
    if (candidate !== undefined) candidates.push(candidate)
    return candidates
  }
  const entries = await readdir(extracted, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const directory = join(extracted, entry.name)
    if (!await isFile(join(directory, SKILL_FILE))) continue
    const candidate = await readCandidate(directory)
    if (candidate !== undefined) candidates.push(candidate)
  }
  if (candidates.length === 0) {
    const loose = await readdir(extracted, { withFileTypes: true })
    for (const entry of loose) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue
      const candidate = await readCandidate(extracted, entry.name)
      if (candidate !== undefined) candidates.push(candidate)
    }
  }
  return candidates
}

async function readCandidate(directory: string, fileName = SKILL_FILE): Promise<SkillCandidate | undefined> {
  const body = await readFile(join(directory, fileName), 'utf8')
  const frontmatter = parseFrontmatter(body)
  const rawName = readString(frontmatter, 'name') ?? (fileName === SKILL_FILE ? basename(directory) : basename(fileName, '.md'))
  const name = rawName.toLowerCase()
  if (!SKILL_NAME.test(name) || !isValidSkillId(name)) return undefined
  const description = readString(frontmatter, 'description') ?? ''
  return { directory, name, description, body, audit: auditSkill(body) }
}

async function isFile(target: string): Promise<boolean> {
  try {
    const info = await stat(target)
    return info.isFile()
  } catch {
    return false
  }
}

export interface SkillInstallOptions {
  /** Root of the DSH user skill directory, e.g. `~/.dsh/skills`. */
  readonly skillRoot: string
  /** The marketplace entry being installed. */
  readonly entry: MarketSkill
}

export interface SkillInstallOutcome {
  readonly result: InstallResult
  readonly warnings: readonly string[]
}

/** Install one marketplace skill into the DSH user skill root. */
export async function installSkill(options: SkillInstallOptions): Promise<SkillInstallOutcome> {
  const { entry, skillRoot } = options
  const warnings: string[] = []
  const download = await downloadArchive(entry.url)
  const staging = await mkdtemp(join(tmpdir(), 'qurwork-skill-'))
  try {
    await extractZip(download.path, staging)
    const candidates = await collectSkillCandidates(staging)
    if (candidates.length === 0) {
      throw new ArchiveError('no-skill-found', '压缩包内没有找到 SKILL.md')
    }
    const target = candidates.find(candidate => candidate.name === entry.name) ?? candidates[0]!
    if (target.audit.level !== 'low') {
      const detail = target.audit.findings.map(finding => finding.message).join('；')
      return {
        result: {
          ok: false,
          target: entry.name,
          kind: 'skill',
          code: 'audit-blocked',
          message: `技能未通过安全检查：${detail}`,
        },
        warnings,
      }
    }
    if (!target.name.startsWith(entry.name) && entry.name.length > 0) {
      warnings.push(`技能包内目录名（${target.name}）与市场名称（${entry.name}）不一致`)
    }
    await mkdir(skillRoot, { recursive: true, mode: 0o700 })
    const destination = join(skillRoot, target.name)
    await rm(destination, { recursive: true, force: true })
    await cp(target.directory, destination, {
      recursive: true,
      dereference: false,
      filter: source => !basename(source).startsWith('.'),
    })
    await writeFile(
      join(destination, META_FILE),
      JSON.stringify({
        marketplaceId: entry.id,
        slug: entry.name,
        nameCn: entry.nameCn,
        tags: entry.tags,
        categories: entry.categories,
        author: entry.author,
        sourceUrl: entry.url,
        version: entry.version,
        installedAt: new Date().toISOString(),
      }, null, 2),
      { mode: 0o600 },
    )
    return {
      result: { ok: true, target: target.name, kind: 'skill', warnings: [...warnings] },
      warnings,
    }
  } finally {
    await rm(staging, { recursive: true, force: true })
    await download.cleanup()
  }
}

/** List the skills currently installed in the DSH user skill root. */
export async function listInstalledSkills(skillRoot: string): Promise<InstalledSkill[]> {
  let entries: Dirent[]
  try {
    entries = await readdir(skillRoot, { withFileTypes: true })
  } catch {
    return []
  }
  const result: InstalledSkill[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const directory = join(skillRoot, entry.name)
    const skillFile = join(directory, SKILL_FILE)
    if (!await isFile(skillFile)) continue
    const body = await readFile(skillFile, 'utf8').catch(() => '')
    const frontmatter = parseFrontmatter(body)
    let marketplaceId: number | undefined
    let version: string | undefined
    try {
      const meta = JSON.parse(await readFile(join(directory, META_FILE), 'utf8')) as Record<string, unknown>
      if (typeof meta.marketplaceId === 'number') marketplaceId = meta.marketplaceId
      if (typeof meta.version === 'string') version = meta.version
    } catch {
      // metadata is optional for manually installed skills
    }
    result.push({
      name: entry.name,
      description: readString(frontmatter, 'description') ?? '',
      path: directory,
      ...(marketplaceId === undefined ? {} : { marketplaceId }),
      ...(version === undefined ? {} : { version }),
    })
  }
  return result
}
