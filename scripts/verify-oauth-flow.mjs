/**
 * End-to-end check of the one-click authorization used by the connector hub.
 *
 * A fake authorization server stands in for docs.qq.com: it publishes the same
 * RFC 9728 / RFC 8414 metadata, accepts RFC 7591 dynamic registration, verifies
 * the S256 PKCE challenge, and issues tokens. The plugin's real handlers
 * (`mountOAuthRoutes` → `OAuthBroker`) drive the flow, so this exercises the
 * exact code the panel calls:
 *
 *   status(unauthorized) → start → consent redirect → loopback callback →
 *   code exchange → profile headers → status(authorized) → disconnect
 *
 * plus expiry handling (refresh exchange, and a dead token with no refresh).
 *
 * Run: npm run verify:oauth
 */
import { createServer } from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { mountOAuthRoutes } from '../scratch/server-out/oauth/routes.js'

const CALLBACK_PORT = Number(process.env.OAUTH_TEST_CALLBACK_PORT ?? 17341)
const HOME = join(process.cwd(), 'scratch', 'oauth-home')

let failures = 0
function check(label, condition, detail) {
  if (condition) {
    console.log(`  ok   ${label}`)
    return
  }
  failures += 1
  console.log(`  FAIL ${label}${detail === undefined ? '' : ` → ${detail}`}`)
}

const b64url = buffer => buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const sha = value => b64url(createHash('sha256').update(value).digest())

// ------------------------------------------------------------ fake OAuth AS

const issued = { access: new Set(), refresh: new Map() }
const clients = new Map()
const codes = new Map()
let base = ''
let tokenCalls = 0

/** Every access token the AS has handed out, so the MCP probe can accept them. */
function issue(prefix) {
  const token = `${prefix}-${randomBytes(9).toString('hex')}`
  issued.access.add(token)
  return token
}

function metadata() {
  return {
    issuer: base,
    authorization_endpoint: `${base}/authorize`,
    token_endpoint: `${base}/token`,
    registration_endpoint: `${base}/register`,
    scopes_supported: ['demo:read', 'demo:write'],
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['none'],
    code_challenge_methods_supported: ['S256'],
  }
}

const as = createServer((request, response) => {
  const url = new URL(request.url ?? '/', base)
  const json = (status, body) => {
    response.writeHead(status, { 'content-type': 'application/json' })
    response.end(JSON.stringify(body))
  }

  if (request.method === 'POST' && url.pathname === '/mcp') {
    const authorization = request.headers.authorization ?? ''
    const token = authorization.replace(/^Bearer\s+/u, '')
    if (issued.access.has(token)) return json(200, { jsonrpc: '2.0', id: 1, result: { tools: [] } })
    response.writeHead(401, {
      'content-type': 'application/json',
      'www-authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`,
    })
    response.end(JSON.stringify({ error: 'invalid_token' }))
    return
  }

  if (request.method === 'GET' && url.pathname === '/.well-known/oauth-protected-resource') {
    return json(200, { resource: `${base}/mcp`, authorization_servers: [base], scopes_supported: ['demo:read'] })
  }

  if (request.method === 'GET' && url.pathname === '/.well-known/oauth-authorization-server') {
    return json(200, metadata())
  }

  if (request.method === 'POST' && url.pathname === '/register') {
    let body = ''
    request.on('data', chunk => {
      body += chunk
    })
    request.on('end', () => {
      let redirectUri = ''
      try {
        redirectUri = JSON.parse(body).redirect_uris?.[0] ?? ''
      } catch {
        // A malformed registration body fails the flow, which the test asserts.
      }
      const clientId = `client-${randomBytes(4).toString('hex')}`
      clients.set(clientId, { redirectUri })
      json(201, { client_id: clientId, redirect_uris: [redirectUri] })
    })
    return
  }

  // Consent screen: the test "user" always approves.
  if (request.method === 'GET' && url.pathname === '/authorize') {
    const clientId = url.searchParams.get('client_id') ?? ''
    const redirectUri = url.searchParams.get('redirect_uri') ?? ''
    const client = clients.get(clientId)
    if (client === undefined || client.redirectUri !== redirectUri) {
      response.writeHead(400, { 'content-type': 'text/plain' }).end('unknown client')
      return
    }
    const code = randomBytes(8).toString('hex')
    codes.set(code, {
      clientId,
      redirectUri,
      challenge: url.searchParams.get('code_challenge') ?? '',
      scope: url.searchParams.get('scope') ?? '',
    })
    const target = new URL(redirectUri)
    target.searchParams.set('code', code)
    target.searchParams.set('state', url.searchParams.get('state') ?? '')
    response.writeHead(302, { location: target.toString() }).end()
    return
  }

  if (request.method === 'POST' && url.pathname === '/token') {
    tokenCalls += 1
    let body = ''
    request.on('data', chunk => {
      body += chunk
    })
    request.on('end', () => {
      const form = new URLSearchParams(body)
      const grant = form.get('grant_type')
      if (grant === 'refresh_token') {
        const owner = issued.refresh.get(form.get('refresh_token') ?? '')
        if (owner === undefined) return json(400, { error: 'invalid_grant' })
        const access = issue('at')
        return json(200, { access_token: access, token_type: 'Bearer', expires_in: 3600 })
      }
      const stored = codes.get(form.get('code') ?? '')
      codes.delete(form.get('code') ?? '')
      if (stored === undefined) return json(400, { error: 'invalid_grant' })
      // The whole point of PKCE: the verifier must hash to the challenge.
      if (stored.challenge.length > 0 && sha(form.get('code_verifier') ?? '') !== stored.challenge) {
        return json(400, { error: 'invalid_grant', error_description: 'PKCE mismatch' })
      }
      const access = issue('at')
      const refresh = `rt-${randomBytes(9).toString('hex')}`
      issued.refresh.set(refresh, true)
      json(200, { access_token: access, refresh_token: refresh, token_type: 'Bearer', expires_in: 3600 })
    })
    return
  }

  response.writeHead(404, { 'content-type': 'text/plain' }).end('not found')
})

// ------------------------------------------------------------- plugin routes

const routes = []
const headerWrites = []

const dispose = mountOAuthRoutes(
  route => {
    routes.push(route)
    return () => {}
  },
  {
    dshHome: HOME,
    callbackPort: CALLBACK_PORT,
    updateHeaders: async (serverName, headers) => {
      headerWrites.push({ serverName, headers })
      return { ok: true, kind: 'connector', target: serverName }
    },
    readUrl: async serverName => (serverName === 'demo' ? `${base}/mcp` : null),
  },
)

const plugin = createServer((request, response) => {
  for (const route of routes) {
    if ((request.url ?? '').startsWith(route.path)) return route.handler(request, response)
  }
  response.writeHead(404, { 'content-type': 'text/plain' }).end('no route')
})

await rm(HOME, { recursive: true, force: true })
await mkdir(HOME, { recursive: true })
await new Promise(resolve => as.listen(0, '127.0.0.1', resolve))
base = `http://127.0.0.1:${as.address().port}`
await new Promise(resolve => plugin.listen(0, '127.0.0.1', resolve))
const endpoint = `http://127.0.0.1:${plugin.address().port}/api/yuze-market/oauth`

const get = async path => {
  const response = await fetch(`${endpoint}${path}`)
  return { status: response.status, body: await response.json() }
}
const post = async (path, payload) => {
  const response = await fetch(`${endpoint}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  return { status: response.status, body: await response.json() }
}

const settle = async (predicate, timeoutMs = 8000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  return false
}

try {
  console.log('\n1. 未授权时的状态')
  {
    const { status, body } = await get('/status?server=demo')
    check('HTTP 200', status === 200, status)
    check('authorized=false', body.authorized === false, JSON.stringify(body))
    check('回填了已安装连接器的 mcpUrl', body.mcpUrl === `${base}/mcp`, body.mcpUrl)
  }

  console.log('\n2. 发起授权：discovery + 动态注册 + PKCE')
  let authUrl = ''
  {
    const { status, body } = await post('/start', { server: 'demo', mcpUrl: `${base}/mcp`, scope: 'demo:read' })
    check('HTTP 200', status === 200, JSON.stringify(body))
    check('返回了授权地址', typeof body.authUrl === 'string', JSON.stringify(body))
    authUrl = body.authUrl ?? ''
    const parsed = new URL(authUrl || 'http://invalid')
    check('指向授权端点', parsed.pathname === '/authorize', parsed.pathname)
    check('带 S256 challenge', parsed.searchParams.get('code_challenge_method') === 'S256')
    check('带 state', (parsed.searchParams.get('state') ?? '').length === 32)
    check('带动态注册的 client_id', (parsed.searchParams.get('client_id') ?? '').startsWith('client-'))
    check('回环 redirect_uri', parsed.searchParams.get('redirect_uri') === `http://127.0.0.1:${CALLBACK_PORT}/oauth/callback`)
  }

  console.log('\n3. 浏览器完成授权 → 回环回调 → 换取 token')
  {
    // Redirects are followed by fetch, so this is the browser hitting consent
    // and being bounced to the plugin's own loopback listener.
    const consent = await fetch(authUrl)
    const text = await consent.text()
    check('回调页提示授权完成', text.includes('授权完成'), text.slice(0, 120))
    check('AS 收到了 token 请求', await settle(() => tokenCalls >= 1), tokenCalls)
    check('凭据写回了 profile headers', await settle(() => headerWrites.length >= 1))
    const write = headerWrites.at(-1)
    check('写入的是 Bearer token', /^Bearer at-/u.test(write?.headers.authorization ?? ''), JSON.stringify(write))
  }

  console.log('\n4. 授权后的状态与落盘')
  {
    const { body } = await get('/status?server=demo')
    check('authorized=true', body.authorized === true, JSON.stringify(body))
    check('daysLeft 有值', typeof body.daysLeft === 'number', body.daysLeft)
    check('scope 保留', body.scope === 'demo:read', body.scope)
    const file = join(HOME, 'secrets', 'mcp-oauth', 'demo.json')
    // Windows has no POSIX mode bits: stat reports 666 for every file.
    if (process.platform === 'win32') {
      check('token 文件权限（Windows 无 POSIX 权限，跳过）', true)
    } else {
      const mode = (await stat(file)).mode & 0o777
      check('token 文件 0600', mode === 0o600, mode.toString(8))
    }
    const record = JSON.parse(await readFile(file, 'utf8'))
    check('落盘含 refresh_token', typeof record.refreshToken === 'string')
  }

  console.log('\n5. 断开：删除凭据并清空 headers')
  {
    const { status } = await post('/disconnect', { server: 'demo' })
    check('HTTP 200', status === 200, status)
    check('headers 被清空', await settle(() => headerWrites.at(-1)?.headers?.authorization === undefined))
    const { body } = await get('/status?server=demo')
    check('回到未授权', body.authorized === false, JSON.stringify(body))
  }

  console.log('\n6. 过期令牌自动续期')
  {
    const dir = join(HOME, 'secrets', 'mcp-oauth')
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, 'demo.json'),
      JSON.stringify({
        server: 'demo',
        mcpUrl: `${base}/mcp`,
        clientId: 'client-seed',
        redirectUri: `http://127.0.0.1:${CALLBACK_PORT}/oauth/callback`,
        scope: 'demo:read',
        tokenType: 'Bearer',
        accessToken: 'at-stale',
        refreshToken: 'rt-seed',
        expiresAt: Date.now() - 60_000,
        obtainedAt: new Date(Date.now() - 7_200_000).toISOString(),
      }),
    )
    issued.refresh.set('rt-seed', true)
    const before = tokenCalls
    const { body } = await get('/status?server=demo')
    check('续期成功', body.authorized === true && body.refreshed === true, JSON.stringify(body))
    check('确实调了 token 端点', tokenCalls > before, `${before} → ${tokenCalls}`)
    check('新 token 写回 headers', /^Bearer at-/u.test(headerWrites.at(-1)?.headers.authorization ?? ''))
    const record = JSON.parse(await readFile(join(dir, 'demo.json'), 'utf8'))
    check('落盘已更新', record.expiresAt > Date.now(), record.expiresAt)
  }

  console.log('\n7. 过期且无 refresh_token → 标记过期')
  {
    const dir = join(HOME, 'secrets', 'mcp-oauth')
    await writeFile(
      join(dir, 'demo.json'),
      JSON.stringify({
        server: 'demo',
        mcpUrl: `${base}/mcp`,
        clientId: 'client-seed',
        redirectUri: `http://127.0.0.1:${CALLBACK_PORT}/oauth/callback`,
        scope: 'demo:read',
        tokenType: 'Bearer',
        accessToken: 'at-stale',
        refreshToken: null,
        expiresAt: Date.now() - 60_000,
        obtainedAt: new Date(Date.now() - 7_200_000).toISOString(),
      }),
    )
    const { body } = await get('/status?server=demo')
    check('authorized=false', body.authorized === false, JSON.stringify(body))
    check('expired=true', body.expired === true, JSON.stringify(body))
  }

  console.log('\n8. 端点没有 OAuth 元数据时明确报错')
  {
    const bare = createServer((request, response) => {
      response.writeHead(401, { 'content-type': 'text/plain' }).end('nope')
    })
    await new Promise(resolve => bare.listen(0, '127.0.0.1', resolve))
    const url = `http://127.0.0.1:${bare.address().port}/mcp`
    const { status, body } = await post('/start', { server: 'bare', mcpUrl: url })
    bare.close()
    check('HTTP 400', status === 400, `${status} ${JSON.stringify(body)}`)
    check('错误码 flow-failed', body.error === 'flow-failed', JSON.stringify(body))
    check('说明缺少 resource_metadata', /resource_metadata/u.test(body.message ?? ''), body.message)
  }

  console.log('\n9. 参数校验')
  {
    check('缺 server → 400', (await post('/start', { mcpUrl: `${base}/mcp` })).status === 400)
    check('非 http url → 400', (await post('/start', { server: 'x', mcpUrl: 'file:///etc/passwd' })).status === 400)
    check('未知子路由 → 404', (await get('/zorp')).status === 404)
  }
} finally {
  dispose()
  as.close()
  plugin.close()
  await rm(HOME, { recursive: true, force: true })
}

console.log(failures === 0 ? '\n所有 OAuth 授权检查通过。\n' : `\n${failures} 项检查失败。\n`)
process.exit(failures === 0 ? 0 : 1)
