/**
 * Install one cloud expert fetched from WorkBuddy's expert marketplace.
 *
 * A marketplace entry is a zip shaped like a CodeBuddy plugin:
 *
 *   .codebuddy-plugin/plugin.json   metadata (agents[], profession, avatar…)
 *   agents/<name>.md                the expert prompt, already frontmattered
 *   skills/…                        optional bundled skills
 *
 * DSH's only extensibility point here is a skill, so the expert is written the
 * same way the bundled ones are: `<skillRoot>/<agentName>/SKILL.md`, with the
 * frontmatter normalised to a legal kebab-case name and a non-empty description.
 * Bundled `skills/` are not silently expanded into separate skills — that would
 * install dozens of unrelated entries from one click.
 *
 * The zip URL is a signed, expiring CDN link captured by the sync script, so an
 * expired snapshot fails with a clear "re-sync" message instead of a 403.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { extractZip } from './archive.js'
import { writeManualMarker } from './managed.js'
import type { InstallResult } from './shared/types.js'

export interface MarketExpertSource {
  readonly expertId: string
  readonly agentName: string
  readonly title: string
  readonly description: string
  readonly profession: string
  readonly version?: string
  readonly downloadUrl: string
  readonly expiresAt?: number | null
}

const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u

/** DSH needs kebab-case; upstream agent names are usually already close. */
function slug(value: string): string {
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 80)
  return cleaned.length > 0 ? cleaned : 'expert'
}

/** Pull the body out of a `---` frontmatter block, if any. */
function splitFrontmatter(raw: string): { head: Record<string, string>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/u.exec(raw)
  if (match === null) return { head: {}, body: raw }
  const head: Record<string, string> = {}
  for (const line of (match[1] ?? '').split(/\r?\n/u)) {
    const separator = line.indexOf(':')
    if (separator <= 0) continue
    const key = line.slice(0, separator).trim()
    let value = line.slice(separator + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (key.length > 0) head[key] = value
  }
  return { head, body: raw.slice(match[0].length) }
}

function quote(value: string): string {
  if (!/[:#"'\\{}[\],&*?|>%@`]/u.test(value) && value === value.trim()) return value
  return `"${value.replace(/\\/gu, '\\\\').replace(/"/gu, '\\"')}"`
}

interface PluginMeta {
  readonly agents?: readonly string[]
  readonly agentName?: string
  readonly profession?: { readonly zh?: string; readonly en?: string }
  readonly displayDescription?: { readonly zh?: string; readonly en?: string }
}

function pickAgentFile(files: readonly string[], meta: PluginMeta | undefined): string | undefined {
  const declared = meta?.agents?.[0]?.replace(/^\.\//u, '')
  if (declared !== undefined && files.includes(declared)) return declared
  return files.find(path => /^agents\/[^/]+\.md$/u.test(path))
}

export interface MarketExpertInstallResult {
  readonly result: InstallResult
  readonly warnings: readonly string[]
}

export async function installMarketExpert(
  source: MarketExpertSource,
  skillRoot: string,
): Promise<MarketExpertInstallResult> {
  const warnings: string[] = []

  if (typeof source.expiresAt === 'number' && source.expiresAt > 0 && source.expiresAt < Date.now()) {
    return {
      result: {
        ok: false,
        target: source.expertId,
        kind: 'skill',
        code: 'download-expired',
        message: '该专家的下载地址已过期（签名约 24 小时有效），请重新同步专家市场后再安装',
      },
      warnings,
    }
  }

  let archive: Buffer
  try {
    const response = await fetch(source.downloadUrl, { signal: AbortSignal.timeout(60_000) })
    if (!response.ok) {
      return {
        result: {
          ok: false,
          target: source.expertId,
          kind: 'skill',
          code: `http-${response.status}`,
          message:
            response.status === 403
              ? '下载地址已失效（403），请重新同步专家市场后再安装'
              : `下载专家包失败：HTTP ${response.status}`,
        },
        warnings,
      }
    }
    archive = Buffer.from(await response.arrayBuffer())
  } catch (cause) {
    return {
      result: {
        ok: false,
        target: source.expertId,
        kind: 'skill',
        code: 'download-failed',
        message: `下载专家包失败：${(cause as Error).message}`,
      },
      warnings,
    }
  }

  const staging = await mkdtemp(join(tmpdir(), 'yuze-expert-'))
  const zipPath = join(staging, 'expert.zip')
  const unpacked = join(staging, 'unpacked')
  try {
    await writeFile(zipPath, archive)
    await extractZip(zipPath, unpacked)

    let meta: PluginMeta | undefined
    try {
      meta = JSON.parse(await readFile(join(unpacked, '.codebuddy-plugin', 'plugin.json'), 'utf8')) as PluginMeta
    } catch {
      // A package without plugin.json is still installable if it ships agents/*.md.
    }

    const listing = await listFiles(unpacked)
    const agentFile = pickAgentFile(listing, meta)
    if (agentFile === undefined) {
      return {
        result: {
          ok: false,
          target: source.expertId,
          kind: 'skill',
          code: 'no-agent-file',
          message: '专家包里没有 agents/*.md，无法转换为技能',
        },
        warnings,
      }
    }

    const { head, body } = splitFrontmatter(await readFile(join(unpacked, agentFile), 'utf8'))
    const name = slug(meta?.agentName ?? source.agentName ?? head.name ?? source.expertId)
    // The catalogue's Chinese blurb reads better to the model than the package's
    // English one-liner, which stays as the fallback for hand-made zips.
    const description =
      (source.description.length > 0 ? source.description : undefined) ??
      meta?.displayDescription?.zh ??
      head.description ??
      source.profession ??
      source.title

    const frontmatter = [
      '---',
      `name: ${name}`,
      `description: ${quote(description.length > 0 ? description : source.title)}`,
      ...(source.version === undefined ? [] : [`version: ${quote(source.version)}`]),
      '---',
      '',
    ].join('\n')

    const target = join(skillRoot, name)
    await mkdir(skillRoot, { recursive: true, mode: 0o700 })
    await rm(target, { recursive: true, force: true })
    await mkdir(target, { recursive: true })
    await writeFile(join(target, 'SKILL.md'), `${frontmatter}${body.trim()}\n`, 'utf8')

    const bundledSkills = listing.filter(path => /^skills\/[^/]+\/SKILL\.md$/u.test(path)).length
    if (bundledSkills > 0) {
      warnings.push(`该专家包还带有 ${bundledSkills} 个技能，未一并安装（专家本体已装为技能）`)
    }

    await writeManualMarker(target, {
      source: 'yuzhe-market-cloud',
      kind: 'expert',
      id: source.expertId,
      title: source.profession.length > 0 ? source.profession : source.title,
      installedAt: new Date().toISOString(),
    })

    return { result: { ok: true, target: name, kind: 'skill', warnings }, warnings }
  } catch (cause) {
    return {
      result: {
        ok: false,
        target: source.expertId,
        kind: 'skill',
        code: 'install-failed',
        message: `安装专家失败：${(cause as Error).message}`,
      },
      warnings,
    }
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}

async function listFiles(root: string, prefix = ''): Promise<string[]> {
  const { readdir } = await import('node:fs/promises')
  const entries = await readdir(join(root, prefix), { withFileTypes: true })
  const out: string[] = []
  for (const entry of entries) {
    const relative = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) out.push(...(await listFiles(root, relative)))
    else out.push(relative)
  }
  return out
}

/** Whether a name is a legal DSH skill id, for callers that want to pre-validate. */
export function isLegalSkillName(name: string): boolean {
  return SKILL_NAME.test(name)
}
