/**
 * Persisted OAuth credentials for streamable-HTTP MCP connectors.
 *
 * DSH's MCP client only understands a static `headers` map
 * (`@deepseek-ai/dsh-mcp-client/lib/index.js` builds one
 * `StreamableHTTPClientTransport` with `requestInit: { headers }`), so it cannot
 * run an authorization-code flow or refresh an expired token by itself. Tokens
 * therefore live here, and the bundled proxy (`proxy.ts`) injects them on every
 * upstream request.
 *
 * Layout: `<dshHome>/secrets/mcp-oauth/<serverName>.json`, mode 0600.
 */

import { mkdir, readFile, rm, writeFile, chmod } from 'node:fs/promises'
import { join } from 'node:path'

export interface OAuthTokenRecord {
  readonly server: string
  readonly mcpUrl: string
  readonly clientId: string
  readonly redirectUri: string
  readonly scope: string
  readonly tokenType: string
  readonly accessToken: string
  readonly refreshToken: string | null
  /** Epoch milliseconds, or null when the server did not send `expires_in`. */
  readonly expiresAt: number | null
  readonly obtainedAt: string
}

export class TokenStore {
  readonly #dir: string

  constructor(dshHome: string) {
    this.#dir = join(dshHome, 'secrets', 'mcp-oauth')
  }

  #file(server: string): string {
    return join(this.#dir, `${sanitize(server)}.json`)
  }

  async read(server: string): Promise<OAuthTokenRecord | null> {
    try {
      const raw = await readFile(this.#file(server), 'utf8')
      const parsed = JSON.parse(raw) as OAuthTokenRecord
      if (typeof parsed.accessToken !== 'string' || parsed.accessToken.length === 0) return null
      return parsed
    } catch {
      return null
    }
  }

  async write(record: OAuthTokenRecord): Promise<void> {
    await mkdir(this.#dir, { recursive: true, mode: 0o700 })
    const target = this.#file(record.server)
    await writeFile(target, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 })
    await chmod(target, 0o600).catch(() => undefined)
  }

  async clear(server: string): Promise<void> {
    await rm(this.#file(server), { force: true })
  }
}

/** A token is treated as stale 60s early so a request never races the expiry. */
export function isExpired(record: OAuthTokenRecord, now = Date.now()): boolean {
  if (record.expiresAt === null) return false
  return record.expiresAt - 60_000 <= now
}

function sanitize(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, '-')
}
