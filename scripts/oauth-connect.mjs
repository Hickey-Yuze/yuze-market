/**
 * Standalone OAuth probe for WorkBuddy MCP connectors.
 *
 * Proves the RFC 9728 / RFC 8414 discovery + PKCE authorization-code flow that
 * the plugin's connector hub will later drive from the UI:
 *
 *   1. POST the MCP endpoint -> expect 401 with a `resource_metadata` pointer
 *   2. fetch protected-resource metadata -> authorization server(s)
 *   3. fetch AS metadata -> endpoints + PKCE support
 *   4. dynamic client registration (RFC 7591) against the redirect we can bind
 *   5. print the authorization URL and wait for the loopback callback
 *   6. exchange the code for tokens, persist them under ~/.dsh/secrets
 *   7. call `initialize` on the MCP endpoint with the token
 *
 * Usage: node scripts/oauth-connect.mjs [serverName] [mcpUrl]
 */
import { createServer } from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const SERVER = process.argv[2] ?? 'tencent-docs'
const MCP_URL = process.argv[3] ?? 'https://docs.qq.com/openapi/mcp'
const PORT = Number(process.env.OAUTH_PORT ?? 17321)
const REDIRECT = `http://127.0.0.1:${PORT}/oauth/callback`
const SCOPE = process.env.OAUTH_SCOPE ?? 'docs:read docs:write'

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

function pkce() {
  const verifier = b64url(randomBytes(48))
  const challenge = b64url(createHash('sha256').update(verifier).digest())
  return { verifier, challenge }
}

async function discover(mcpUrl) {
  const probe = await fetch(mcpUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: 'Bearer invalid-probe',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'qurwork-market', version: '0.1.0' },
      },
    }),
  })
  const challenge0 = probe.headers.get('www-authenticate') ?? ''
  const match = /resource_metadata="([^"]+)"/.exec(challenge0)
  if (match === null) throw new Error(`no resource_metadata in WWW-Authenticate: ${challenge0}`)

  const resourceMeta = await (await fetch(match[1])).json()
  const issuer = new URL(resourceMeta.authorization_servers[0])

  const asMetaUrl = new URL('/.well-known/oauth-authorization-server', issuer)
  const asMeta = await (await fetch(asMetaUrl)).json()

  return { resourceMeta, asMeta, status: probe.status }
}

async function register(asMeta) {
  const response = await fetch(asMeta.registration_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'DSH WorkBuddy Market',
      redirect_uris: [REDIRECT],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
  })
  const body = await response.json()
  if (body.client_id === undefined) throw new Error(`registration failed: ${JSON.stringify(body)}`)
  return body
}

function authorizeUrl(asMeta, clientId, challenge, state) {
  // Tencent serves its consent UI from a scenario SPA; authType=2 selects the
  // MCP OAuth branch, authType=3 the device-code branch.
  const endpoint = asMeta.authorization_endpoint
  const url = new URL(endpoint)
  url.searchParams.set('client_id', clientId)
  url.searchParams.set('redirect_uri', REDIRECT)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('scope', SCOPE)
  url.searchParams.set('state', state)
  url.searchParams.set('code_challenge', challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  return url.toString()
}

async function exchange(asMeta, clientId, code, verifier) {
  const response = await fetch(asMeta.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: clientId,
      redirect_uri: REDIRECT,
      code_verifier: verifier,
    }),
  })
  const text = await response.text()
  let body
  try {
    body = JSON.parse(text)
  } catch {
    body = { raw: text }
  }
  return { status: response.status, body }
}

async function initialize(mcpUrl, token) {
  const response = await fetch(mcpUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'qurwork-market', version: '0.1.0' },
      },
    }),
  })
  const text = await response.text()
  return { status: response.status, body: text.slice(0, 400) }
}

const { asMeta } = await discover(MCP_URL)
console.log('[1] authorization server:', asMeta.issuer)
console.log('    authorize :', asMeta.authorization_endpoint)
console.log('    token     :', asMeta.token_endpoint)

const client = await register(asMeta)
console.log('[2] registered client_id:', client.client_id)

const { verifier, challenge } = pkce()
const state = randomBytes(16).toString('hex')
const url = authorizeUrl(asMeta, client.client_id, challenge, state)

const result = await new Promise((resolve, reject) => {
  const server = createServer(async (request, response) => {
    const target = new URL(request.url ?? '/', REDIRECT)
    if (target.pathname !== '/oauth/callback') {
      response.writeHead(404).end('not found')
      return
    }
    const code = target.searchParams.get('code')
    const returnedState = target.searchParams.get('state')
    const error = target.searchParams.get('error')
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(
      '<html><body style="font-family:system-ui;padding:40px"><h2>授权完成，可以关闭此页面</h2></body></html>',
    )
    server.close()
    if (error !== null) {
      reject(new Error(`authorization error: ${error} ${target.searchParams.get('error_description') ?? ''}`))
      return
    }
    if (returnedState !== state) {
      reject(new Error('state mismatch'))
      return
    }
    resolve({ code })
  })
  server.listen(PORT, '127.0.0.1', () => {
    console.log('[3] waiting on', REDIRECT)
    console.log('\n=== OPEN THIS URL ===\n' + url + '\n')
  })
})

const token = await exchange(asMeta, client.client_id, result.code, verifier)
console.log('[4] token endpoint:', token.status, JSON.stringify(token.body).slice(0, 300))

if (token.body.access_token === undefined) {
  console.error('no access_token; aborting')
  process.exit(1)
}

const secretDir = join(homedir(), '.dsh', 'secrets', 'mcp-oauth')
mkdirSync(secretDir, { recursive: true })
const record = {
  server: SERVER,
  mcpUrl: MCP_URL,
  clientId: client.client_id,
  redirectUri: REDIRECT,
  scope: SCOPE,
  tokenType: token.body.token_type ?? 'Bearer',
  accessToken: token.body.access_token,
  refreshToken: token.body.refresh_token ?? null,
  expiresAt:
    typeof token.body.expires_in === 'number' ? Date.now() + token.body.expires_in * 1000 : null,
  obtainedAt: new Date().toISOString(),
}
const target = join(secretDir, `${SERVER}.json`)
writeFileSync(target, JSON.stringify(record, null, 2), { mode: 0o600 })
console.log('[5] saved', target)

const probe = await initialize(MCP_URL, record.accessToken)
console.log('[6] initialize with token:', probe.status, probe.body)
