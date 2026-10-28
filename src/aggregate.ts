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

import { readFile } from 'node:fs/promises'

import type { MarketApiClient } from './market-api.js'
import type { MarketPlugin, MarketSkill } from './shared/types.js'
import type { MarketCatalog } from './wb/catalog.js'
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
 * A cloud expert is installable while its captured signature is live. Running
 * the sync again refreshes both the row and its URL.
 */
function downloadState(raw: RawMarketExpert): Pick<UnifiedItem, 'installable' | 'installNote' | 'badge'> {
  const url = raw.download_url
  if (typeof url !== 'string' || url.length === 0) {
    return {
      installable: false,
      installNote: '该专家还没有下载地址：先运行 `pnpm run sync:experts` 同步一次即可安装',
      badge: '云端',
    }
  }
  const expiresAt = typeof raw.download_expires_at === 'number' ? raw.download_expires_at : null
  if (expiresAt !== null && expiresAt < Date.now()) {
    return {
      installable: false,
      installNote: '下载地址已过期（签名约 24 小时），重新同步专家市场后可安装',
      badge: '云端',
    }
  }
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

  constructor(
    private readonly file: string,
    private readonly zhFile?: string,
  ) {}

  async all(): Promise<readonly UnifiedItem[]> {
    if (this.cache.items.length > 0 && Date.now() - this.cache.at < REMOTE_TTL_MS) return this.cache.items
    let raw: { items?: readonly RawLocalSkill[] }
    try {
      raw = JSON.parse(await readFile(this.file, 'utf8')) as { items?: readonly RawLocalSkill[] }
    } catch {
      return this.cache.items
    }
    if (this.zh.size === 0 && this.zhFile !== undefined) {
      try {
        const parsed = JSON.parse(await readFile(this.zhFile, 'utf8')) as { map?: Record<string, SkillTranslation> }
        for (const [name, value] of Object.entries(parsed.map ?? {})) {
          if (typeof value?.title === 'string' || typeof value?.description === 'string') this.zh.set(name, value)
        }
      } catch {
        // No translation pass yet: the English copy stays visible.
      }
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
    ...(item.category == null || item.category.length === 0 ? {} : { category: item.category }),
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
}

export class Aggregator {
  private readonly skills: RemoteSkills
  private readonly plugins: RemotePlugins
  private readonly marketExperts: MarketExperts | undefined
  private readonly localSkills: LocalSkills | undefined

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
    return {
      items: ordered.slice(start, start + pageSize),
      categories: categoriesOf(all),
      total: ordered.length,
      page,
      pageSize,
      hasMore: start + pageSize < filtered.length,
      ...(degraded ? { degraded: true } : {}),
      ...(expertSnapshotMissing ? { expertSnapshotMissing: true } : {}),
    }
  }

  /** Resolve one item for an install or an artwork request. */
  async resolve(id: string): Promise<UnifiedItem | undefined> {
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
