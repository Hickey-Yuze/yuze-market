/**
 * HTTP surface for the market panel.
 *
 * Mounted on the host web server at `/api/workbuddy-market`. Every route is
 * same-origin only and returns JSON; nothing is cached because the catalog and
 * the installed-skill list both change underneath the panel.
 */

import { readdir, readFile, rm, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import type { MarketCatalog } from './catalog.js'
import type { InstallDeps } from './install.js'
import { installItem } from './install.js'
import { MCP_ENTRY_PREFIX, listInstalledConnectors, uninstallConnectorMcp } from './mcp-install.js'
import type {
  ApiError,
  InstalledSkill,
  InstallResult,
  ListResponse,
  MarketKind,
} from './types.js'

export const ROUTE_PREFIX = '/api/workbuddy-market'

const MAX_BODY_BYTES = 16 * 1024

export interface RouteDeps extends InstallDeps {
  readonly catalog: MarketCatalog
}

interface WebRoute {
  kind: 'exact' | 'prefix'
  path: string
  handler(request: IncomingLike, response: ServerResponseLike): Promise<void> | void
}

interface IncomingLike {
  method?: string
  url?: string
  headers: Record<string, string | string[] | undefined>
  on(event: 'data', listener: (chunk: Buffer | string) => void): unknown
  on(event: 'end', listener: () => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
}

interface ServerResponseLike {
  statusCode: number
  setHeader(name: string, value: string): void
  end(chunk?: string | Uint8Array): void
}

export function mountMarketRoutes(
  register: (route: WebRoute) => unknown,
  deps: RouteDeps,
): () => void {
  const undo = register({
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: (request, response) => dispatch(request, response, deps),
  })
  return typeof undo === 'function' ? (undo as () => void) : () => {}
}

async function dispatch(
  request: IncomingLike,
  response: ServerResponseLike,
  deps: RouteDeps,
): Promise<void> {
  if (!isSameOrigin(request)) {
    sendError(response, 403, '跨站请求被拒绝', 'forbidden')
    return
  }

  const url = new URL(request.url ?? '/', 'http://127.0.0.1')
  const path = url.pathname
  const method = (request.method ?? 'GET').toUpperCase()

  try {
    if (path === `${ROUTE_PREFIX}/list` && method === 'GET') {
      const kind = parseKind(url.searchParams.get('kind'))
      if (kind === undefined) {
        sendError(response, 400, 'kind 必须是 expert / skill / connector', 'bad-kind')
        return
      }
      const payload: ListResponse = await deps.catalog.query({
        kind,
        q: url.searchParams.get('q') ?? '',
        category: url.searchParams.get('category') ?? '',
        page: Number(url.searchParams.get('page') ?? '1'),
        pageSize: Number(url.searchParams.get('pageSize') ?? '60'),
      })
      sendJson(response, 200, payload)
      return
    }

    if (path === `${ROUTE_PREFIX}/install` && method === 'POST') {
      const body = await readJson(request)
      const kind = parseKind(typeof body.kind === 'string' ? body.kind : '')
      const id = typeof body.id === 'string' ? body.id : ''
      if (kind === undefined || id.length === 0) {
        sendError(response, 400, '需要 kind 与 id', 'bad-request')
        return
      }
      const item = await deps.catalog.find(kind, id)
      if (item === undefined) {
        sendError(response, 404, `没有找到 ${id}`, 'not-found')
        return
      }
      const result: InstallResult = await installItem(item, deps)
      sendJson(response, result.ok ? 200 : 409, result)
      return
    }

    if (path === `${ROUTE_PREFIX}/installed` && method === 'GET') {
      const [skills, connectors] = await Promise.all([
        listInstalled(deps.skillRoot),
        listInstalledConnectors(deps),
      ])
      sendJson(response, 200, { items: skills, connectors })
      return
    }

    if (path === `${ROUTE_PREFIX}/icon` && method === 'GET') {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      const id = url.searchParams.get('id') ?? ''
      const item = await deps.catalog.find('connector', id)
      if (item === undefined || item.icon === undefined) {
        sendError(response, 404, '无图标', 'not-found')
        return
      }
      const assetRoot = resolve(
        deps.cacheRoot,
        'mcp-connectors',
        'extracted',
        'connectors',
        item.dirName ?? item.name,
        'ai.workbuddy',
        'assets',
      )
      const file = resolve(assetRoot, item.icon.file)
      // `icon.file` comes from upstream JSON: never let it climb out of the
      // connector's own assets directory.
      if (!file.startsWith(`${assetRoot}/`) && file !== assetRoot) {
        sendError(response, 400, '非法图标路径', 'bad-request')
        return
      }
      try {
        const bytes = await readFile(file)
        response.statusCode = 200
        response.setHeader('content-type', item.icon.format === 'svg' ? 'image/svg+xml' : 'image/png')
        response.setHeader('cache-control', 'public, max-age=86400')
        response.setHeader('x-content-type-options', 'nosniff')
        response.end(bytes)
      } catch {
        sendError(response, 404, '无图标', 'not-found')
      }
      return
    }

    if (path === `${ROUTE_PREFIX}/uninstall` && method === 'POST') {
      const body = await readJson(request)
      const name = typeof body.name === 'string' ? body.name : ''

      // Connector ids are owned by the MCP registry, not by the skills tree.
      if (name.startsWith(MCP_ENTRY_PREFIX)) {
        const result = await uninstallConnectorMcp(name, deps)
        sendJson(response, result.ok ? 200 : 409, result)
        return
      }

      if (!isSafeSegment(name)) {
        sendError(response, 400, '非法技能名', 'bad-request')
        return
      }
      const target = join(deps.skillRoot, name)
      if (!(await exists(target))) {
        sendError(response, 404, `未安装 ${name}`, 'not-found')
        return
      }
      await rm(target, { recursive: true, force: true })
      sendJson(response, 200, { ok: true, target })
      return
    }

    sendError(response, 404, '未知接口', 'not-found')
  } catch (cause) {
    sendError(response, 500, (cause as Error).message, 'internal')
  }
}

// ---------------------------------------------------------------- installed

async function listInstalled(skillRoot: string): Promise<InstalledSkill[]> {
  let entries: string[]
  try {
    const dirents = await readdir(skillRoot, { withFileTypes: true })
    entries = dirents.filter(entry => entry.isDirectory()).map(entry => entry.name)
  } catch {
    return []
  }

  const result: InstalledSkill[] = []
  for (const name of entries) {
    const dir = join(skillRoot, name)
    const file = join(dir, 'SKILL.md')
    if (!(await exists(file))) continue

    let description = ''
    try {
      description = parseDescription(await readFile(file, 'utf8'))
    } catch {
      // 读不出描述不影响列出
    }

    let kind: InstalledSkill['kind'] = 'unknown'
    try {
      const marker = JSON.parse(
        await readFile(join(dir, '.workbuddy-market.json'), 'utf8'),
      ) as { kind?: MarketKind }
      if (marker.kind !== undefined) kind = marker.kind
    } catch {
      // 不是本市场装的
    }

    result.push({ name, title: name, description, path: dir, kind })
  }

  return result.sort((a, b) => a.name.localeCompare(b.name))
}

function parseDescription(raw: string): string {
  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw)?.[1]
  if (block === undefined) return ''
  for (const line of block.split(/\r?\n/)) {
    const sep = line.indexOf(':')
    if (sep <= 0) continue
    if (line.slice(0, sep).trim() !== 'description') continue
    return line
      .slice(sep + 1)
      .trim()
      .replace(/^["']|["']$/g, '')
  }
  return ''
}

// ---------------------------------------------------------------- transport

function isSameOrigin(request: IncomingLike): boolean {
  const origin = request.headers.origin
  if (typeof origin !== 'string' || origin.length === 0) return true
  const host = request.headers.host
  if (typeof host !== 'string') return false
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

async function readJson(request: IncomingLike): Promise<Record<string, unknown>> {
  const raw = await readBody(request)
  if (raw.length === 0) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

function readBody(request: IncomingLike): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    request.on('data', (chunk: Buffer | string) => {
      const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
      size += buffer.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('请求体过大'))
        return
      }
      chunks.push(buffer)
    })
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    request.on('error', (error: Error) => reject(error))
  })
}

function sendJson(response: ServerResponseLike, status: number, payload: unknown): void {
  response.statusCode = status
  response.setHeader('content-type', 'application/json;charset=utf-8')
  response.setHeader('cache-control', 'no-store')
  response.setHeader('x-content-type-options', 'nosniff')
  response.end(JSON.stringify(payload))
}

function sendError(
  response: ServerResponseLike,
  status: number,
  error: string,
  code: string,
): void {
  const payload: ApiError = { error, code }
  sendJson(response, status, payload)
}

// ---------------------------------------------------------------- misc

function parseKind(raw: string | null): MarketKind | undefined {
  return raw === 'expert' || raw === 'skill' || raw === 'connector' ? raw : undefined
}

function isSafeSegment(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= 128 &&
    !name.includes('/') &&
    !name.includes('\\') &&
    name !== '.' &&
    name !== '..'
  )
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}
