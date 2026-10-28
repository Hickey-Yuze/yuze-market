/**
 * Shared wire types between the Node half (market client, installers) and the
 * Client half (panels). Kept in one place so both builds agree on the shape of
 * every `/api/yuze-market/*` response.
 */

/** One market category as published by the QuWork backend. */
export interface MarketCategory {
  readonly id: number
  readonly name: string
  readonly icon?: string
  readonly skillCount?: number
  readonly pluginCount?: number
}

/** A skill entry from `/api/skill/list`. */
export interface MarketSkill {
  readonly id: number
  /** kebab-case skill id; also the install directory name. */
  readonly name: string
  readonly nameCn: string
  readonly description: string
  readonly version: string
  readonly tags: readonly string[]
  readonly categories: readonly string[]
  readonly author: string
  /** Absolute https URL of the skill zip. */
  readonly url: string
  readonly createdAt?: string
  readonly updatedAt?: string
}

/** A plugin entry from `/api/dsh_plugin/list`. */
export interface MarketPlugin {
  readonly id: number
  /** npm package name; the install target must match it. */
  readonly name: string
  readonly nameCn: string
  readonly version: string
  readonly description: string
  readonly sketch?: string
  readonly avatar?: string
  readonly author: string
  readonly tags: readonly string[]
  readonly keywords: readonly string[]
  /** Absolute https URL of the plugin zip. */
  readonly downloadUrl: string
  readonly recommendSort?: number
  readonly createdAt?: string
  readonly updatedAt?: string
}

export interface SkillListResponse {
  readonly items: readonly MarketSkill[]
  readonly page: number
  readonly pageSize: number
  readonly total?: number
  readonly hasMore: boolean
  /** Market entries the client refused to surface, with the reason. */
  readonly skipped?: readonly SkippedEntry[]
}

export interface SkippedEntry {
  readonly name: string
  readonly reason: string
}

export interface PluginListResponse {
  readonly items: readonly MarketPlugin[]
  readonly page: number
  readonly pageSize: number
  readonly total?: number
  readonly hasMore: boolean
}

export interface CategoryListResponse {
  readonly items: readonly MarketCategory[]
}

/** Locally installed skills, discovered from the DSH user skill root. */
export interface InstalledSkill {
  readonly name: string
  readonly description: string
  readonly path: string
  readonly marketplaceId?: number
  readonly version?: string
}

/** Locally installed plugins, read from the profile manifest. */
export interface InstalledPlugin {
  readonly packageName: string
  readonly version: string
  readonly enabled: boolean
  readonly builtin: boolean
}

/** Result of one install attempt. */
export interface InstallResult {
  readonly ok: boolean
  readonly target: string
  readonly kind: 'skill' | 'plugin'
  /** Stable machine code; empty when ok. */
  readonly code?: string
  /** Human readable detail; empty when ok. */
  readonly message?: string
  /** Warnings that did not stop the install. */
  readonly warnings?: readonly string[]
}

export interface ApiError {
  readonly error: string
  readonly code?: string
}
