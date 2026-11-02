/**
 * Build `catalog.json` from the WorkBuddy marketplaces already on disk.
 *
 * The panel reads exactly one file for the local half of the catalogue
 * (`~/.dsh/workbuddy-market/cache/catalog.json`). Its absence is fatal for all
 * four tabs — the aggregator reads the local rows for skills and experts too —
 * so a fresh machine has to run this once after installing the plugin.
 *
 * What it scans (no network, no login, no CDP):
 *
 *   <market>/.codebuddy-plugin/marketplace.json   the package index
 *   <package>/mcp.json                            MCP endpoint (connectors)
 *   <package>/{skills,agents,commands}            bundled payload, counted only
 *   <package>/ai.workbuddy/{,assets/}icon.*       brand artwork
 *
 * Two things are written:
 *
 * 1. `catalog.json` — connector rows plus the metrics the cards show.
 * 2. `cache/mcp-connectors/extracted/connectors/<name>` — a directory junction
 *    per connector, which is where the `/art` route looks for the icon. A
 *    junction instead of a copy: the connector bundle is 100 MB on a stock
 *    install and WorkBuddy keeps it up to date in place.
 *
 * Skills are deliberately left out of the catalogue: they are covered by the
 * `skills-market.json` snapshot (bundled in the package, or produced by
 * `scripts/sync-workbuddy-skills.mjs`), and listing them twice would double
 * every card. Experts come from the cloud snapshot (`experts-market.json`), not
 * from here.
 *
 * Usage: node scripts/build-catalog.mjs
 */
import { mkdir, readFile, readdir, stat, symlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const WORKBUDDY = process.env.WORKBUDDY_HOME ?? join(homedir(), '.workbuddy')
const MARKETS = join(WORKBUDDY, 'plugins', 'marketplaces')
const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const CACHE = join(DSH_HOME, 'workbuddy-market', 'cache')
const OUT = join(CACHE, 'catalog.json')
const EXTRACTED = join(CACHE, 'mcp-connectors', 'extracted', 'connectors')

const log = message => console.log(`[build-catalog] ${message}`)

async function exists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return undefined
  }
}

async function dirs(path) {
  try {
    const entries = await readdir(path, { withFileTypes: true })
    return entries.filter(entry => entry.isDirectory()).map(entry => entry.name)
  } catch {
    return []
  }
}

async function files(path, extension) {
  try {
    const entries = await readdir(path, { withFileTypes: true })
    return entries
      .filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith(extension))
      .map(entry => entry.name)
  } catch {
    return []
  }
}

/** Same grammar the Host enforces for skill and MCP ids. */
function sanitizeName(raw) {
  return String(raw)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '')
}

const ICON_CANDIDATES = [
  'ai.workbuddy/assets/icon.png',
  'ai.workbuddy/assets/icon.svg',
  'ai.workbuddy/icon.png',
  'ai.workbuddy/icon.svg',
  '.codebuddy-plugin/icon.png',
  '.codebuddy-plugin/icon.svg',
]

async function iconOf(packageDir) {
  for (const relative of ICON_CANDIDATES) {
    if (await exists(join(packageDir, relative))) {
      return { file: relative, format: relative.endsWith('.svg') ? 'svg' : 'png' }
    }
  }
  return undefined
}

/** First declared MCP server, normalized to what `dsh-mcp-client` understands. */
function parseMcp(raw) {
  const servers = raw?.mcpServers
  if (servers === null || typeof servers !== 'object') return undefined
  const first = Object.entries(servers)[0]
  if (first === undefined) return undefined
  const [serverName, config] = first
  if (config === null || typeof config !== 'object') return undefined

  const url = typeof config.url === 'string' ? config.url : undefined
  const command = typeof config.command === 'string' ? config.command : undefined
  const declared = typeof config.type === 'string' ? config.type : typeof config.transport === 'string' ? config.transport : ''
  // Old packages omit `type` entirely; the presence of `url`/`command` decides.
  const transport = declared !== '' ? declared : url !== undefined ? 'streamable-http' : command !== undefined ? 'stdio' : 'unknown'

  return {
    serverName,
    transport,
    ...(url === undefined ? {} : { url }),
    ...(config.headers === undefined ? {} : { headers: config.headers }),
    ...(command === undefined ? {} : { command }),
    ...(Array.isArray(config.args) ? { args: config.args } : {}),
    ...(config.env === undefined ? {} : { env: config.env }),
  }
}

const perMarket = {}
const taken = new Map()
const entries = []
let skipped = 0

const markets = await dirs(MARKETS)
if (markets.length === 0) {
  throw new Error(`找不到 WorkBuddy 市场目录：${MARKETS}（WorkBuddy 是否安装并至少打开过一次？）`)
}

for (const market of markets) {
  const base = join(MARKETS, market)
  const manifest = await readJson(join(base, '.codebuddy-plugin/marketplace.json'))
  if (manifest === undefined) {
    skipped += 1
    continue
  }

  let count = 0
  for (const plugin of manifest.plugins ?? []) {
    const dirName = resolve(base, String(plugin.source ?? '').replace(/^\.\//u, ''))
    if (!(await exists(dirName))) continue

    const mcpRaw = await readJson(join(dirName, 'mcp.json'))
    const mcp = parseMcp(mcpRaw)
    // Every package inside a `connectors/` folder is a connector row even when
    // it declares no endpoint: the panel groups those under 无 MCP 端点 rather
    // than hiding them.
    const inConnectorsDir = dirName.split(/[\\/]/u).includes('connectors')
    if (mcp === undefined && !inConnectorsDir) continue

    const meta = await readJson(join(dirName, '.codebuddy-plugin/plugin.json'))
    const display = meta?.extensions?.['ai.workbuddy']?.display ?? {}
    const baseName = sanitizeName(meta?.name ?? plugin.name ?? dirName.split(/[\\/]/u).pop())

    // Two markets can ship the same directory name; the junction path has to
    // stay unique because `/art` resolves icons from it.
    let unique = baseName
    const owner = taken.get(unique)
    if (owner !== undefined && owner !== dirName) {
      unique = sanitizeName(`${baseName}-${market}`)
      if (taken.has(unique)) continue
    }
    taken.set(unique, dirName)

    const skillsDir = join(dirName, 'skills')
    const skillDirs = await dirs(skillsDir)
    const rootSkill = skillDirs.length === 0 && (await exists(join(dirName, 'SKILL.md')))
    const commands = await files(join(dirName, 'commands'), '.md')
    const agents = await files(join(dirName, 'agents'), '.md')
    const icon = await iconOf(dirName)

    entries.push({
      id: unique,
      name: unique,
      dirName: unique,
      title: display.name_zh ?? display.name ?? plugin.name ?? unique,
      titleEn: display.name_en,
      description: display.description_zh ?? plugin.description ?? meta?.description ?? '',
      descriptionEn: display.description_en,
      version: meta?.version ?? plugin.version,
      // `market` is deliberately not written: the catalogue's normalizer turns it
      // into the card's category chip, and a raw marketplace repo name ("workbuddy-
      // connector-plugins-official") is not something to show in the rail. The
      // panel groups connectors by MCP transport, which it derives from `mcp`.
      root: dirName,
      tags: Array.isArray(meta?.keywords) ? meta.keywords : [],
      skillCount: skillDirs.length + (rootSkill ? 1 : 0),
      commandCount: commands.length,
      agentCount: agents.length,
      hasSkills: skillDirs.length > 0 || rootSkill,
      rootSkill,
      ...(mcp === undefined ? {} : { mcp }),
      ...(icon === undefined ? {} : { icon }),
    })
    count += 1
  }

  if (count > 0) perMarket[market] = count
  else skipped += 1
}

if (entries.length === 0) {
  throw new Error(`没有扫到任何连接器，市场目录可能是空的：${MARKETS}`)
}

entries.sort((left, right) => left.name.localeCompare(right.name))

const totals = {
  experts: 0,
  skills: 0,
  connectors: entries.length,
}

const payload = {
  builtAt: new Date().toISOString(),
  source: 'workbuddy-local-marketplaces',
  totals,
  experts: { items: [] },
  skills: { items: [] },
  connectors: { items: entries },
}

await mkdir(CACHE, { recursive: true })
await writeFile(OUT, `${JSON.stringify(payload)}\n`, 'utf8')

// `/art` and the connector bundle reader look under this fixed path, so link
// every package there. Failures are non-fatal: without a link the card falls
// back to its placeholder icon.
await mkdir(EXTRACTED, { recursive: true })
let linked = 0
for (const entry of entries) {
  const target = join(EXTRACTED, entry.dirName)
  if (await exists(target)) continue
  try {
    await symlink(entry.root, target, 'junction')
    linked += 1
  } catch {
    // A dangling or denied link only costs the icon.
  }
}

const byTransport = {}
for (const entry of entries) {
  const key = entry.mcp?.transport ?? 'unknown'
  byTransport[key] = (byTransport[key] ?? 0) + 1
}

log(`市场分布：${JSON.stringify(perMarket)}${skipped > 0 ? `，跳过 ${skipped} 个无清单目录` : ''}`)
log(`MCP 传输：${JSON.stringify(byTransport)}`)
log(`写入 ${OUT}：${entries.length} 个连接器（新建 ${linked} 条图标链接）`)
