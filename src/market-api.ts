/**
 * QuWork market backend client.
 *
 * The backend at `llm.rrzu.com` serves two independent catalogs:
 *   - `/api/skill/*`        → skills, distributed as zip archives
 *   - `/api/dsh_plugin/*`   → DSH plugins, distributed as zip archives
 *
 * Both endpoints are public (no account token required). Every response is
 * validated here before it reaches the UI, so a malformed or hostile payload
 * can never be rendered or installed.
 */

import { z } from 'zod'
import type {
  MarketCategory,
  MarketPlugin,
  MarketSkill,
  PluginListResponse,
  SkillListResponse,
  CategoryListResponse,
  SkippedEntry,
} from './shared/types.js'

export const DEFAULT_API_BASE = 'https://llm.rrzu.com'

const PAGE_SIZE = 200
const MAX_PAGE_SIZE = 200
const REQUEST_TIMEOUT_MS = 20_000
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024

/** Errors surfaced to the client with a stable machine code. */
export class MarketError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = 'MarketError'
  }
}

const unsafeText = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u

const safeText = (max: number) => z.string().max(max).refine(
  value => !unsafeText.test(value),
  'contains control characters',
)

const optionalText = (max: number) => safeText(max).optional()

const httpsUrl = z.string().max(2_048).refine((value) => {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.username === '' && url.password === ''
  } catch {
    return false
  }
}, 'must be an https URL without credentials')

const isoDate = z.string().refine(
  value => Number.isFinite(Date.parse(value)),
  'must be an ISO timestamp',
)

const skillSchema = z.object({
  id: z.number().int().positive(),
  name: safeText(200).refine(
    value => /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value),
    'must be a kebab-case skill name',
  ),
  name_cn: safeText(200),
  description: z.string().max(5_000),
  version: safeText(64),
  tags: z.array(safeText(120)).max(100).default([]),
  categories: z.array(safeText(120)).max(50).default([]),
  owner: safeText(200).default(''),
  url: httpsUrl,
  created_at: isoDate.optional(),
  updated_at: isoDate.optional(),
}).strict()

const pluginSchema = z.object({
  id: z.number().int().positive(),
  name: safeText(214).refine(
    value => /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u.test(value),
    'must be a valid npm package name',
  ),
  name_cn: safeText(200),
  version: safeText(64).refine(
    value => /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(value),
    'must be an exact semver version',
  ),
  description: z.string().max(5_000),
  sketch: z.string().max(5_000).optional(),
  avatar: z.string().max(2_048).optional(),
  author: safeText(200).default(''),
  tags: z.array(safeText(120)).max(100).default([]),
  keywords: z.array(safeText(120)).max(100).default([]),
  download_url: httpsUrl,
  recommend_sort: z.number().int().optional(),
  status: z.number().int().optional(),
  created_at: isoDate.optional(),
  updated_at: isoDate.optional(),
}).strict()

const categorySchema = z.object({
  id: z.number().int().positive(),
  name: safeText(100),
  icon: optionalText(200),
  skill_count: z.number().int().nonnegative().optional(),
  plugin_count: z.number().int().nonnegative().optional(),
  // The backend also sends a `pain_point` blurb; it is not part of our contract
  // but it must not make an otherwise valid category fail to parse.
  pain_point: optionalText(2_000),
}).strip()

function unwrapData(value: unknown): unknown {
  // The backend wraps payloads as {data: {...}} and sometimes double-wraps.
  let current = value
  for (let depth = 0; depth < 3; depth += 1) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) break
    const record = current as Record<string, unknown>
    if (!('data' in record)) break
    current = record.data
  }
  return current
}

function toArray(value: unknown): unknown[] {
  const unwrapped = unwrapData(value)
  if (Array.isArray(unwrapped)) return unwrapped
  if (unwrapped && typeof unwrapped === 'object') {
    const record = unwrapped as Record<string, unknown>
    for (const key of ['list', 'items', 'rows', 'records']) {
      const candidate = record[key]
      if (Array.isArray(candidate)) return candidate
    }
  }
  throw new MarketError('invalid-response', '市场返回了无法识别的列表结构')
}

function readTotal(value: unknown): number | undefined {
  const unwrapped = unwrapData(value)
  if (!unwrapped || typeof unwrapped !== 'object') return undefined
  const record = unwrapped as Record<string, unknown>
  for (const key of ['total', 'count', 'total_count']) {
    const candidate = record[key]
    if (typeof candidate === 'number' && Number.isSafeInteger(candidate) && candidate >= 0) {
      return candidate
    }
  }
  return undefined
}

function mapSkill(raw: z.infer<typeof skillSchema>): MarketSkill {
  return {
    id: raw.id,
    name: raw.name,
    nameCn: raw.name_cn,
    description: raw.description,
    version: raw.version,
    tags: raw.tags,
    categories: raw.categories,
    author: raw.owner,
    url: raw.url,
    ...(raw.created_at === undefined ? {} : { createdAt: raw.created_at }),
    ...(raw.updated_at === undefined ? {} : { updatedAt: raw.updated_at }),
  }
}

function mapPlugin(raw: z.infer<typeof pluginSchema>): MarketPlugin {
  return {
    id: raw.id,
    name: raw.name,
    nameCn: raw.name_cn,
    version: raw.version,
    description: raw.description,
    ...(raw.sketch === undefined ? {} : { sketch: raw.sketch }),
    ...(raw.avatar === undefined ? {} : { avatar: raw.avatar }),
    author: raw.author,
    tags: raw.tags,
    keywords: raw.keywords,
    downloadUrl: raw.download_url,
    ...(raw.recommend_sort === undefined ? {} : { recommendSort: raw.recommend_sort }),
    ...(raw.created_at === undefined ? {} : { createdAt: raw.created_at }),
    ...(raw.updated_at === undefined ? {} : { updatedAt: raw.updated_at }),
  }
}

/** HTTP client for the QuWork market backend. */
export class MarketApiClient {
  constructor(private readonly baseUrl: string = DEFAULT_API_BASE) {}

  private async request(path: string, params: Record<string, string | number | undefined>): Promise<unknown> {
    const url = new URL(path, this.baseUrl)
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined) continue
      url.searchParams.set(key, String(value))
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        redirect: 'error',
        headers: { accept: 'application/json' },
      })
      if (!response.ok) {
        throw new MarketError('upstream-status', `市场服务返回 ${response.status}`, response.status)
      }
      const text = await response.text()
      if (text.length > MAX_RESPONSE_BYTES) {
        throw new MarketError('response-too-large', '市场返回的数据过大')
      }
      try {
        return JSON.parse(text) as unknown
      } catch {
        throw new MarketError('invalid-response', '市场返回的不是合法 JSON')
      }
    } catch (error) {
      if (error instanceof MarketError) throw error
      if (error instanceof Error && error.name === 'AbortError') {
        throw new MarketError('timeout', '市场服务响应超时')
      }
      throw new MarketError('network-failed', `无法连接市场服务：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      clearTimeout(timer)
    }
  }

  async listSkillCategories(): Promise<CategoryListResponse> {
    const raw = await this.request('/api/skill/categories', {})
    const items: MarketCategory[] = []
    for (const entry of toArray(raw)) {
      const parsed = categorySchema.safeParse(entry)
      if (!parsed.success) continue
      const data = parsed.data
      items.push({
        id: data.id,
        name: data.name,
        ...(data.icon === undefined ? {} : { icon: data.icon }),
        ...(data.skill_count === undefined ? {} : { skillCount: data.skill_count }),
        ...(data.plugin_count === undefined ? {} : { pluginCount: data.plugin_count }),
      })
    }
    return { items }
  }

  async listSkills(input: {
    page?: number
    pageSize?: number
    category?: string
    keyword?: string
  } = {}): Promise<SkillListResponse> {
    const page = Math.max(1, Math.floor(input.page ?? 1))
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(input.pageSize ?? PAGE_SIZE)))
    const raw = await this.request('/api/skill/list', {
      page,
      page_size: pageSize,
      category: input.category,
      keyword: input.keyword,
    })
    const items: MarketSkill[] = []
    const skipped: SkippedEntry[] = []
    for (const entry of toArray(raw)) {
      const parsed = skillSchema.safeParse(entry)
      if (!parsed.success) {
        skipped.push({
          name: typeof (entry as { name?: unknown })?.name === 'string' ? String((entry as { name: string }).name) : '(unnamed)',
          reason: parsed.error.issues[0]?.message ?? '条目格式不合法',
        })
        continue
      }
      items.push(mapSkill(parsed.data))
    }
    const total = readTotal(raw)
    return {
      items,
      page,
      pageSize,
      ...(total === undefined ? {} : { total }),
      hasMore: total === undefined ? items.length >= pageSize : page * pageSize < total,
      ...(skipped.length === 0 ? {} : { skipped }),
    }
  }

  async listPluginCategories(): Promise<CategoryListResponse> {
    const raw = await this.request('/api/dsh_plugin/categories', { page: 1, page_size: 100 })
    const items: MarketCategory[] = []
    for (const entry of toArray(raw)) {
      const parsed = categorySchema.safeParse(entry)
      if (!parsed.success) continue
      const data = parsed.data
      items.push({
        id: data.id,
        name: data.name,
        ...(data.icon === undefined ? {} : { icon: data.icon }),
        ...(data.skill_count === undefined ? {} : { skillCount: data.skill_count }),
        ...(data.plugin_count === undefined ? {} : { pluginCount: data.plugin_count }),
      })
    }
    return { items }
  }

  async listPlugins(input: {
    page?: number
    pageSize?: number
    category?: string
    keyword?: string
  } = {}): Promise<PluginListResponse> {
    const page = Math.max(1, Math.floor(input.page ?? 1))
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(input.pageSize ?? PAGE_SIZE)))
    const raw = await this.request('/api/dsh_plugin/list', {
      page,
      page_size: pageSize,
      category: input.category,
      keyword: input.keyword,
    })
    const items: MarketPlugin[] = []
    for (const entry of toArray(raw)) {
      const parsed = pluginSchema.safeParse(entry)
      if (!parsed.success) continue
      items.push(mapPlugin(parsed.data))
    }
    const total = readTotal(raw)
    return {
      items,
      page,
      pageSize,
      ...(total === undefined ? {} : { total }),
      hasMore: total === undefined ? items.length >= pageSize : page * pageSize < total,
    }
  }
}
