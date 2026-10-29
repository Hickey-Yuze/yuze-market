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
import { dirname, join } from 'node:path'

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
        message: '这个下载链接刚刚过期，请重试一次（会自动换新的链接）',
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
              ? '下载链接已失效（403），请重试一次以换取新链接'
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
    // The marketplace row's agent name is what the user clicked, so it wins.
    // The zip's plugin.json `agentName` is the pack author's internal name and
    // can differ from the catalogue entry (e.g. "data-analysis-expert" ships a
    // "data-team-lead" package); letting it override would install a skill the
    // user never asked for and make the click look broken.
    const name = slug(source.agentName ?? meta?.agentName ?? head.name ?? source.expertId)
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

    // Bring along whatever the body points at, so links inside the prompt resolve.
    const copied = await copyReferences(body, unpacked, target, warnings)
    if (copied > 0) {
      warnings.push(`已一并复制 ${copied} 个引用文件`)
    }

    const bundledSkills = listing.filter(path => /^skills\/[^/]+\/SKILL\.md$/u.test(path)).length
    if (bundledSkills > 0 && copied === 0) {
      warnings.push(`该专家包还带有 ${bundledSkills} 个技能，正文未引用故未安装`)
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

/**
 * Package-relative paths an expert's body points at.
 *
 * Most experts are self-contained prose, but some reference bundled material
 * ("see `skills/browser-use/SKILL.md`", "![preview](assets/shot.png)"). Copying
 * only the body would leave those links dangling, so the referenced files travel
 * with it, at the same relative path.
 *
 * Deliberately narrow: only `skills/`, `references/`, `assets/`, `scripts/`,
 * `templates/`, `prompts/` are considered, so ordinary prose or code snippets in
 * the body are not mistaken for package paths.
 */
const REFERENCE_ROOT = /(?:^|[(\s`'"])((?:\.\/)?(?:skills|references|assets|scripts|templates|prompts|docs)\/[A-Za-z0-9_.\/-]+)/gu

function extractReferences(body: string): string[] {
  const found = new Set<string>()
  for (const match of body.matchAll(REFERENCE_ROOT)) {
    const candidate = match[1]
    if (candidate === undefined) continue
    // Reject traversal outright: a package must not be able to write outside
    // the skill directory it is installing into.
    if (candidate.includes('..')) continue
    found.add(candidate.replace(/^\.\//u, '').replace(/[.,;:)]+$/u, ''))
  }
  return [...found]
}

const MAX_SINGLE_FILE = 5 * 1024 * 1024
const MAX_TOTAL_COPY = 40 * 1024 * 1024
const MAX_REFERENCE_FILES = 400

/**
 * Copy every referenced file (or whole directory) next to the installed body.
 * Returns how many files were materialised.
 */
async function copyReferences(
  body: string,
  unpacked: string,
  target: string,
  warnings: string[],
): Promise<number> {
  const references = extractReferences(body)
  if (references.length === 0) return 0

  const available = new Set(await listFiles(unpacked))
  const directories = new Set<string>()
  for (const path of available) {
    const segments = path.split('/')
    for (let index = 1; index < segments.length; index++) directories.add(segments.slice(0, index).join('/'))
  }

  let copied = 0
  let bytes = 0
  const seen = new Set<string>()

  const copyOne = async (relative: string, from: string): Promise<void> => {
    if (seen.has(relative) || copied >= MAX_REFERENCE_FILES) return
    if (relative.startsWith('agents/') || relative === 'SKILL.md') return
    const buffer = await readFile(from)
    if (buffer.length > MAX_SINGLE_FILE) {
      warnings.push(`引用的 ${relative} 超过 5MB，未一并安装`)
      return
    }
    if (bytes + buffer.length > MAX_TOTAL_COPY) {
      warnings.push('引用的附件合计超过 40MB，剩余部分未一并安装')
      return
    }
    const destination = join(target, relative)
    await mkdir(dirname(destination), { recursive: true })
    await writeFile(destination, buffer)
    seen.add(relative)
    copied += 1
    bytes += buffer.length
  }

  for (const reference of references) {
    // A referenced SKILL.md implies its whole directory: the file almost always
    // links siblings (notes, references, fixtures) that only make sense together.
    if (reference.endsWith('/SKILL.md')) {
      const directory = reference.slice(0, -'/SKILL.md'.length)
      for (const path of available) {
        if (path.startsWith(`${directory}/`)) await copyOne(path, join(unpacked, path))
      }
      continue
    }
    if (available.has(reference)) {
      await copyOne(reference, join(unpacked, reference))
      continue
    }
    if (!directories.has(reference)) continue
    for (const path of available) {
      if (!path.startsWith(`${reference}/`)) continue
      await copyOne(path, join(unpacked, path))
    }
  }

  return copied
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
