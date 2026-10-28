/**
 * Client for 市场's own routes (`/api/yuze-market/*`).
 *
 * One item shape, one install entry point: the Host resolves which upstream a
 * row came from, so the panel never has to know whether it is looking at a
 * remote marketplace entry or a locally cached bundle.
 */

const BASE = '/api/yuze-market'

export type Tab = 'skill' | 'expert' | 'connector' | 'plugin'
export type SortMode = 'reco' | 'usage' | 'name'

export interface UnifiedItem {
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
  readonly artUrl?: string
  readonly examples?: readonly string[]
  readonly quickPrompts?: readonly string[]
  readonly prompt?: string
  readonly installable: boolean
  readonly installNote?: string
  readonly transport?: string
  readonly usage?: number
  readonly badge?: string
}

export interface UnifiedCategory {
  readonly name: string
  readonly count: number
}

export interface UnifiedList {
  readonly items: readonly UnifiedItem[]
  readonly categories: readonly UnifiedCategory[]
  readonly total: number
  readonly page: number
  readonly pageSize: number
  readonly hasMore: boolean
  readonly degraded?: boolean
  /** True when the expert tab is showing only the bundled 429-row catalogue. */
  readonly expertSnapshotMissing?: boolean
}

export interface InstalledSkillEntry {
  readonly name: string
  /** Catalogue artwork, when this entry can be traced back to a market row. */
  readonly artUrl?: string
  readonly kind: 'skill' | 'expert' | 'manual'
  readonly title: string
  readonly description: string
  readonly version?: string
  readonly marketId?: string
  readonly enabled: boolean
  readonly path: string
  readonly installedAt?: string
}

export interface InstalledConnectorEntry {
  readonly id: string
  readonly serverName: string
  readonly transport: string
  readonly enabled: boolean
  /** Chinese display name from the catalogue, when the entry came from it. */
  readonly title?: string
  readonly artUrl?: string
}

export interface InstalledPluginEntry {
  readonly packageName: string
  readonly version: string
  readonly enabled: boolean
  readonly builtin: boolean
}

export interface InstalledPayload {
  readonly skills: readonly InstalledSkillEntry[]
  readonly connectors: readonly InstalledConnectorEntry[]
  readonly plugins: readonly InstalledPluginEntry[]
}

export interface MutationResult {
  readonly ok: boolean
  readonly code?: string
  readonly message?: string
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${BASE}${path}`, {
    headers: {
      accept: 'application/json',
      ...(init?.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...init,
  })
  const text = await response.text()
  let body: unknown = {}
  try {
    body = text.length > 0 ? JSON.parse(text) : {}
  } catch {
    throw new Error(`接口返回了非 JSON 响应（HTTP ${response.status}）`)
  }
  if (!response.ok) {
    const message =
      typeof body === 'object' && body !== null && typeof (body as { message?: unknown }).message === 'string'
        ? (body as { message: string }).message
        : `请求失败（HTTP ${response.status}）`
    throw new Error(message)
  }
  return body as T
}

function query(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '') continue
    search.set(key, String(value))
  }
  const text = search.toString()
  return text.length === 0 ? '' : `?${text}`
}

export const marketApi = {
  items(input: {
    readonly tab: Tab
    readonly q?: string
    readonly category?: string
    readonly page?: number
    readonly pageSize?: number
    readonly sort?: SortMode
  }): Promise<UnifiedList> {
    return request<UnifiedList>(
      `/items${query({
        tab: input.tab,
        q: input.q,
        category: input.category,
        page: input.page,
        pageSize: input.pageSize,
        sort: input.sort,
      })}`,
    )
  },

  installed(): Promise<InstalledPayload> {
    return request<InstalledPayload>('/installed')
  },

  install(
    id: string,
    options: { readonly allowRestart?: boolean } = {},
  ): Promise<MutationResult & { target?: string; kind?: string }> {
    return request('/install', {
      method: 'POST',
      body: JSON.stringify({ id, ...(options.allowRestart === true ? { allowRestart: true } : {}) }),
    })
  },

  setSkillEnabled(name: string, enabled: boolean): Promise<MutationResult> {
    return request('/enable', { method: 'POST', body: JSON.stringify({ name, enabled }) })
  },

  removeSkill(name: string): Promise<MutationResult> {
    return request('/remove', { method: 'POST', body: JSON.stringify({ name }) })
  },

  setConnectorEnabled(serverName: string, enabled: boolean): Promise<MutationResult> {
    return request('/connector', { method: 'POST', body: JSON.stringify({ serverName, enabled }) })
  },

  removeConnector(serverName: string): Promise<MutationResult> {
    return request('/connector', { method: 'POST', body: JSON.stringify({ serverName, remove: true }) })
  },

  setPluginEnabled(packageName: string, enabled: boolean): Promise<MutationResult> {
    return request('/plugin', { method: 'POST', body: JSON.stringify({ packageName, enabled }) })
  },

  removePlugin(packageName: string): Promise<MutationResult> {
    return request('/plugin', { method: 'POST', body: JSON.stringify({ packageName, remove: true }) })
  },

  /** Start pulling the published expert catalogue into the local cache. */
  fetchExpertSnapshot(): Promise<{ started: boolean; alreadyRunning?: boolean }> {
    return request('/snapshot/experts', { method: 'POST' })
  },

  /** Byte progress of that background download. */
  expertSnapshotProgress(): Promise<{
    state: 'idle' | 'running' | 'done' | 'error'
    received: number
    total: number
    message?: string
  }> {
    return request('/snapshot/experts/progress')
  },

  manual(payload: Record<string, unknown>): Promise<MutationResult> {
    return request('/manual', { method: 'POST', body: JSON.stringify(payload) })
  },
}
