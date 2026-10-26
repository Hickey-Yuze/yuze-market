/**
 * Local catalog reader.
 *
 * The catalog is produced offline by `scripts/build-catalog.mjs`, which is the
 * only thing that talks to the three WorkBuddy sources (expert COS bucket,
 * skill marketplace zip, connector marketplace zips). This module only reads
 * the resulting `catalog.json` and normalizes the three entry shapes into one
 * `MarketItem` list, so the routes and the UI never branch on the source.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import type {
  CatalogSummary,
  ListResponse,
  MarketCategory,
  MarketItem,
  MarketKind,
} from './types.js'

/** How long a parsed catalog stays in memory before it is re-read. */
const CACHE_TTL_MS = 30_000

export interface QueryParams {
  readonly kind: MarketKind
  readonly q?: string
  readonly category?: string
  readonly page?: number
  readonly pageSize?: number
}

interface ExpertEntry {
  id: string
  name: string
  title: string
  titleEn?: string
  profession?: string
  description?: string
  descriptionEn?: string
  categoryId?: string
  category?: string
  expertType?: string
  tags?: string[]
  emoji?: string
  promptUrl?: string
  avatarUrl?: string
  defaultInitPrompt?: string
  quickPrompts?: string[]
}

interface SkillEntry {
  id: string
  name: string
  title: string
  titleEn?: string
  description?: string
  descriptionEn?: string
  version?: string
  tags?: string[]
  examples?: string[]
  emoji?: string
  source?: string
  zipName?: string
}

interface ConnectorEntry {
  id: string
  name: string
  title: string
  titleEn?: string
  description?: string
  descriptionEn?: string
  version?: string
  market?: string
  root?: string
  tags?: string[]
  skillCount?: number
  commandCount?: number
  agentCount?: number
  hasSkills?: boolean
  rootSkill?: boolean
  dirName?: string
  /** Parsed `mcp.json`, written by the offline builder. */
  mcp?: MarketItem['mcp']
  /** Bundled brand icon, written by the offline builder. */
  icon?: MarketItem['icon']
}

interface CatalogFile {
  builtAt?: string
  totals?: { experts?: number; skills?: number; connectors?: number }
  experts?: { categories?: Array<{ id: string; name: string; nameEn?: string }>; items?: ExpertEntry[] }
  skills?: { items?: SkillEntry[] }
  connectors?: { items?: ConnectorEntry[] }
}

export class MarketCatalog {
  private at = 0
  private items: MarketItem[] = []
  private summary: CatalogSummary = emptySummary()

  constructor(private readonly catalogPath: string) {}

  /** Parsed catalog, re-read from disk when the cached copy is older than the TTL. */
  async snapshot(): Promise<{ readonly items: readonly MarketItem[]; readonly summary: CatalogSummary }> {
    if (this.items.length > 0 && Date.now() - this.at < CACHE_TTL_MS) {
      return { items: this.items, summary: this.summary }
    }
    await this.reload()
    return { items: this.items, summary: this.summary }
  }

  private async reload(): Promise<void> {
    let raw: string
    try {
      raw = await readFile(this.catalogPath, 'utf8')
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException).code
      if (code === 'ENOENT') {
        throw new CatalogMissingError(
          `找不到 ${this.catalogPath}，请先运行 node scripts/build-catalog.mjs`,
        )
      }
      throw cause
    }

    const file = JSON.parse(raw) as CatalogFile
    const items: MarketItem[] = []

    for (const entry of file.experts?.items ?? []) {
      items.push(normalizeExpert(entry))
    }
    for (const entry of file.skills?.items ?? []) {
      items.push(normalizeSkill(entry))
    }
    for (const entry of file.connectors?.items ?? []) {
      items.push(normalizeConnector(entry))
    }

    this.items = items
    this.summary = {
      builtAt: file.builtAt ?? '',
      totals: {
        experts: file.totals?.experts ?? countKind(items, 'expert'),
        skills: file.totals?.skills ?? countKind(items, 'skill'),
        connectors: file.totals?.connectors ?? countKind(items, 'connector'),
      },
      counts: {
        expert: countKind(items, 'expert'),
        skill: countKind(items, 'skill'),
        connector: countKind(items, 'connector'),
      },
      installable: {
        expert: items.filter(i => i.kind === 'expert' && i.installable).length,
        skill: items.filter(i => i.kind === 'skill' && i.installable).length,
        connector: items.filter(i => i.kind === 'connector' && i.installable).length,
      },
    }
    this.at = Date.now()
  }

  /** One page of entries plus the category counts for that kind. */
  async query(params: QueryParams): Promise<ListResponse> {
    const { items, summary } = await this.snapshot()
    const ofKind = items.filter(item => item.kind === params.kind)

    const categories = buildCategories(ofKind, params.kind)

    const needle = (params.q ?? '').trim().toLowerCase()
    const category = params.category?.trim()

    const filtered = ofKind.filter(item => {
      if (category !== undefined && category.length > 0) {
        // The rail sends the display name; the ?category= API accepts either the
        // id or the name so both the UI and hand-written URLs work.
        if (params.kind === 'connector') {
          // Connectors have no category column; the rail groups them by MCP
          // transport, so match either the synthetic key or its label.
          if (category !== `mcp:${item.mcp?.transport ?? 'unknown'}` && category !== transportLabel(item.mcp?.transport)) {
            return false
          }
        } else {
          const key = params.kind === 'skill' ? item.tags[0] : item.categoryId
          const name = params.kind === 'skill' ? item.tags[0] : item.category
          if (key !== category && name !== category) return false
        }
      }
      if (needle.length === 0) return true
      return haystack(item).includes(needle)
    })

    const pageSize = clamp(params.pageSize ?? 60, 1, 300)
    const total = filtered.length
    const page = clamp(params.page ?? 1, 1, Math.max(1, Math.ceil(total / pageSize)))
    const start = (page - 1) * pageSize

    return {
      items: filtered.slice(start, start + pageSize),
      page,
      pageSize,
      total,
      hasMore: start + pageSize < total,
      categories,
      summary,
    }
  }

  /** Look up one entry by kind + id, used by the install route. */
  async find(kind: MarketKind, id: string): Promise<MarketItem | undefined> {
    const { items } = await this.snapshot()
    return items.find(item => item.kind === kind && item.id === id)
  }
}

export class CatalogMissingError extends Error {}

// ---------------------------------------------------------------- normalize

function normalizeExpert(entry: ExpertEntry): MarketItem {
  const hasPrompt = typeof entry.promptUrl === 'string' && entry.promptUrl.length > 0
  return {
    kind: 'expert',
    id: `expert:${entry.id}`,
    name: sanitizeName(entry.name || entry.id),
    title: entry.title || entry.name || entry.id,
    titleEn: entry.titleEn,
    description: entry.description ?? '',
    descriptionEn: entry.descriptionEn,
    category: entry.category ?? '',
    categoryId: entry.categoryId ?? '',
    tags: entry.tags ?? [],
    emoji: entry.emoji,
    promptUrl: entry.promptUrl,
    avatarUrl: entry.avatarUrl,
    profession: entry.profession,
    expertType: entry.expertType,
    defaultInitPrompt: entry.defaultInitPrompt,
    quickPrompts: entry.quickPrompts ?? [],
    installable: hasPrompt,
    installNote: hasPrompt ? undefined : '该专家未发布提示词文件，只能查看资料',
  }
}

function normalizeSkill(entry: SkillEntry): MarketItem {
  return {
    kind: 'skill',
    id: `skill:${entry.id}`,
    name: sanitizeName(entry.id || entry.name),
    title: entry.title || entry.name || entry.id,
    titleEn: entry.titleEn,
    description: entry.description ?? '',
    descriptionEn: entry.descriptionEn,
    category: entry.tags?.[0] ?? '',
    categoryId: entry.tags?.[0] ?? '',
    tags: entry.tags ?? [],
    emoji: entry.emoji,
    version: entry.version,
    source: entry.source ?? entry.id,
    examples: entry.examples ?? [],
    zipName: entry.zipName,
    installable: true,
  }
}

/**
 * The connector catalogue ships no category column, only tags. Grouping by what
 * the package actually contains is the most useful filter a 500-row list can
 * offer: an MCP server, a bundle that also carries skills, or a CLI shim.
 */
function connectorGroup(tags: readonly string[]): string {
  if (tags.includes('mcp')) return 'MCP 服务'
  if (tags.includes('skills')) return '含技能包'
  if (tags.includes('cli')) return 'CLI 工具'
  return ''
}

function normalizeConnector(entry: ConnectorEntry): MarketItem {
  const skillCount = entry.skillCount ?? 0
  const commandCount = entry.commandCount ?? 0
  const agentCount = entry.agentCount ?? 0
  const rootSkill = entry.rootSkill ?? false
  const mcp = entry.mcp
  // A connector is only installable when it declares an MCP endpoint the host
  // can dial: `@deepseek-ai/dsh-mcp-client` speaks stdio and streamable-http
  // only, so an SSE-only server would write an entry that can never connect.
  // Bundled skills/hooks are extra payload, never the reason to install one.
  const transport = mcp?.transport
  const installable = transport === 'streamable-http' || transport === 'stdio'
  return {
    kind: 'connector',
    id: `connector:${entry.id}`,
    name: sanitizeName(entry.name),
    title: entry.title || entry.name,
    titleEn: entry.titleEn,
    description: entry.description ?? '',
    descriptionEn: entry.descriptionEn,
    category: entry.market ?? connectorGroup(entry.tags ?? []),
    categoryId: entry.market ?? connectorGroup(entry.tags ?? []),
    tags: entry.tags ?? [],
    version: entry.version,
    market: entry.market,
    root: entry.root,
    skillCount,
    commandCount,
    agentCount,
    hasSkills: entry.hasSkills ?? skillCount > 0,
    rootSkill,
    dirName: entry.dirName ?? entry.name,
    mcp,
    icon: entry.icon,
    installable,
    // Upstream writes an explicit `null` for connectors with no MCP block, so
    // both null and undefined mean "nothing to dial".
    installNote: installable
      ? undefined
      : mcp == null
        ? '该连接器没有声明 MCP 端点，DSH 无对应机制'
        : '该连接器只提供 SSE 传输，DSH 仅支持 stdio 与 streamable-http',
  }
}

// ---------------------------------------------------------------- helpers

function buildCategories(items: readonly MarketItem[], kind: MarketKind): MarketCategory[] {
  const counts = new Map<string, { name: string; count: number }>()
  for (const item of items) {
    // WorkBuddy's connector catalogue carries no category column, so group the
    // rail by MCP transport instead: it is the only property that changes what
    // installing the entry actually does.
    const connectorKey = kind === 'connector' ? `mcp:${item.mcp?.transport ?? 'unknown'}` : undefined
    const key = connectorKey ?? (kind === 'skill' ? item.tags[0] : item.categoryId)
    const name = connectorKey === undefined
      ? (kind === 'skill' ? item.tags[0] : item.category)
      : transportLabel(item.mcp?.transport)
    if (key === undefined || key.length === 0) continue
    const existing = counts.get(key)
    if (existing === undefined) counts.set(key, { name: name ?? key, count: 1 })
    else existing.count += 1
  }
  return [...counts.entries()]
    .map(([id, value]) => ({ id, name: value.name, count: value.count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh'))
}

/** Human label for a WorkBuddy connector's MCP transport. */
function transportLabel(transport: string | undefined): string {
  if (transport === 'streamable-http') return '远程 MCP'
  if (transport === 'stdio') return '本机 MCP'
  // These two are not installable, so they get their own buckets instead of
  // sharing a label that the rail cannot tell apart.
  if (transport === 'sse') return '仅 SSE（不可用）'
  if (transport === undefined) return '无 MCP 端点'
  return '其他 MCP'
}

function haystack(item: MarketItem): string {
  return [
    item.title,
    item.titleEn,
    item.description,
    item.descriptionEn,
    item.profession,
    item.name,
    ...item.tags,
    ...(item.examples ?? []),
    ...(item.quickPrompts ?? []),
  ]
    .filter((part): part is string => typeof part === 'string' && part.length > 0)
    .join('\n')
    .toLowerCase()
}

/** Skill directory names must be safe path segments. */
export function sanitizeName(raw: string): string {
  // Must satisfy the Host's skill-name grammar: /^[a-z0-9]+(?:-[a-z0-9]+)*$/.
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '')
  return cleaned.length > 0 ? cleaned : 'unnamed'
}

function countKind(items: readonly MarketItem[], kind: MarketKind): number {
  return items.filter(item => item.kind === kind).length
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

function emptySummary(): CatalogSummary {
  return {
    builtAt: '',
    totals: { experts: 0, skills: 0, connectors: 0 },
    counts: { expert: 0, skill: 0, connector: 0 },
    installable: { expert: 0, skill: 0, connector: 0 },
  }
}

/** Default on-disk location of the generated catalog. */
export function defaultCatalogPath(dshHome: string): string {
  return join(dshHome, 'workbuddy-market', 'cache', 'catalog.json')
}
