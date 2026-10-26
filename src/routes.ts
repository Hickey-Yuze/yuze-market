/**
 * HTTP routes exposed by the Node half.
 *
 * Every route lives under `/api/qurwork-market/`. The Client half talks to the
 * Host over these routes only; the renderer never reaches the market backend
 * directly, so all validation, size limits and install side effects stay on
 * the Host side.
 *
 * Mutating routes require a same-origin request.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { MarketApiClient, MarketError } from './market-api.js'
import { installPlugin, listInstalledPlugins, type PnpmRunner } from './plugin-install.js'
import { installSkill, listInstalledSkills } from './skill-install.js'
import type { ApiError, InstallResult } from './shared/types.js'

const ROUTE_PREFIX = '/api/qurwork-market'
const MAX_BODY_BYTES = 16 * 1024

/**
 * Rolling record of the most recent list requests.
 *
 * The renderer and the Host can disagree about what a list request looks
 * like, and the symptom (an empty list with no error) is otherwise silent.
 * Recording the raw query and the resulting counts makes the disagreement
 * observable from the Host without a debugger.
 */
export interface ListTrace {
  readonly path: string
  readonly query: string
  readonly ok: boolean
  readonly count: number
  readonly error?: string
  readonly at: string
}

const MAX_TRACES = 30
const traces: ListTrace[] = []

function recordTrace(trace: ListTrace): void {
  traces.unshift(trace)
  if (traces.length > MAX_TRACES) traces.length = MAX_TRACES
}

export interface RouteServices {
  readonly market: MarketApiClient
  readonly pnpm: PnpmRunner
  /** Directory that holds the DSH user skills, e.g. `~/.dsh/skills`. */
  readonly skillRoot: string
  /** Directory the plugins are installed into, i.e. the active profile. */
  readonly profileDir: string
  /** Where the install receipts are written. */
  readonly receiptDir: string
  /** npm registry used for plugin installs. */
  readonly registry?: string
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  response.statusCode = status
  response.setHeader('cache-control', 'no-store')
  response.setHeader('content-type', 'application/json; charset=utf-8')
  response.setHeader('x-content-type-options', 'nosniff')
  response.end(body)
}

function sendError(response: ServerResponse, status: number, error: string, code?: string): void {
  const payload: ApiError = code === undefined ? { error } : { error, code }
  sendJson(response, status, payload)
}

/** Reject cross-origin mutations; the market only accepts same-origin calls. */
function isSameOrigin(request: IncomingMessage): boolean {
  const origin = request.headers.origin
  if (origin === undefined) return true
  const host = request.headers.host
  if (host === undefined) return false
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
    size += buffer.length
    if (size > MAX_BODY_BYTES) throw new Error('request body too large')
    chunks.push(buffer)
  }
  if (size === 0) return {}
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
    return value as Record<string, unknown>
  } catch {
    return {}
  }
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function readNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** Resolve the DSH home directory the same way the Host does. */
export function resolveDshHome(explicit?: string): string {
  const fromEnv = process.env.DSH_HOME
  if (fromEnv !== undefined && fromEnv.length > 0) return resolve(fromEnv)
  if (explicit !== undefined && explicit.length > 0) return resolve(explicit)
  return resolve(join(homedir(), '.dsh'))
}

/** Mount every market route on the host web server. */
export function mountMarketRoutes(
  register: (route: { kind: 'exact' | 'prefix'; path: string; handler: (request: IncomingMessage, response: ServerResponse) => void }) => () => void,
  services: RouteServices,
): () => void {
  const disposers: (() => void)[] = []

  const add = (
    path: string,
    handler: (request: IncomingMessage, response: ServerResponse) => void,
  ): void => {
    disposers.push(register({ kind: 'exact', path, handler }))
  }

  add(`${ROUTE_PREFIX}/skill/categories`, (request, response) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.statusCode = 405
      response.setHeader('allow', 'GET, HEAD')
      response.end('method not allowed')
      return
    }
    services.market.listSkillCategories()
      .then(payload => sendJson(response, 200, payload))
      .catch((error: unknown) => {
        sendError(response, 502, error instanceof Error ? error.message : '请求失败', 'upstream-failed')
      })
  })

  add(`${ROUTE_PREFIX}/skill/list`, (request, response) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.statusCode = 405
      response.setHeader('allow', 'GET, HEAD')
      response.end('method not allowed')
      return
    }
    const url = new URL(request.url ?? '/', 'http://localhost')
    services.market.listSkills({
      page: Number(url.searchParams.get('page') ?? '1') || 1,
      pageSize: Number(url.searchParams.get('pageSize') ?? '50') || 50,
      category: url.searchParams.get('category') ?? undefined,
      keyword: url.searchParams.get('keyword') ?? undefined,
    })
      .then(payload => {
        recordTrace({
          path: '/skill/list',
          query: url.search,
          ok: true,
          count: payload.items.length,
          at: new Date().toISOString(),
        })
        sendJson(response, 200, payload)
      })
      .catch((error: unknown) => {
        recordTrace({
          path: '/skill/list',
          query: url.search,
          ok: false,
          count: 0,
          ...(error instanceof Error ? { error: error.message } : {}),
          at: new Date().toISOString(),
        })
        sendError(response, 502, error instanceof Error ? error.message : '请求失败', 'upstream-failed')
      })
  })

  add(`${ROUTE_PREFIX}/plugin/categories`, (request, response) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.statusCode = 405
      response.setHeader('allow', 'GET, HEAD')
      response.end('method not allowed')
      return
    }
    services.market.listPluginCategories()
      .then(payload => sendJson(response, 200, payload))
      .catch((error: unknown) => {
        sendError(response, 502, error instanceof Error ? error.message : '请求失败', 'upstream-failed')
      })
  })

  add(`${ROUTE_PREFIX}/plugin/list`, (request, response) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.statusCode = 405
      response.setHeader('allow', 'GET, HEAD')
      response.end('method not allowed')
      return
    }
    const url = new URL(request.url ?? '/', 'http://localhost')
    services.market.listPlugins({
      page: Number(url.searchParams.get('page') ?? '1') || 1,
      pageSize: Number(url.searchParams.get('pageSize') ?? '50') || 50,
      category: url.searchParams.get('category') ?? undefined,
      keyword: url.searchParams.get('keyword') ?? undefined,
    })
      .then(payload => {
        recordTrace({
          path: '/plugin/list',
          query: url.search,
          ok: true,
          count: payload.items.length,
          at: new Date().toISOString(),
        })
        sendJson(response, 200, payload)
      })
      .catch((error: unknown) => {
        recordTrace({
          path: '/plugin/list',
          query: url.search,
          ok: false,
          count: 0,
          ...(error instanceof Error ? { error: error.message } : {}),
          at: new Date().toISOString(),
        })
        sendError(response, 502, error instanceof Error ? error.message : '请求失败', 'upstream-failed')
      })
  })

  add(`${ROUTE_PREFIX}/diagnostics`, (request, response) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.statusCode = 405
      response.setHeader('allow', 'GET, HEAD')
      response.end('method not allowed')
      return
    }
    sendJson(response, 200, { traces })
  })

  add(`${ROUTE_PREFIX}/installed/skills`, (request, response) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.statusCode = 405
      response.setHeader('allow', 'GET, HEAD')
      response.end('method not allowed')
      return
    }
    listInstalledSkills(services.skillRoot)
      .then(items => sendJson(response, 200, { items }))
      .catch((error: unknown) => {
        sendError(response, 500, error instanceof Error ? error.message : '读取失败', 'read-failed')
      })
  })

  add(`${ROUTE_PREFIX}/installed/plugins`, (request, response) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.statusCode = 405
      response.setHeader('allow', 'GET, HEAD')
      response.end('method not allowed')
      return
    }
    listInstalledPlugins(services.profileDir)
      .then(items => sendJson(response, 200, { items }))
      .catch((error: unknown) => {
        sendError(response, 500, error instanceof Error ? error.message : '读取失败', 'read-failed')
      })
  })

  add(`${ROUTE_PREFIX}/skill/install`, (request, response) => {
    if (request.method !== 'POST') {
      response.statusCode = 405
      response.setHeader('allow', 'POST')
      response.end('method not allowed')
      return
    }
    if (!isSameOrigin(request)) {
      sendError(response, 403, '跨站请求被拒绝', 'cross-origin')
      return
    }
    void (async () => {
      const body = await readJsonBody(request)
      const url = readString(body, 'url')
      const name = readString(body, 'name')
      const version = readString(body, 'version')
      if (url === undefined || name === undefined) {
        sendError(response, 400, '缺少技能地址或名称', 'bad-request')
        return
      }
      const outcome = await installSkill({
        skillRoot: services.skillRoot,
        entry: {
          id: readNumber(body, 'id') ?? 0,
          name,
          nameCn: readString(body, 'nameCn') ?? name,
          description: readString(body, 'description') ?? '',
          version: version ?? '0.0.0',
          tags: [],
          categories: [],
          author: readString(body, 'author') ?? '',
          url,
        },
      })
      await recordReceipt(services.receiptDir, outcome.result)
      sendJson(response, outcome.result.ok ? 200 : 400, outcome.result)
    })().catch((error: unknown) => {
      const code = error instanceof MarketError ? error.code : 'install-failed'
      const message = error instanceof Error ? error.message : String(error)
      const result: InstallResult = { ok: false, target: '', kind: 'skill', code, message }
      sendJson(response, 500, result)
    })
  })

  add(`${ROUTE_PREFIX}/plugin/install`, (request, response) => {
    if (request.method !== 'POST') {
      response.statusCode = 405
      response.setHeader('allow', 'POST')
      response.end('method not allowed')
      return
    }
    if (!isSameOrigin(request)) {
      sendError(response, 403, '跨站请求被拒绝', 'cross-origin')
      return
    }
    void (async () => {
      const body = await readJsonBody(request)
      const url = readString(body, 'downloadUrl')
      const name = readString(body, 'name')
      const version = readString(body, 'version')
      if (url === undefined || name === undefined || version === undefined) {
        sendError(response, 400, '缺少插件地址、名称或版本', 'bad-request')
        return
      }
      const outcome = await installPlugin({
        entry: {
          id: readNumber(body, 'id') ?? 0,
          name,
          nameCn: readString(body, 'nameCn') ?? name,
          version,
          description: readString(body, 'description') ?? '',
          author: readString(body, 'author') ?? '',
          tags: [],
          keywords: [],
          downloadUrl: url,
        },
        profileDir: services.profileDir,
        pnpm: services.pnpm,
        ...(services.registry === undefined ? {} : { registry: services.registry }),
      })
      await recordReceipt(services.receiptDir, outcome.result)
      sendJson(response, outcome.result.ok ? 200 : 400, outcome.result)
    })().catch((error: unknown) => {
      const code = error instanceof MarketError ? error.code : 'install-failed'
      const message = error instanceof Error ? error.message : String(error)
      const result: InstallResult = { ok: false, target: '', kind: 'plugin', code, message }
      sendJson(response, 500, result)
    })
  })

  return () => {
    for (const dispose of disposers.splice(0)) dispose()
  }
}

async function recordReceipt(receiptDir: string, result: InstallResult): Promise<void> {
  try {
    await mkdir(receiptDir, { recursive: true, mode: 0o700 })
    const file = join(receiptDir, `${result.kind}-${result.target || 'unknown'}.json`)
    await writeFile(file, JSON.stringify({ ...result, at: new Date().toISOString() }, null, 2), { mode: 0o600 })
  } catch {
    // A missing receipt must never fail an otherwise successful install.
  }
}

/** Read the DSH home from the host, falling back to the environment. */
export async function readDshHomeMarker(): Promise<string | undefined> {
  const candidate = join(resolveDshHome(), 'settings.yaml')
  try {
    await readFile(candidate, 'utf8')
    return resolveDshHome()
  } catch {
    return undefined
  }
}
