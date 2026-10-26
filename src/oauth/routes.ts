/**
 * HTTP routes that make an OAuth-protected MCP connector usable from the
 * connector hub.
 *
 * The browser cannot run the token exchange itself (the code exchange needs the
 * PKCE verifier and the client secret-less client id, and the result must be
 * written into `cordis.patch.yml`), so the flow runs here and the panel only
 * opens the authorization URL and polls status.
 *
 * Routes (mounted under `/api/qurwork-market/oauth`):
 *
 * - `GET  /status?server=<name>` — current authorization state.
 * - `POST /start`                — begin a flow, returns the URL to open.
 * - `POST /disconnect`           — drop the stored token and its headers.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

import { OAuthBroker, discover } from './flow.js'
import { isExpired, type OAuthTokenRecord, TokenStore } from './store.js'
import type { InstallResult } from '../wb/types.js'

export const OAUTH_ROUTE_PREFIX = '/api/qurwork-market/oauth'

export interface OAuthDeps {
  readonly dshHome: string
  readonly callbackPort: number
  /** Rewrite (or add) the `headers:` block of an installed connector entry. */
  updateHeaders(serverName: string, headers: Record<string, string>): Promise<InstallResult>
  /** The MCP endpoint recorded for an installed connector, for status hints. */
  readUrl(serverName: string): Promise<string | null>
}

export interface OAuthStatus {
  readonly server: string
  readonly mcpUrl: string | null
  readonly authorized: boolean
  readonly expiresAt: number | null
  readonly daysLeft: number | null
  readonly scope: string
  readonly obtainedAt: string | null
  /** True when `/status` silently exchanged the stored refresh token. */
  readonly refreshed?: boolean
  /** True when a token was stored but is no longer usable. */
  readonly expired?: boolean
}

interface Route {
  readonly kind: 'exact' | 'prefix'
  readonly path: string
  readonly handler: (request: IncomingMessage, response: ServerResponse) => void
}

export function mountOAuthRoutes(register: (route: Route) => () => void, deps: OAuthDeps): () => void {
  const store = new TokenStore(deps.dshHome)
  const broker = new OAuthBroker(store)

  const describe = (record: OAuthTokenRecord, refreshed: boolean): OAuthStatus => ({
    server: record.server,
    mcpUrl: record.mcpUrl,
    authorized: true,
    expiresAt: record.expiresAt,
    daysLeft:
      record.expiresAt === null ? null : Math.max(0, Math.round((record.expiresAt - Date.now()) / 86_400_000)),
    scope: record.scope,
    obtainedAt: record.obtainedAt,
    ...(refreshed ? { refreshed: true } : {}),
  })

  /**
   * A stored token that is past (or within a minute of) its expiry is traded for
   * a fresh one, and the profile headers are rewritten so the next Host boot
   * already carries a usable bearer. The running Host read the patch at boot, so
   * an expiry can never be healed live — but re-authorizing by hand, which needs
   * a full browser round trip, is not needed either.
   */
  const refreshExpired = async (record: OAuthTokenRecord): Promise<OAuthTokenRecord | null> => {
    if (record.refreshToken === null) return null
    const found = await discover(record.mcpUrl)
    if (found.server === null) return null
    const next = await broker.refresh(record, found.server)
    if (next !== null) {
      await deps.updateHeaders(record.server, { authorization: `Bearer ${next.accessToken}` }).catch(() => undefined)
    }
    return next
  }

  const status = async (server: string): Promise<OAuthStatus> => {
    const record = await store.read(server)
    if (record === null) {
      return {
        server,
        mcpUrl: await deps.readUrl(server),
        authorized: false,
        expiresAt: null,
        daysLeft: null,
        scope: '',
        obtainedAt: null,
      }
    }
    if (!isExpired(record)) return describe(record, false)
    const refreshed = await refreshExpired(record)
    if (refreshed !== null) return describe(refreshed, true)
    return { ...describe({ ...record, expiresAt: null }, false), authorized: false, expired: true }
  }

  const disposers = [
    register({
      kind: 'prefix',
      path: OAUTH_ROUTE_PREFIX,
      handler: (request, response) => {
        void handle(request, response)
      },
    }),
  ]

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://localhost')
    const tail = url.pathname.slice(OAUTH_ROUTE_PREFIX.length).replace(/^\/+|\/+$/g, '')

    try {
      if (request.method === 'GET' && tail === 'status') {
        const server = url.searchParams.get('server') ?? ''
        if (server.length === 0) return send(response, 400, { error: 'missing-server' })
        return send(response, 200, await status(server))
      }

      if (request.method === 'GET' && tail === 'discover') {
        const mcpUrl = url.searchParams.get('url') ?? ''
        if (!/^https?:\/\//.test(mcpUrl)) return send(response, 400, { error: 'bad-url' })
        const found = await discover(mcpUrl)
        return send(response, 200, {
          needsAuth: found.server !== null,
          status: found.status,
          reason: found.reason ?? null,
          scope: (found.server?.scopes_supported ?? found.resource?.scopes_supported ?? []).join(' '),
        })
      }

      if (request.method === 'POST' && tail === 'start') {
        const body = await readJson(request)
        const server = typeof body?.server === 'string' ? body.server : ''
        const mcpUrl = typeof body?.mcpUrl === 'string' ? body.mcpUrl : ''
        if (server.length === 0 || !/^https?:\/\//.test(mcpUrl)) {
          return send(response, 400, { error: 'bad-request' })
        }
        const started = await broker.start({
          server,
          mcpUrl,
          callbackPort: deps.callbackPort,
          ...(typeof body?.scope === 'string' && body.scope.length > 0 ? { scope: body.scope } : {}),
        })
        if ('error' in started) return send(response, 400, { error: 'flow-failed', message: started.error })

        // Persisting headers is what actually makes the connector work. Do it
        // as soon as the token lands so the panel only has to refresh.
        void started.completed
          .then(async record => {
            await deps.updateHeaders(server, {
              authorization: `Bearer ${record.accessToken}`,
            })
          })
          .catch(() => undefined)

        return send(response, 200, { authUrl: started.authUrl })
      }

      if (request.method === 'POST' && tail === 'disconnect') {
        const body = await readJson(request)
        const server = typeof body?.server === 'string' ? body.server : ''
        if (server.length === 0) return send(response, 400, { error: 'bad-request' })
        const record = await store.read(server)
        await store.clear(server)
        if (record !== null) await deps.updateHeaders(server, {}).catch(() => undefined)
        broker.cancel()
        return send(response, 200, { ok: true })
      }

      send(response, 404, { error: 'not-found' })
    } catch (cause) {
      send(response, 500, { error: 'internal', message: (cause as Error).message })
    }
  }

  return () => {
    broker.cancel()
    for (const dispose of disposers) dispose()
  }
}

function send(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  response.end(payload)
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(chunk as Buffer)
  if (chunks.length === 0) return null
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** Exported for tests and for the panel's "needs authorization?" hint. */
export { isExpired, TokenStore }
export type { OAuthTokenRecord }
