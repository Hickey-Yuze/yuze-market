/**
 * Shared wire types between the Node half and the Client half.
 *
 * Every `/api/workbuddy-market/*` payload is described here so both builds
 * agree on the shape. The catalog itself is produced offline by
 * `scripts/build-catalog.mjs` and read from `~/.dsh/workbuddy-market/cache`.
 */

export type MarketKind = 'expert' | 'skill' | 'connector'

/** One MCP server entry, as declared by the connector's `mcp.json`. */
export interface McpServerConfig {
  readonly serverName: string
  readonly transport: 'stdio' | 'sse' | 'streamable-http'
  readonly url?: string
  readonly headers?: Readonly<Record<string, string>>
  readonly command?: string
  readonly args?: readonly string[]
  readonly env?: Readonly<Record<string, string>>
}

/** One installable entry, normalized across the three WorkBuddy sources. */
export interface MarketItem {
  readonly kind: MarketKind
  /** Stable id scoped by kind; the install command uses this. */
  readonly id: string
  /** kebab-case install directory name. */
  readonly name: string
  readonly title: string
  readonly titleEn?: string
  readonly description: string
  readonly descriptionEn?: string
  readonly category?: string
  readonly categoryId?: string
  readonly tags: readonly string[]
  readonly emoji?: string
  readonly version?: string
  readonly avatarUrl?: string

  // expert
  readonly promptUrl?: string
  readonly profession?: string
  readonly expertType?: string
  readonly defaultInitPrompt?: string
  readonly quickPrompts?: readonly string[]

  // skill
  readonly source?: string
  readonly examples?: readonly string[]
  /** Basename of the marketplace zip this entry was unpacked from. */
  readonly zipName?: string

  // connector
  /** Parsed `mcp.json`; absent for CLI-only connectors. */
  readonly mcp?: McpServerConfig
  /** Bundled brand icon path, relative to the connector directory. */
  readonly icon?: { readonly file: string; readonly format: 'png' | 'svg' }
  readonly market?: string
  readonly root?: string
  readonly skillCount?: number
  readonly commandCount?: number
  readonly agentCount?: number
  readonly hasSkills?: boolean
  /** Single-skill connectors ship `SKILL.md` at the plugin root instead. */
  readonly rootSkill?: boolean
  /** On-disk plugin directory name, which may differ from the unique `name`. */
  readonly dirName?: string

  /** Whether this entry can be written into the DSH skill root. */
  readonly installable: boolean
  /** Why an entry is not installable, shown in the UI. */
  readonly installNote?: string
}

export interface MarketCategory {
  readonly id: string
  readonly name: string
  readonly nameEn?: string
  readonly count: number
}

export interface CatalogSummary {
  readonly builtAt: string
  readonly totals: { readonly experts: number; readonly skills: number; readonly connectors: number }
  readonly counts: { readonly expert: number; readonly skill: number; readonly connector: number }
  readonly installable: { readonly expert: number; readonly skill: number; readonly connector: number }
}

export interface ListResponse {
  readonly items: readonly MarketItem[]
  readonly page: number
  readonly pageSize: number
  readonly total: number
  readonly hasMore: boolean
  readonly categories: readonly MarketCategory[]
  readonly summary: CatalogSummary
}

/** One entry already present in the DSH skill root. */
export interface InstalledSkill {
  readonly name: string
  readonly title: string
  readonly description: string
  readonly path: string
  readonly kind: MarketKind | 'unknown'
}

/** Result of one install attempt. */
export interface InstallResult {
  readonly ok: boolean
  readonly kind: MarketKind
  /** Absolute directory written, or the item id when nothing was written. */
  readonly target: string
  /** Machine code; empty when ok. */
  readonly code?: string
  readonly message?: string
  readonly warnings?: readonly string[]
}

export interface ApiError {
  readonly error: string
  readonly code?: string
}
