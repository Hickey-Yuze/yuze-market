/**
 * Authorization-code + PKCE flow for MCP servers that advertise OAuth
 * (RFC 9728 protected-resource metadata, RFC 8414 AS metadata, RFC 7591
 * dynamic client registration).
 *
 * The DSH host gives plugins route registration but no server instance, so the
 * loopback callback listener is a plain `node:http` server owned by this module
 * and closed on completion, timeout, or plugin teardown. One flow runs at a
 * time; starting another cancels the first.
 */

import { createHash, randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'

import { type OAuthTokenRecord, TokenStore } from './store.js'

const MCP_PROTOCOL_VERSION = '2024-11-05'
const FLOW_TIMEOUT_MS = 5 * 60_000

export interface ResourceMetadata {
  readonly resource?: string
  readonly authorization_servers?: readonly string[]
  readonly scopes_supported?: readonly string[]
}

export interface AuthorizationServerMetadata {
  readonly issuer: string
  readonly authorization_endpoint: string
  readonly token_endpoint: string
  readonly registration_endpoint?: string
  readonly scopes_supported?: readonly string[]
  readonly code_challenge_methods_supported?: readonly string[]
  readonly grant_types_supported?: readonly string[]
}

export interface DiscoveryResult {
  /** HTTP status of the unauthenticated probe (usually 401). */
  readonly status: number
  readonly resource: ResourceMetadata | null
  readonly server: AuthorizationServerMetadata | null
  /** Absolute URL the user must open, when `server` is present. */
  readonly reason?: string
}

export interface StartOptions {
  readonly server: string
  readonly mcpUrl: string
  readonly scope?: string
  readonly callbackPort: number
  /** Value used when the server does not advertise a scope list. */
  readonly defaultScope?: string
}

const b64url = (buffer: Buffer): string =>
  buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

function pkce(): { verifier: string; challenge: string } {
  const verifier = b64url(randomBytes(48))
  const challenge = b64url(createHash('sha256').update(verifier).digest())
  return { verifier, challenge }
}

function initializeBody(): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'yuze-market', version: '0.1.0' },
    },
  })
}

async function jsonOrNull<T>(url: string, init?: RequestInit): Promise<T | null> {
  try {
    const response = await fetch(url, init)
    if (!response.ok) return null
    return (await response.json()) as T
  } catch {
    return null
  }
}

/**
 * Probe the endpoint and walk metadata links. An endpoint that answers 200 to
 * an unauthenticated `initialize` needs no authorization at all.
 */
export async function discover(mcpUrl: string): Promise<DiscoveryResult> {
  let status = 0
  let challenge = ''
  try {
    const response = await fetch(mcpUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: 'Bearer discovery-probe',
      },
      body: initializeBody(),
    })
    status = response.status
    challenge = response.headers.get('www-authenticate') ?? ''
    await response.text().catch(() => undefined)
  } catch (cause) {
    return { status: 0, resource: null, server: null, reason: `无法连接该端点：${(cause as Error).message}` }
  }

  if (status === 200) {
    return { status, resource: null, server: null, reason: '该端点无需授权' }
  }

  const pointer = /resource_metadata="([^"]+)"/i.exec(challenge)?.[1]
  if (pointer === undefined) {
    return { status, resource: null, server: null, reason: `端点返回 ${status}，且未声明 resource_metadata` }
  }

  const resource = await jsonOrNull<ResourceMetadata>(pointer)
  const issuer = resource?.authorization_servers?.[0]
  if (issuer === undefined) {
    return { status, resource, server: null, reason: '资源元数据里没有 authorization_servers' }
  }

  const wellKnown = new URL('/.well-known/oauth-authorization-server', issuer).toString()
  const server = await jsonOrNull<AuthorizationServerMetadata>(wellKnown)
  if (server === null) {
    return { status, resource, server: null, reason: `取不到授权服务器元数据：${wellKnown}` }
  }
  if (typeof server.authorization_endpoint !== 'string' || typeof server.token_endpoint !== 'string') {
    return { status, resource, server: null, reason: '授权服务器元数据缺少端点' }
  }

  return { status, resource, server }
}

export interface PendingFlow {
  readonly server: string
  readonly authUrl: string
  cancel(): void
}

/**
 * Owns loopback listeners and in-flight flows for the plugin's lifetime.
 * Tokens are persisted through `TokenStore` as soon as the code is exchanged.
 */
export class OAuthBroker {
  readonly #store: TokenStore
  #pending: { flow: PendingFlow; stop: () => void } | null = null

  constructor(store: TokenStore) {
    this.#store = store
  }

  get store(): TokenStore {
    return this.#store
  }

  /**
   * Register a client, bind the callback listener, and return the URL the user
   * must open. Resolves the stored record once the browser hits the callback.
   */
  async start(
    options: StartOptions,
  ): Promise<{ authUrl: string; completed: Promise<OAuthTokenRecord> } | { error: string }> {
    this.cancel()

    const found = await discover(options.mcpUrl)
    const as = found.server
    if (as === null) return { error: found.reason ?? '该端点未声明 OAuth 授权服务器' }

    const redirectUri = `http://127.0.0.1:${options.callbackPort}/oauth/callback`
    const scope = options.scope ?? options.defaultScope ?? (as.scopes_supported ?? []).join(' ')

    const registration = await this.#register(as, redirectUri)
    if ('error' in registration) return registration

    const { verifier, challenge } = pkce()
    const state = randomBytes(16).toString('hex')

    const authUrl = new URL(as.authorization_endpoint)
    authUrl.searchParams.set('client_id', registration.clientId)
    authUrl.searchParams.set('redirect_uri', redirectUri)
    authUrl.searchParams.set('response_type', 'code')
    authUrl.searchParams.set('state', state)
    if (scope.length > 0) authUrl.searchParams.set('scope', scope)
    if ((as.code_challenge_methods_supported ?? []).includes('S256')) {
      authUrl.searchParams.set('code_challenge', challenge)
      authUrl.searchParams.set('code_challenge_method', 'S256')
    }

    const completed = new Promise<OAuthTokenRecord>((resolve, reject) => {
      const server: Server = createServer((request, response) => {
        const target = new URL(request.url ?? '/', redirectUri)
        if (target.pathname !== '/oauth/callback') {
          response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found')
          return
        }
        const fail = (message: string): void => {
          response.writeHead(400, { 'content-type': 'text/html; charset=utf-8' }).end(html(message))
          finish()
          reject(new Error(message))
        }
        const error = target.searchParams.get('error')
        if (error !== null) {
          fail(`授权被拒绝：${error} ${target.searchParams.get('error_description') ?? ''}`.trim())
          return
        }
        if (target.searchParams.get('state') !== state) {
          fail('state 校验失败')
          return
        }
        const code = target.searchParams.get('code')
        if (code === null) {
          fail('回调里没有 code')
          return
        }
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(html('授权完成，可以关闭此页面'))
        finish()
        void this.#exchange(as, options, registration.clientId, redirectUri, scope, code, verifier)
          .then(record => {
            void this.#store.write(record).then(() => resolve(record), reject)
          })
          .catch(reject)
      })

      const timer = setTimeout(() => {
        finish()
        reject(new Error('授权超时（5 分钟）'))
      }, FLOW_TIMEOUT_MS)

      const finish = (): void => {
        clearTimeout(timer)
        server.close()
        this.#pending = null
      }

      server.on('error', cause => {
        finish()
        reject(cause)
      })
      server.listen(options.callbackPort, '127.0.0.1')

      this.#pending = {
        flow: {
          server: options.server,
          authUrl: authUrl.toString(),
          cancel: () => {
            finish()
            reject(new Error('授权已取消'))
          },
        },
        stop: finish,
      }
    })

    // The rejection surfaces to whoever awaits `completed`; swallow it here so
    // an abandoned flow does not become an unhandled rejection.
    completed.catch(() => undefined)

    return { authUrl: authUrl.toString(), completed }
  }

  /** Cancel any in-flight flow (called on teardown and before a new one). */
  cancel(): void {
    const pending = this.#pending
    this.#pending = null
    pending?.stop()
  }

  pendingServer(): string | null {
    return this.#pending?.flow.server ?? null
  }

  async #register(
    as: AuthorizationServerMetadata,
    redirectUri: string,
  ): Promise<{ clientId: string } | { error: string }> {
    if (as.registration_endpoint === undefined) {
      return { error: '该授权服务器不支持动态注册（没有 registration_endpoint）' }
    }
    const body = await jsonOrNull<{ client_id?: string; error_description?: string }>(as.registration_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: 'DSH Qurwork Market',
        redirect_uris: [redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      }),
    })
    if (body === null || typeof body.client_id !== 'string') {
      return { error: `客户端注册失败${body?.error_description === undefined ? '' : `：${body.error_description}`}` }
    }
    return { clientId: body.client_id }
  }

  async #exchange(
    as: AuthorizationServerMetadata,
    options: StartOptions,
    clientId: string,
    redirectUri: string,
    scope: string,
    code: string,
    verifier: string,
  ): Promise<OAuthTokenRecord> {
    const response = await fetch(as.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: clientId,
        redirect_uri: redirectUri,
        code_verifier: verifier,
      }),
    })
    const text = await response.text()
    let parsed: {
      access_token?: string
      refresh_token?: string
      token_type?: string
      expires_in?: number
      error?: string
      error_description?: string
    } = {}
    try {
      parsed = JSON.parse(text) as typeof parsed
    } catch {
      // fall through to the error below with the raw body attached
    }
    if (typeof parsed.access_token !== 'string') {
      throw new Error(`换取 token 失败：${parsed.error ?? response.status} ${parsed.error_description ?? text.slice(0, 200)}`)
    }
    return {
      server: options.server,
      mcpUrl: options.mcpUrl,
      clientId,
      redirectUri,
      scope,
      tokenType: parsed.token_type ?? 'Bearer',
      accessToken: parsed.access_token,
      refreshToken: parsed.refresh_token ?? null,
      expiresAt: typeof parsed.expires_in === 'number' ? Date.now() + parsed.expires_in * 1000 : null,
      obtainedAt: new Date().toISOString(),
    }
  }

  /** Exchange a refresh token; returns the updated record or null on failure. */
  async refresh(record: OAuthTokenRecord, as: AuthorizationServerMetadata): Promise<OAuthTokenRecord | null> {
    if (record.refreshToken === null) return null
    const body = await jsonOrNull<{
      access_token?: string
      refresh_token?: string
      expires_in?: number
      token_type?: string
    }>(as.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: record.refreshToken,
        client_id: record.clientId,
      }),
    })
    if (body === null || typeof body.access_token !== 'string') return null
    const next: OAuthTokenRecord = {
      ...record,
      accessToken: body.access_token,
      refreshToken: body.refresh_token ?? record.refreshToken,
      expiresAt: typeof body.expires_in === 'number' ? Date.now() + body.expires_in * 1000 : null,
      obtainedAt: new Date().toISOString(),
    }
    await this.#store.write(next)
    return next
  }
}

function html(message: string): string {
  return `<!doctype html><meta charset="utf-8"><title>Qurwork Market</title><body style="font-family:system-ui,-apple-system,sans-serif;display:grid;place-items:center;height:100vh;margin:0"><p style="font-size:17px">${message}</p>`
}
