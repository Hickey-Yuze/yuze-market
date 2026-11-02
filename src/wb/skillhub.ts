/**
 * WorkBuddy's online skill market, as search results.
 *
 * The 技能 tab used to be local-only: marketplace packages already on disk plus
 * QuWork's remote list. WorkBuddy's own market is a different catalogue — it
 * searches SkillHub (`api.skillhub.cn`), which is public and holds ~214k skills.
 * Mirroring that is pointless, so this client is search-only: the tab queries it
 * when the user types something, and the rows are read-only (installing a cloud
 * skill goes through WorkBuddy itself).
 *
 * Failures are swallowed into an empty list — a search that cannot reach
 * SkillHub must degrade to "only the local hits", never to an error page.
 */

export interface CloudSkillRow {
  /** Stable id, `cloud:skill:<slug>` once mapped into the aggregate list. */
  readonly id: string
  readonly slug: string
  readonly name: string
  readonly title: string
  readonly description: string
  readonly category?: string
  readonly version?: string
  readonly installs?: number
  readonly downloads?: number
  readonly source?: string
  readonly author?: string
  readonly homepage?: string
  readonly iconUrl?: string
}

export interface CloudSkillClient {
  /** Up to `limit` skills matching `keyword`; empty when offline or unknown. */
  search(keyword: string, limit: number): Promise<readonly CloudSkillRow[]>
}

const TTL_MS = 5 * 60_000
const DEFAULT_ENDPOINT = 'https://api.skillhub.cn/api/skills'

interface Row {
  readonly name?: unknown
  readonly description?: unknown
  readonly description_zh?: unknown
  readonly category?: unknown
  readonly version?: unknown
  readonly installs?: unknown
  readonly downloads?: unknown
  readonly source?: unknown
  readonly ownerName?: unknown
  readonly homepage?: unknown
  readonly iconUrl?: unknown
  readonly slug?: unknown
  readonly namespace?: { readonly canonicalName?: unknown; readonly publicSlug?: unknown }
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function parseRow(raw: unknown): CloudSkillRow | undefined {
  if (raw === null || typeof raw !== 'object') return undefined
  const row = raw as Row
  const title = text(row.name)
  if (title === undefined) return undefined
  const slug = text(row.slug) ?? text(row.namespace?.publicSlug) ?? title
  const canonical = text(row.namespace?.canonicalName)
  return {
    id: `cloud:skill:${canonical ?? slug}`,
    slug,
    name: canonical ?? slug,
    title,
    description: text(row.description_zh) ?? text(row.description) ?? '',
    ...(text(row.category) === undefined ? {} : { category: text(row.category) }),
    ...(text(row.version) === undefined ? {} : { version: text(row.version) }),
    ...(count(row.installs) === undefined ? {} : { installs: count(row.installs) }),
    ...(count(row.downloads) === undefined ? {} : { downloads: count(row.downloads) }),
    ...(text(row.source) === undefined ? {} : { source: text(row.source) }),
    ...(text(row.ownerName) === undefined ? {} : { author: text(row.ownerName) }),
    ...(text(row.homepage) === undefined ? {} : { homepage: text(row.homepage) }),
    ...(text(row.iconUrl) === undefined ? {} : { iconUrl: text(row.iconUrl) }),
  }
}

export function createCloudSkillClient(
  options: { readonly endpoint?: string; readonly timeoutMs?: number } = {},
): CloudSkillClient {
  const endpoint = options.endpoint ?? DEFAULT_ENDPOINT
  const timeoutMs = options.timeoutMs ?? 8000
  const cache = new Map<string, { at: number; rows: readonly CloudSkillRow[] }>()

  return {
    async search(keyword: string, limit: number): Promise<readonly CloudSkillRow[]> {
      const needle = keyword.trim()
      if (needle.length === 0) return []
      const key = needle.toLowerCase()
      const cached = cache.get(key)
      if (cached !== undefined && Date.now() - cached.at < TTL_MS) return cached.rows

      const size = Math.min(50, Math.max(1, limit))
      const url = `${endpoint}?page=1&pageSize=${size}&keyword=${encodeURIComponent(needle)}`
      try {
        const response = await fetch(url, {
          signal: AbortSignal.timeout(timeoutMs),
          headers: { accept: 'application/json' },
        })
        if (!response.ok) return cached?.rows ?? []
        const payload = (await response.json()) as { data?: { skills?: readonly unknown[] } }
        const rows = (payload.data?.skills ?? [])
          .map(parseRow)
          .filter((row): row is CloudSkillRow => row !== undefined)
          .slice(0, size)
        cache.set(key, { at: Date.now(), rows })
        return rows
      } catch {
        // Offline, DNS, timeout: keep whatever this keyword returned last time.
        return cached?.rows ?? []
      }
    },
  }
}
