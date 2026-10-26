/**
 * Snapshot every skill that ships inside WorkBuddy's plugin marketplaces.
 *
 * WorkBuddy distributes three marketplaces on disk (all auto-updated by the
 * app), and skills are not one list — they are scattered inside plugin and
 * connector packages:
 *
 *   <market>/.codebuddy-plugin/marketplace.json   the package index
 *   <package>/skills/<name>/SKILL.md              multi-skill packages
 *   <package>/SKILL.md                            single-skill packages
 *
 * Reading those directories needs no CDP and no session: the app already
 * downloaded them. The snapshot keeps the absolute directory, so installing one
 * is a local copy instead of a download.
 *
 * Usage: node scripts/sync-workbuddy-skills.mjs
 */
import { readdir, readFile, stat, writeFile, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const WORKBUDDY = process.env.WORKBUDDY_HOME ?? join(homedir(), '.workbuddy')
const MARKETS = join(WORKBUDDY, 'plugins', 'marketplaces')
const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const OUT = join(DSH_HOME, 'workbuddy-market', 'cache', 'skills-market.json')

const log = message => console.log(`[sync-skills] ${message}`)

async function exists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** First `key: value` of a SKILL.md frontmatter block. */
function frontmatter(text, key) {
  const block = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(text)?.[1]
  if (block === undefined) return ''
  for (const line of block.split(/\r?\n/u)) {
    const separator = line.indexOf(':')
    if (separator <= 0) continue
    if (line.slice(0, separator).trim() !== key) continue
    return line
      .slice(separator + 1)
      .trim()
      .replace(/^["']|["']$/gu, '')
  }
  return ''
}

/** Prefer the package's own brand icon, if it ships one. */
async function iconOf(packageDir) {
  for (const relative of ['ai.workbuddy/assets/icon.png', 'ai.workbuddy/assets/icon.svg', '.codebuddy-plugin/icon.png', '.codebuddy-plugin/icon.svg']) {
    const candidate = join(packageDir, relative)
    if (await exists(candidate)) return candidate
  }
  return undefined
}

const entries = []
const perMarket = {}
let skipped = 0

let markets = []
try {
  markets = (await readdir(MARKETS, { withFileTypes: true })).filter(entry => entry.isDirectory())
} catch {
  throw new Error(`找不到 WorkBuddy 市场目录：${MARKETS}（WorkBuddy 是否安装并至少打开过一次？）`)
}

for (const market of markets) {
  const base = join(MARKETS, market.name)
  let manifest
  try {
    manifest = JSON.parse(await readFile(join(base, '.codebuddy-plugin/marketplace.json'), 'utf8'))
  } catch {
    skipped += 1
    continue
  }

  let count = 0
  for (const plugin of manifest.plugins ?? []) {
    const packageDir = join(base, String(plugin.source ?? '').replace(/^\.\//u, ''))
    const icon = await iconOf(packageDir)
    const skillsDir = join(packageDir, 'skills')
    const subdirs = await readdir(skillsDir, { withFileTypes: true }).catch(() => [])

    let added = 0
    for (const entry of subdirs.filter(item => item.isDirectory())) {
      const dir = join(skillsDir, entry.name)
      const file = join(dir, 'SKILL.md')
      if (!(await exists(file))) continue
      const text = await readFile(file, 'utf8').catch(() => '')
      entries.push({
        name: entry.name,
        title: frontmatter(text, 'name') || entry.name,
        description: frontmatter(text, 'description') || plugin.description || '',
        version: typeof plugin.version === 'string' ? plugin.version : '',
        market: market.name,
        plugin: plugin.name,
        dir,
        ...(icon === undefined ? {} : { icon }),
      })
      added += 1
    }

    // Packages that are a single skill put SKILL.md at their root.
    if (added === 0 && (await exists(join(packageDir, 'SKILL.md')))) {
      const text = await readFile(join(packageDir, 'SKILL.md'), 'utf8').catch(() => '')
      entries.push({
        name: plugin.name,
        title: frontmatter(text, 'name') || plugin.name,
        description: frontmatter(text, 'description') || plugin.description || '',
        version: typeof plugin.version === 'string' ? plugin.version : '',
        market: market.name,
        plugin: plugin.name,
        dir: packageDir,
        ...(icon === undefined ? {} : { icon }),
      })
      added += 1
    }

    count += added
  }
  if (count > 0) perMarket[market.name] = count
}

// The same skill name can appear in several markets; keep the first (teams >
// official > connector order is not meaningful, so the largest description wins).
const best = new Map()
for (const entry of entries) {
  const current = best.get(entry.name)
  if (current === undefined || entry.description.length > current.description.length) best.set(entry.name, entry)
}

const items = [...best.values()].sort((left, right) => left.name.localeCompare(right.name))
if (items.length === 0) throw new Error('没有扫到任何技能，市场目录可能是空的')

const payload = {
  builtAt: new Date().toISOString(),
  source: 'workbuddy-local-marketplaces',
  markets: perMarket,
  total: items.length,
  items,
}

await mkdir(join(DSH_HOME, 'workbuddy-market', 'cache'), { recursive: true })
await writeFile(OUT, `${JSON.stringify(payload)}\n`, 'utf8')
log(`市场分布：${JSON.stringify(perMarket)}${skipped > 0 ? `，跳过 ${skipped} 个无清单目录` : ''}`)
log(`写入 ${OUT}：${items.length} 个技能（原始 ${entries.length} 条，去重后 ${items.length}）`)
