/**
 * One catalogue view over what used to be two products.
 *
 * The panel shows 技能 / 专家 / 连接器 / 插件 as four tabs, not as
 * "QuWork vs WorkBuddy" halves. That means the Node half has to present a single
 * item shape no matter which upstream the row came from:
 *
 * - skills  QuWork's remote skill market + the local WorkBuddy skill bundle
 * - experts, connectors  the local bundle only
 * - plugins  QuWork's remote plugin market
 *
 * Item ids are prefixed with their origin so the same id can address artwork and
 * an install without the client passing a URL back to the Host.
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { packageSkillArt, type ArtResult } from './art.js'
import type { MarketApiClient } from './market-api.js'
import type { MarketPlugin, MarketSkill } from './shared/types.js'
import { transportLabel, type MarketCatalog } from './wb/catalog.js'
import type { CloudSkillClient, CloudSkillRow } from './wb/skillhub.js'
import type { MarketItem, MarketKind } from './wb/types.js'

export type Tab = 'skill' | 'expert' | 'connector' | 'plugin'

export interface UnifiedItem {
  /** Global address: `<origin>:<tab>:<upstream id>`. */
  readonly id: string
  readonly tab: Tab
  readonly origin: 'local' | 'remote'
  readonly name: string
  readonly title: string
  readonly description: string
  readonly version?: string
  readonly author?: string
  readonly tags: readonly string[]
  readonly category?: string
  readonly emoji?: string
  /** Host route serving the brand artwork for this row, when one exists. */
  readonly artUrl?: string
  readonly examples?: readonly string[]
  readonly quickPrompts?: readonly string[]
  readonly prompt?: string
  readonly installable: boolean
  readonly installNote?: string
  /** MCP transport for connectors, shown as a badge. */
  readonly transport?: string
  /** Extra haystack for search only (English copy, alias names); never rendered. */
  readonly search?: string
  /** Upstream usage counter (experts), rendered as 万/x 万. */
  readonly usage?: number
  /** Short label to show instead of the install state (e.g. 云端). */
  readonly badge?: string
}

export interface UnifiedCategory {
  readonly name: string
  readonly count: number
}

export type SortMode = 'reco' | 'usage' | 'name'

export interface UnifiedList {
  readonly items: readonly UnifiedItem[]
  readonly categories: readonly UnifiedCategory[]
  readonly total: number
  readonly page: number
  readonly pageSize: number
  readonly hasMore: boolean
  /** True while a remote half of the list is unavailable (offline, 5xx). */
  readonly degraded?: boolean
  /** True when the expert tab fell back to the bundled 429-row catalogue. */
  readonly expertSnapshotMissing?: boolean
}

export const ART_ROUTE = '/api/yuze-market/art'

export function artUrlFor(id: string): string {
  return `${ART_ROUTE}?id=${encodeURIComponent(id)}`
}

const REMOTE_TTL_MS = 5 * 60_000
const REMOTE_PAGE_SIZE = 200
const REMOTE_MAX_PAGES = 12
/** Cloud skill hits per search: enough to be useful, few enough to stay fast. */
const CLOUD_SKILL_LIMIT = 12
/** Chip that switches the skill tab over to the cloud market. */
export const CLOUD_CATEGORY = '云端技能'

interface RemoteCache<T> {
  at: number
  items: Map<string, T>
}

/**
 * Remote markets are paginated and have no "get by id" endpoint, so the first
 * list request warms a short-lived id → entry map that installs can reuse.
 */
class RemoteSkills {
  private cache: RemoteCache<MarketSkill> = { at: 0, items: new Map() }

  constructor(private readonly market: MarketApiClient) {}

  async all(force = false): Promise<readonly MarketSkill[]> {
    if (!force && Date.now() - this.cache.at < REMOTE_TTL_MS && this.cache.items.size > 0) {
      return [...this.cache.items.values()]
    }
    const items = new Map<string, MarketSkill>()
    let page = 1
    try {
      for (; page <= REMOTE_MAX_PAGES; page++) {
        const response = await this.market.listSkills({ page, pageSize: REMOTE_PAGE_SIZE })
        for (const item of response.items) items.set(String(item.id), item)
        if (!response.hasMore || response.items.length === 0) break
      }
    } catch {
      // A partially filled map still serves what it has; the UI marks the list
      // degraded rather than empty.
    }
    this.cache = { at: Date.now(), items }
    return [...items.values()]
  }

  async byId(id: string): Promise<MarketSkill | undefined> {
    const all = await this.all()
    const hit = all.find(item => String(item.id) === id)
    if (hit !== undefined) return hit
    return (await this.all(true)).find(item => String(item.id) === id)
  }
}

/**
 * WorkBuddy's online expert marketplace, snapshotted to disk by
 * `scripts/sync-workbuddy-experts.mjs`.
 *
 * The live endpoint needs a logged-in WorkBuddy session whose token lives in
 * that app's main process, so this plugin never calls it: a snapshot keeps the
 * whole catalogue browsable without a running WorkBuddy, and a stale snapshot
 * simply means slightly old data instead of an empty tab.
 */
export interface RawMarketExpert {
  readonly expert_id?: string
  readonly source_id?: string
  readonly agent_name?: string
  readonly plugin_id?: string
  readonly icon?: string
  readonly version?: string
  readonly display_name_zh?: string
  readonly display_name_en?: string
  readonly profession_zh?: string
  readonly profession_en?: string
  readonly description_zh?: string
  readonly description_en?: string
  readonly categories?: readonly string[]
  readonly categories_detail?: readonly { readonly name_zh?: string }[]
  readonly tags_zh?: readonly string[]
  readonly tags_en?: readonly string[]
  readonly quick_prompts?: readonly { readonly zh?: string }[]
  readonly default_init_prompt?: { readonly zh?: string }
  readonly use_count?: number
  readonly download_url?: string
  readonly download_expires_at?: number | null
}

class MarketExperts {
  private cache: { at: number; items: readonly UnifiedItem[] } = { at: 0, items: [] }
  private raw = new Map<string, RawMarketExpert>()

  constructor(private readonly file: string) {}

  async all(): Promise<readonly UnifiedItem[]> {
    if (this.cache.items.length > 0 && Date.now() - this.cache.at < REMOTE_TTL_MS) return this.cache.items
    let raw: { items?: readonly RawMarketExpert[] }
    try {
      raw = JSON.parse(await readFile(this.file, 'utf8')) as { items?: readonly RawMarketExpert[] }
    } catch {
      return this.cache.items
    }
    // One row per agent: the upstream list carries several editions of the same
    // expert, and the most-used one is the one a browser expects to see.
    const best = new Map<string, RawMarketExpert>()
    for (const entry of raw.items ?? []) {
      const key = (entry.agent_name ?? entry.source_id ?? entry.expert_id ?? '').toLowerCase()
      if (key.length === 0) continue
      const current = best.get(key)
      if (current === undefined || (entry.use_count ?? 0) > (current.use_count ?? 0)) best.set(key, entry)
    }
    this.raw = new Map([...best.values()].map(entry => [entry.expert_id ?? entry.source_id ?? '', entry] as const))
    this.cache = { at: Date.now(), items: [...best.values()].map(marketExpert) }
    return this.cache.items
  }

  /** The untouched upstream row, including its signed download URL. */
  async byId(expertId: string): Promise<RawMarketExpert | undefined> {
    await this.all()
    return this.raw.get(expertId)
  }
}

/**
 * Every cloud expert is installable.
 *
 * The signature is no longer carried in the snapshot (it expires in ~24h and has
 * to be re-minted anyway), so the installer asks the local WorkBuddy for one at
 * click time. A stale or missing `download_url` in the row therefore says nothing
 * about installability — the request itself reports what went wrong (no
 * WorkBuddy, needs a relaunch, upstream refuses).
 */
function downloadState(_raw: RawMarketExpert): Pick<UnifiedItem, 'installable' | 'badge'> {
  return { installable: true, badge: '云端' }
}

function marketExpert(raw: RawMarketExpert): UnifiedItem {
  const id = `market:expert:${raw.expert_id ?? raw.source_id ?? raw.agent_name ?? 'unknown'}`
  const category = raw.categories_detail?.[0]?.name_zh ?? ''
  const prompts = (raw.quick_prompts ?? []).map(item => item.zh).filter((text): text is string => typeof text === 'string' && text.length > 0)
  const search = [
    raw.display_name_zh,
    raw.display_name_en,
    raw.profession_en,
    raw.description_en,
    raw.agent_name,
    raw.source_id,
    ...(raw.tags_en ?? []),
  ]
    .filter((part): part is string => typeof part === 'string' && part.length > 0)
    .join(' ')
  return {
    id,
    tab: 'expert',
    origin: 'remote',
    name: raw.agent_name ?? raw.source_id ?? id,
    title: raw.profession_zh ?? raw.display_name_zh ?? raw.expert_id ?? '专家',
    description: raw.description_zh ?? '',
    ...(raw.version === undefined ? {} : { version: raw.version }),
    tags: raw.tags_zh ?? [],
    ...(category.length === 0 ? {} : { category }),
    ...(raw.icon === undefined ? {} : { artUrl: raw.icon }),
    ...(prompts.length === 0 ? {} : { quickPrompts: prompts }),
    ...(raw.default_init_prompt?.zh === undefined ? {} : { prompt: raw.default_init_prompt.zh }),
    ...(typeof raw.use_count === 'number' ? { usage: raw.use_count } : {}),
    // The zip sits behind a signed CDN URL captured at sync time, so an entry is
    // installable exactly while that signature is still valid.
    ...downloadState(raw),
    ...(search.length === 0 ? {} : { search }),
  }
}

/**
 * Skills that ship inside WorkBuddy's local plugin marketplaces.
 *
 * They live in `<package>/skills/<name>/SKILL.md` (or `<package>/SKILL.md` for
 * single-skill packages), already on disk, so installing one is a copy instead
 * of a download. `scripts/sync-workbuddy-skills.mjs` flattens them into a
 * snapshot because the marketplaces themselves are WorkBuddy's business.
 */
export interface RawLocalSkill {
  readonly name?: string
  readonly title?: string
  readonly description?: string
  readonly version?: string
  readonly market?: string
  readonly plugin?: string
  readonly dir?: string
  /** Absolute icon path inside the marketplace package, when it ships one. */
  readonly icon?: string
}

/** Chinese overrides produced by the translation pass, keyed by skill name. */
interface SkillTranslation {
  readonly title?: string
  readonly description?: string
}

class LocalSkills {
  private cache: { at: number; items: readonly UnifiedItem[] } = { at: 0, items: [] }
  private raw = new Map<string, RawLocalSkill>()
  private zh = new Map<string, SkillTranslation>()
  private zhMtime = 0

  constructor(
    private readonly file: string,
    private readonly zhFile?: string,
  ) {}

  /**
   * Re-read the Chinese dictionary when the file changes.
   *
   * It used to be read once per process (`if (this.zh.size === 0)`), so a
   * translation pass only showed up after a host restart — which is exactly the
   * kind of stale state that makes the UI look untranslated.
   */
  private async reloadTranslations(): Promise<void> {
    if (this.zhFile === undefined) return
    let mtime: number
    try {
      mtime = (await stat(this.zhFile)).mtimeMs
    } catch {
      return
    }
    if (mtime === this.zhMtime) return
    this.zhMtime = mtime
    try {
      const parsed = JSON.parse(await readFile(this.zhFile, 'utf8')) as { map?: Record<string, SkillTranslation> }
      this.zh.clear()
      for (const [name, value] of Object.entries(parsed.map ?? {})) {
        if (typeof value?.title === 'string' || typeof value?.description === 'string') this.zh.set(name, value)
      }
      // Titles and descriptions just changed, so the rendered items must too.
      this.cache = { at: 0, items: [] }
    } catch {
      // A half-written file keeps the previous dictionary instead of blanking it.
    }
  }

  async all(): Promise<readonly UnifiedItem[]> {
    await this.reloadTranslations()
    if (this.cache.items.length > 0 && Date.now() - this.cache.at < REMOTE_TTL_MS) return this.cache.items
    let raw: { items?: readonly RawLocalSkill[] }
    try {
      raw = JSON.parse(await readFile(this.file, 'utf8')) as { items?: readonly RawLocalSkill[] }
    } catch {
      return this.cache.items
    }
    const items: UnifiedItem[] = []
    for (const entry of raw.items ?? []) {
      if (typeof entry.name !== 'string' || entry.name.length === 0) continue
      this.raw.set(entry.name, entry)
      items.push(localSkill(entry, this.zh.get(entry.name)))
    }
    this.cache = { at: Date.now(), items }
    return items
  }

  async byName(name: string): Promise<RawLocalSkill | undefined> {
    await this.all()
    return this.raw.get(name)
  }
}

/** WorkBuddy's marketplace directories are English slugs; the chips must read Chinese. */
const MARKET_LABELS: Readonly<Record<string, string>> = {
  cb_teams_marketplace: '团队协作',
  'codebuddy-plugins-official': '官方插件',
  'workbuddy-connector-plugins-official': '连接器套件',
  'workbuddy-wecom-unified': '企业微信',
  experts: '专家配套',
  'tabbit-browser': '浏览器',
}

function marketLabel(market: string | undefined): string {
  if (market === undefined || market.length === 0) return '其他'
  const mapped = MARKET_LABELS[market]
  if (mapped !== undefined) return mapped
  // A `skill-marketplace-<uuid>` directory and any future market fall back to a
  // readable name instead of leaking the raw slug.
  return /^skill-marketplace/iu.test(market) ? '技能市场' : '其他'
}

function localSkill(raw: RawLocalSkill, zh?: SkillTranslation): UnifiedItem {
  const name = raw.name ?? ''
  const title = zh?.title ?? raw.title
  const description = zh?.description ?? raw.description ?? ''
  return {
    id: `skillfile:${name}`,
    tab: 'skill',
    origin: 'local',
    name,
    title: title !== undefined && title.length > 0 ? title : name,
    description,
    ...(raw.version === undefined || raw.version.length === 0 ? {} : { version: raw.version }),
    // Marketplace-packaged skills share their package icon; without this the
    // whole 连接器套件 group rendered as initial-only tiles.
    ...(typeof raw.icon === 'string' && raw.icon.length > 0 ? { artUrl: artUrlFor(`skillfile:${name}`) } : {}),
    tags: raw.market === undefined ? [] : [marketLabel(raw.market)],
    category: marketLabel(raw.market),
    installable: true,
    // Both languages stay searchable, so an English name still finds the row
    // after its copy was translated.
    search: [raw.plugin, raw.market, raw.description, zh?.description, raw.title]
      .filter((part): part is string => typeof part === 'string')
      .join(' '),
  }
}

class RemotePlugins {
  private cache: RemoteCache<MarketPlugin> = { at: 0, items: new Map() }

  constructor(private readonly market: MarketApiClient) {}

  async all(force = false): Promise<readonly MarketPlugin[]> {
    if (!force && Date.now() - this.cache.at < REMOTE_TTL_MS && this.cache.items.size > 0) {
      return [...this.cache.items.values()]
    }
    const items = new Map<string, MarketPlugin>()
    try {
      for (let page = 1; page <= REMOTE_MAX_PAGES; page++) {
        const response = await this.market.listPlugins({ page, pageSize: REMOTE_PAGE_SIZE })
        for (const item of response.items) items.set(String(item.id), item)
        if (!response.hasMore || response.items.length === 0) break
      }
    } catch {
      // Same partial-result rule as skills.
    }
    this.cache = { at: Date.now(), items }
    return [...items.values()]
  }

  async byId(id: string): Promise<MarketPlugin | undefined> {
    const all = await this.all()
    const hit = all.find(item => String(item.id) === id)
    if (hit !== undefined) return hit
    return (await this.all(true)).find(item => String(item.id) === id)
  }
}

/**
 * Catalogue ids already carry their family (`skill:alpha`), so the panel-facing
 * id is `local:` + that id. Parsing is therefore prefix-based, never a naive
 * `split(':')` — an upstream id may itself contain a colon.
 */
export function parseLocalId(id: string):
  | { readonly kind: 'skill' | 'expert' | 'connector'; readonly catalogId: string }
  | undefined {
  if (!id.startsWith('local:')) return undefined
  // `rest` is the catalogue's own id (`skill:alpha`), which is what
  // `MarketCatalog.find` compares against.
  const rest = id.slice('local:'.length)
  const separator = rest.indexOf(':')
  if (separator <= 0) return undefined
  const kind = rest.slice(0, separator)
  if (kind !== 'skill' && kind !== 'expert' && kind !== 'connector') return undefined
  return { kind, catalogId: rest }
}

function localItem(item: MarketItem): UnifiedItem {
  const id = `local:${item.id}`
  // Expert cards read better with the profession as the headline (that is what
  // the vendor's own page shows); the person's name stays searchable.
  const isExpert = item.kind === 'expert'
  const title = isExpert && item.profession !== undefined && item.profession.length > 0 ? item.profession : item.title
  // Connectors carry no category column upstream; their rail groups by MCP
  // transport instead, which is the only property that changes what installing
  // one actually does (and it is what the older /catalog route already does).
  const category = item.kind === 'connector' ? transportLabel(item.mcp?.transport) : item.category
  const search = [
    item.title,
    item.titleEn,
    isExpert ? item.profession : undefined,
    item.descriptionEn,
    item.market,
  ]
    .filter((part): part is string => typeof part === 'string' && part.length > 0)
    .join(' ')
  return {
    id,
    tab: item.kind,
    origin: 'local',
    name: item.name,
    title: title.length > 0 ? title : item.name,
    description: item.description,
    ...(item.version == null ? {} : { version: item.version }),
    tags: item.tags ?? [],
    ...(category == null || category.length === 0 ? {} : { category }),
    ...(item.emoji == null ? {} : { emoji: item.emoji }),
    artUrl: artUrlFor(id),
    ...(item.examples == null ? {} : { examples: item.examples }),
    ...(item.quickPrompts == null ? {} : { quickPrompts: item.quickPrompts }),
    ...(item.defaultInitPrompt == null ? {} : { prompt: item.defaultInitPrompt }),
    installable: item.installable,
    ...(item.installNote == null ? {} : { installNote: item.installNote }),
    ...(item.mcp == null ? {} : { transport: item.mcp.transport }),
    ...(search.length === 0 ? {} : { search }),
  }
}

function remoteSkill(item: MarketSkill): UnifiedItem {
  const id = `quwork:skill:${item.id}`
  return {
    id,
    tab: 'skill',
    origin: 'remote',
    name: item.name,
    title: item.nameCn.length > 0 ? item.nameCn : item.name,
    description: item.description,
    ...(item.version == null ? {} : { version: item.version }),
    author: item.author,
    tags: item.tags ?? [],
    ...(item.categories[0] === undefined ? {} : { category: item.categories[0] }),
    artUrl: artUrlFor(id),
    installable: true,
  }
}

/**
 * A SkillHub row, shown read-only.
 *
 * These exist because WorkBuddy's market sells skills this machine never
 * downloaded — "12306 Train Assistant" lives only up there. Installing them is
 * WorkBuddy's job, so the row carries a note instead of an install action.
 */
function cloudSkill(row: CloudSkillRow): UnifiedItem {
  return {
    id: row.id,
    tab: 'skill',
    origin: 'remote',
    name: row.slug,
    title: row.title,
    description: row.description,
    ...(row.version === undefined ? {} : { version: row.version }),
    ...(row.author === undefined ? {} : { author: row.author }),
    tags: ['云端', ...(row.source === undefined ? [] : [row.source])],
    category: CLOUD_CATEGORY,
    badge: CLOUD_CATEGORY,
    ...(row.iconUrl === undefined ? {} : { artUrl: artUrlFor(row.id) }),
    ...(row.installs === undefined ? {} : { usage: row.installs }),
    search: [row.title, row.description, row.source ?? '', row.author ?? ''].join(' '),
    installable: true,
    installNote: '来自 WorkBuddy 在线技能市场（SkillHub），安装时会从 SkillHub 下载技能包并解包到本机技能目录。',
  }
}

/** Icon hosts SkillHub actually uses; anything else is not proxied. */
const ART_HOSTS = new Set([
  'cloudcache.tencent-cloud.com',
  'skillhub-1388575217.cos.accelerate.myqcloud.com',
  'skillhub-1388575217.cos.ap-guangzhou.myqcloud.com',
  'openplatform-cdn.codebuddy.cn',
  'api.skillhub.cn',
  'raw.githubusercontent.com',
])

function isAllowedArtHost(raw: string): boolean {
  try {
    const parsed = new URL(raw)
    return parsed.protocol === 'https:' && ART_HOSTS.has(parsed.hostname)
  } catch {
    return false
  }
}

const ART_TYPES: Readonly<Record<string, string>> = {
  png: 'image/png',
  svg: 'image/svg+xml',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
}

/** Download one remote icon once and keep it beside the other market caches. */
async function fetchArtBytes(url: string, cacheRoot: string): Promise<ArtResult> {
  const extension = (new URL(url).pathname.split('.').pop() ?? '').toLowerCase()
  const format = ART_TYPES[extension] === undefined ? 'png' : extension
  const directory = join(cacheRoot, 'cloud-icons')
  const target = join(directory, `${createHash('sha1').update(url).digest('hex')}.${format}`)
  try {
    const info = await stat(target)
    if (info.isFile() && info.size > 0) {
      return { kind: 'bytes', bytes: await readFile(target), contentType: ART_TYPES[format] }
    }
  } catch {
    // not cached yet
  }
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(8000) })
    if (!response.ok) return { kind: 'none' }
    const type = response.headers.get('content-type') ?? ''
    if (!type.startsWith('image/')) return { kind: 'none' }
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.length === 0 || bytes.length > 512 * 1024) return { kind: 'none' }
    await mkdir(directory, { recursive: true })
    await writeFile(target, bytes)
    return { kind: 'bytes', bytes, contentType: ART_TYPES[format] ?? type }
  } catch {
    return { kind: 'none' }
  }
}

function remotePlugin(item: MarketPlugin): UnifiedItem {
  const id = `quwork:plugin:${item.id}`
  return {
    id,
    tab: 'plugin',
    origin: 'remote',
    name: item.name,
    title: item.nameCn.length > 0 ? item.nameCn : item.name,
    description: item.description,
    version: item.version,
    author: item.author,
    tags: item.tags ?? [],
    artUrl: artUrlFor(id),
    installable: true,
  }
}

function matches(item: UnifiedItem, needle: string): boolean {
  if (needle.length === 0) return true
  // Category and the hidden `search` field matter: a marketplace row often only
  // carries its keywords in the English copy or the alias name, and searching
  // just the Chinese title made most of the catalogue unreachable.
  const haystack = [
    item.title,
    item.name,
    item.description,
    item.author ?? '',
    item.category ?? '',
    item.search ?? '',
    ...item.tags,
  ]
    .join(' ')
    .toLowerCase()
  return haystack.includes(needle)
}

function categoriesOf(items: readonly UnifiedItem[]): readonly UnifiedCategory[] {
  const counts = new Map<string, number>()
  for (const item of items) {
    const name = item.category
    if (name === undefined || name.length === 0) continue
    counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name))
}

export interface AggregateDeps {
  readonly catalog: MarketCatalog
  readonly market: MarketApiClient
  /** Path of the online expert snapshot; absent when it was never synced. */
  readonly expertSnapshot?: string
  /** Path of the local-marketplace skill snapshot. */
  readonly skillSnapshot?: string
  /** Path of the Chinese overrides for that snapshot. */
  readonly skillTranslation?: string
  /** WorkBuddy's online skill market (SkillHub); absent disables cloud search. */
  readonly cloudSkills?: CloudSkillClient
}

export class Aggregator {
  private readonly skills: RemoteSkills
  private readonly plugins: RemotePlugins
  private readonly marketExperts: MarketExperts | undefined
  private readonly localSkills: LocalSkills | undefined
  /** Rows from the last cloud searches, so install/art can resolve them by id. */
  private cloudRows = new Map<string, CloudSkillRow>()
  /** Ids already shown while paging the cloud market, to hide upstream repeats. */
  private cloudSeen = new Set<string>()
  /** Next upstream SkillHub page to read; upstream pages overlap, ours do not. */
  private cloudCursor = 1
  private cloudTotal: number | undefined
  private cloudTotalAt = 0

  constructor(private readonly deps: AggregateDeps) {
    this.skills = new RemoteSkills(deps.market)
    this.plugins = new RemotePlugins(deps.market)
    this.marketExperts = deps.expertSnapshot === undefined ? undefined : new MarketExperts(deps.expertSnapshot)
    this.localSkills =
      deps.skillSnapshot === undefined ? undefined : new LocalSkills(deps.skillSnapshot, deps.skillTranslation)
  }

  /** Warm the remote halves so the first tab switch does not wait on a cold cache. */
  async warm(): Promise<void> {
    await Promise.all([
      this.skills.all(),
      this.plugins.all(),
      this.marketExperts?.all() ?? [],
      this.localSkills?.all() ?? [],
    ])
  }

  private async localOf(kind: MarketKind): Promise<readonly UnifiedItem[]> {
    const { items } = await this.deps.catalog.snapshot()
    return items.filter(item => item.kind === kind).map(localItem)
  }

  async list(input: {
    readonly tab: Tab
    readonly q?: string
    readonly category?: string
    readonly page?: number
    readonly pageSize?: number
    readonly sort?: SortMode
  }): Promise<UnifiedList> {
    const page = Math.max(1, input.page ?? 1)
    const pageSize = Math.min(200, Math.max(1, input.pageSize ?? 60))
    let all: readonly UnifiedItem[]
    let degraded = false
    let expertSnapshotMissing = false

    switch (input.tab) {
      case 'skill': {
        const wantedCategory = input.category?.trim()
        const needle = (input.q ?? '').trim()
        // Browsing the cloud market is a different list entirely: it is paged
        // straight off SkillHub instead of being merged into the local rows.
        if (wantedCategory === CLOUD_CATEGORY && this.deps.cloudSkills !== undefined) {
          return await this.listCloud(page, pageSize, needle)
        }
        const [remote, local, packaged] = await Promise.all([
          this.skills.all(),
          this.localOf('skill'),
          this.localSkills?.all() ?? Promise.resolve([]),
        ])
        // Three sources, one list. A skill that ships inside a local marketplace
        // package wins: installing it is a copy, while the other two download a
        // zip first. Same-name duplicates collapse onto the earliest source.
        const seen = new Set<string>()
        const merged: UnifiedItem[] = []
        for (const item of [...packaged, ...local, ...remote.map(remoteSkill)]) {
          const key = item.name.toLowerCase()
          if (seen.has(key)) continue
          seen.add(key)
          merged.push(item)
        }
        // WorkBuddy's own market is a different catalogue (SkillHub, ~215k rows),
        // so it is not mirrored: only a real query hits it, and the hits land
        // alongside the local rows.
        if (needle.length >= 2 && this.deps.cloudSkills !== undefined) {
          const rows = await this.deps.cloudSkills.search(needle, CLOUD_SKILL_LIMIT)
          this.rememberCloudRows(rows)
          // SkillHub matching is fuzzy, so keep only rows that really contain
          // the query — otherwise the chip count lies about what is clickable.
          for (const row of rows.map(cloudSkill).filter(item => matches(item, needle.toLowerCase()))) {
            const key = row.name.toLowerCase()
            if (seen.has(key)) continue
            seen.add(key)
            merged.push(row)
          }
        }
        all = merged
        degraded = remote.length === 0
        break
      }
      case 'expert': {
        const [cloud, bundle] = await Promise.all([
          this.marketExperts?.all() ?? Promise.resolve([]),
          this.localOf('expert'),
        ])
        if (cloud.length === 0) {
          all = bundle
          expertSnapshotMissing = true
          break
        }
        // The cloud list is the superset; keep the bundled rows only when the
        // snapshot does not know that agent at all. Hottest first is what the
        // vendor's own "综合" order shows, and it keeps page 1 useful.
        const known = new Set(cloud.map(item => item.name.toLowerCase()))
        all = [...cloud, ...bundle.filter(item => !known.has(item.name.toLowerCase()))].sort(
          (left, right) => (right.usage ?? 0) - (left.usage ?? 0),
        )
        break
      }
      case 'connector':
        all = await this.localOf('connector')
        break
      case 'plugin': {
        const remote = await this.plugins.all()
        all = remote.map(remotePlugin)
        degraded = remote.length === 0
        break
      }
    }

    const needle = (input.q ?? '').trim().toLowerCase()
    const category = input.category?.trim()
    const filtered = all.filter(
      item => matches(item, needle) && (category === undefined || category.length === 0 || item.category === category),
    )
    // `reco` is the catalogue's own order (experts arrive usage-sorted from the
    // snapshot); `usage` and `name` are explicit user choices.
    const sort = input.sort ?? 'reco'
    const ordered =
      sort === 'usage'
        ? [...filtered].sort((left, right) => (right.usage ?? 0) - (left.usage ?? 0))
        : sort === 'name'
          ? [...filtered].sort((left, right) => left.title.localeCompare(right.title, 'zh-Hans-CN'))
          : filtered

    const start = (page - 1) * pageSize
    const categories = categoriesOf(all)
    // The cloud market is reachable from the chip bar even before a search: the
    // count is the market size, fetched once and cached.
    const cloudEntry =
      input.tab === 'skill' && this.deps.cloudSkills !== undefined && !categories.some(entry => entry.name === CLOUD_CATEGORY)
        ? [{ name: CLOUD_CATEGORY, count: await this.cloudCount() }]
        : []
    return {
      items: ordered.slice(start, start + pageSize),
      categories: [...cloudEntry, ...categories],
      total: ordered.length,
      page,
      pageSize,
      hasMore: start + pageSize < filtered.length,
      ...(degraded ? { degraded: true } : {}),
      ...(expertSnapshotMissing ? { expertSnapshotMissing: true } : {}),
    }
  }

  /** One page of the cloud market (or of a cloud search), straight from SkillHub. */
  private async listCloud(page: number, pageSize: number, needle: string): Promise<UnifiedList> {
    const client = this.deps.cloudSkills
    if (client === undefined) {
      return { items: [], categories: [], total: 0, page, pageSize, hasMore: false }
    }
    if (needle.length >= 2) {
      const rows = await client.search(needle, CLOUD_SKILL_LIMIT)
      this.rememberCloudRows(rows)
      const items = rows.map(cloudSkill).filter(item => matches(item, needle.toLowerCase()))
      return {
        items,
        categories: [{ name: CLOUD_CATEGORY, count: items.length }],
        total: items.length,
        page: 1,
        pageSize,
        hasMore: false,
      }
    }
    // SkillHub's paging is not stable (hundreds of rows share installs=0), so
    // adjacent upstream pages overlap by ~40%. Walk our own cursor and keep
    // fetching until one UI page is actually full of rows the user has not seen.
    if (page <= 1) {
      this.cloudSeen.clear()
      this.cloudCursor = 1
    }
    const fresh: CloudSkillRow[] = []
    let total = this.cloudTotal ?? 0
    for (let attempt = 0; attempt < 4 && fresh.length < pageSize; attempt++) {
      const answer = await client.browse(this.cloudCursor, pageSize)
      this.cloudCursor++
      this.rememberCloudRows(answer.rows)
      if (answer.total > 0) {
        total = answer.total
        this.cloudTotal = answer.total
        this.cloudTotalAt = Date.now()
      }
      if (answer.rows.length === 0) break
      for (const row of answer.rows) {
        if (this.cloudSeen.has(row.id)) continue
        this.cloudSeen.add(row.id)
        fresh.push(row)
      }
    }
    if (this.cloudSeen.size > 5000) this.cloudSeen.clear()
    // A final over-filled attempt is trimmed; the dropped rows stay unseen so the
    // next page picks them up again.
    const shown = fresh.slice(0, pageSize)
    for (const row of fresh.slice(pageSize)) this.cloudSeen.delete(row.id)
    return {
      items: shown.map(cloudSkill),
      categories: [{ name: CLOUD_CATEGORY, count: total }],
      total,
      page,
      pageSize,
      hasMore: this.cloudCursor * pageSize <= total,
      ...(shown.length === 0 ? { degraded: true } : {}),
    }
  }

  /** Keep the last cloud rows addressable: install and artwork resolve by id. */
  private rememberCloudRows(rows: readonly CloudSkillRow[]): void {
    for (const row of rows) {
      this.cloudRows.delete(row.id)
      this.cloudRows.set(row.id, row)
    }
    while (this.cloudRows.size > 800) {
      const oldest = this.cloudRows.keys().next().value
      if (oldest === undefined) break
      this.cloudRows.delete(oldest)
    }
  }

  /** Market size, cached for a while so the chip can show a number. */
  private async cloudCount(): Promise<number> {
    if (this.cloudTotal !== undefined && Date.now() - this.cloudTotalAt < 10 * 60_000) return this.cloudTotal
    const client = this.deps.cloudSkills
    if (client === undefined) return 0
    const { rows, total } = await client.browse(1, 1)
    this.rememberCloudRows(rows)
    if (total > 0) {
      this.cloudTotal = total
      this.cloudTotalAt = Date.now()
    }
    return this.cloudTotal ?? 0
  }

  /** Artwork for a cloud row: its SkillHub icon, proxied and cached on disk. */
  async cloudArt(id: string, cacheRoot: string): Promise<ArtResult> {
    const icon = this.cloudRows.get(id)?.iconUrl
    if (icon === undefined || !isAllowedArtHost(icon)) return { kind: 'none' }
    return await fetchArtBytes(icon, cacheRoot)
  }

  /** Artwork for a marketplace-packaged skill row (`skillfile:<name>`). */
  async localSkillArt(id: string): Promise<ArtResult> {
    const name = id.startsWith('skillfile:') ? id.slice('skillfile:'.length) : id
    const raw = await this.localSkills?.byName(name)
    return await packageSkillArt(raw?.icon)
  }

  /** Resolve one item for an install or an artwork request. */
  async resolve(id: string): Promise<UnifiedItem | undefined> {
    if (id.startsWith('cloud:skill:')) {
      const row = this.cloudRows.get(id)
      return row === undefined ? undefined : cloudSkill(row)
    }
    const local = parseLocalId(id)
    if (local !== undefined) {
      const item = await this.deps.catalog.find(local.kind, local.catalogId)
      return item === undefined ? undefined : localItem(item)
    }
    const [origin, tab, ...rest] = id.split(':')
    const upstreamId = rest.join(':')
    if (origin === 'quwork') {
      if (tab === 'skill') {
        const item = await this.skills.byId(upstreamId)
        return item === undefined ? undefined : remoteSkill(item)
      }
      if (tab === 'plugin') {
        const item = await this.plugins.byId(upstreamId)
        return item === undefined ? undefined : remotePlugin(item)
      }
    }
    return undefined
  }

  /** Raw catalogue entry, for the installers that need the original shape. */
  async rawLocal(tab: MarketKind, id: string): Promise<MarketItem | undefined> {
    return await this.deps.catalog.find(tab, id)
  }

  async rawSkill(id: string): Promise<MarketSkill | undefined> {
    return await this.skills.byId(id)
  }

  async rawPlugin(id: string): Promise<MarketPlugin | undefined> {
    return await this.plugins.byId(id)
  }

  /** Local-marketplace skill row, for the installer behind `skillfile:<name>`. */
  async rawLocalSkill(name: string): Promise<RawLocalSkill | undefined> {
    return await this.localSkills?.byName(name)
  }

  /** Upstream cloud-expert row, for the installer behind `market:expert:<id>`. */
  async rawMarketExpert(id: string): Promise<RawMarketExpert | undefined> {
    return await this.marketExperts?.byId(id)
  }
}
