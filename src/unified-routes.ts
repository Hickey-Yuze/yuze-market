/**
 * The 市场 API: one surface for four tabs, under its own prefix.
 *
 * The older `/api/yuze-market/*` and `/api/workbuddy-market/*` routes stay
 * as they are (installs and receipts already work through them), but the panel
 * talks to this one because everything it needs is keyed by a single id:
 *
 *   GET  /items       merged catalogue for one tab
 *   GET  /art         brand artwork for one id (disk bytes or CDN redirect)
 *   GET  /installed   skills, experts, connectors and plugins in one payload
 *   POST /install     install by id, whichever upstream it came from
 *   POST /enable      show/hide one skill or expert
 *   POST /remove      delete one skill or expert (kept under .trash)
 *   POST /connector   enable/disable or remove one MCP entry
 *   POST /plugin      enable/disable or remove one plugin
 *   POST /manual      install by hand from a path, zip, JSON body or npm spec
 *
 * Mutations require a same-origin request, mirroring the install routes.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'

import { Aggregator, parseLocalId, type SortMode, type Tab } from './aggregate.js'
import { resolveArt } from './art.js'
import {
  installConnectorManually,
  installPluginManually,
  installSkillManually,
  type ManualInstallResult,
} from './manual.js'
import { listManaged, removeManaged, setManagedEnabled, listTrash } from './managed.js'
import { installMarketExpert } from './market-expert-install.js'
import { downloadExpertSnapshot, expertSnapshotProgress, isSnapshotRunning } from './snapshot.js'
import type { MarketApiClient } from './market-api.js'
import type { PnpmRunner } from './plugin-install.js'
import { installPlugin } from './plugin-install.js'
import { listManagedPlugins, setPluginEnabled, uninstallPlugin } from './plugin-managed.js'
import { installSkill } from './skill-install.js'
import { mkdir, writeFile } from 'node:fs/promises'
import type { MarketCatalog } from './wb/catalog.js'
import { installItem, type InstallDeps } from './wb/install.js'
import {
  findConnectorUrl,
  listInstalledConnectors,
  setConnectorEnabled,
  uninstallConnectorMcp,
} from './wb/mcp-install.js'

export const ROUTE_PREFIX = '/api/yuze-market'
const MAX_BODY_BYTES = 32 * 1024

export interface UnifiedDeps {
  readonly aggregator: Aggregator
  readonly catalog: MarketCatalog
  readonly market: MarketApiClient
  readonly cacheRoot: string
  readonly skillRoot: string
  readonly profileDir: string
  readonly profileName: string
  /** The profile's `cordis.patch.yml`, where MCP entries live. */
  readonly profilePath: string
  readonly backupDir: string
  readonly receiptDir: string
  readonly pnpm: PnpmRunner
  readonly registry?: string
}

interface Route {
  readonly kind: 'exact' | 'prefix'
  readonly path: string
  readonly handler: (request: IncomingMessage, response: ServerResponse) => void
}

type Body = Record<string, unknown>

export function mountUnifiedRoutes(register: (route: Route) => () => void, deps: UnifiedDeps): () => void {
  const mcpDeps = { profilePath: deps.profilePath, backupDir: deps.backupDir }
  const installDeps: InstallDeps = {
    ...mcpDeps,
    cacheRoot: deps.cacheRoot,
    skillRoot: deps.skillRoot,
  }

  async function dispatch(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!isSameOrigin(request)) {
      sendJson(response, 403, { error: 'forbidden', message: '跨站请求被拒绝' })
      return
    }

    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const tail = url.pathname.slice(ROUTE_PREFIX.length).replace(/^\/+|\/+$/gu, '')
    const method = (request.method ?? 'GET').toUpperCase()

    try {
      if (tail === 'items' && method === 'GET') {
        const tab = parseTab(url.searchParams.get('tab'))
        if (tab === undefined) {
          sendJson(response, 400, { error: 'bad-tab', message: 'tab 必须是 skill / expert / connector / plugin' })
          return
        }
        sendJson(
          response,
          200,
          await deps.aggregator.list({
            tab,
            q: url.searchParams.get('q') ?? '',
            category: url.searchParams.get('category') ?? '',
            page: Number(url.searchParams.get('page') ?? '1') || 1,
            pageSize: Number(url.searchParams.get('pageSize') ?? '60') || 60,
            sort: parseSort(url.searchParams.get('sort')),
          }),
        )
        return
      }

      if (tail === 'art' && method === 'GET') {
        const id = url.searchParams.get('id') ?? ''
        if (id.length === 0) {
          sendJson(response, 400, { error: 'bad-request', message: '缺少 id' })
          return
        }
        const local = parseLocalId(id)
        if (local === undefined) {
          // Remote entries have no local artwork yet; the panel falls back to an
          // emoji/initial tile rather than requesting a file that cannot exist.
          sendJson(response, 404, { error: 'no-art' })
          return
        }
        const art = await resolveArt(deps.catalog, deps.cacheRoot, local.kind, local.catalogId)
        if (art.kind === 'redirect' && art.location !== undefined) {
          response.writeHead(302, { location: art.location, 'cache-control': 'public, max-age=86400' })
          response.end()
          return
        }
        if (art.kind === 'bytes' && art.bytes !== undefined) {
          response.writeHead(200, {
            'content-type': art.contentType ?? 'application/octet-stream',
            'cache-control': 'public, max-age=86400',
            'x-content-type-options': 'nosniff',
          })
          response.end(art.bytes)
          return
        }
        sendJson(response, 404, { error: 'no-art' })
        return
      }

      if (tail === 'installed' && method === 'GET') {
        const [skills, connectors, plugins, trash] = await Promise.all([
          listManaged(deps.skillRoot),
          listInstalledConnectors(mcpDeps),
          listManagedPlugins({ profileDir: deps.profileDir }),
          listTrash(deps.skillRoot),
        ])
        // Installed rows are decorated with their catalogue artwork so the
        // 「已安装」view can show the same tiles as the market grid.
        const { items: catalogItems } = await deps.catalog.snapshot()
        const idByKindName = new Map(catalogItems.map(entry => [`${entry.kind}:${entry.name}`, entry.id]))
        const titleByKindName = new Map(catalogItems.map(entry => [`${entry.kind}:${entry.name}`, entry.title]))
        const withArt = skills.map(entry => {
          const kind = entry.kind === 'expert' ? 'expert' : 'skill'
          const direct = entry.marketId === undefined ? undefined : `${kind}:${entry.marketId}`
          const byName = idByKindName.get(`${kind}:${entry.name}`)
          const catalogId = direct !== undefined && catalogItems.some(item => item.id === direct) ? direct : byName
          return catalogId === undefined
            ? entry
            : { ...entry, artUrl: `/api/yuze-market/art?id=${encodeURIComponent(`local:${catalogId}`)}` }
        })
        const connectorsWithArt = connectors.map(entry => {
          const key = `connector:${entry.serverName}`
          const catalogId = idByKindName.get(key)
          const title = titleByKindName.get(key)
          return {
            ...entry,
            ...(title === undefined ? {} : { title }),
            ...(catalogId === undefined
              ? {}
              : { artUrl: `/api/yuze-market/art?id=${encodeURIComponent(`local:${catalogId}`)}` }),
          }
        })
        sendJson(response, 200, { skills: withArt, connectors: connectorsWithArt, plugins, trash })
        return
      }

      if (tail === 'install' && method === 'POST') {
        const body = await readJson(request)
        const id = typeof body?.id === 'string' ? body.id : ''
        if (id.length === 0) {
          sendJson(response, 400, { error: 'bad-request', message: '缺少 id' })
          return
        }
        sendJson(response, 200, await installById(id, deps, installDeps))
        return
      }

      if (tail === 'enable' && method === 'POST') {
        const body = await readJson(request)
        const name = typeof body?.name === 'string' ? body.name : ''
        const enabled = body?.enabled === true
        if (name.length === 0) {
          sendJson(response, 400, { error: 'bad-request', message: '缺少 name' })
          return
        }
        const outcome = await setManagedEnabled(deps.skillRoot, name, enabled)
        sendJson(response, outcome.ok ? 200 : 409, {
          ok: outcome.ok,
          ...(outcome.code === undefined ? {} : { code: outcome.code }),
          ...(outcome.message === undefined ? {} : { message: outcome.message }),
        })
        return
      }

      if (tail === 'remove' && method === 'POST') {
        const body = await readJson(request)
        const name = typeof body?.name === 'string' ? body.name : ''
        if (name.length === 0) {
          sendJson(response, 400, { error: 'bad-request', message: '缺少 name' })
          return
        }
        const outcome = await removeManaged(deps.skillRoot, name)
        sendJson(response, outcome.ok ? 200 : 409, {
          ok: outcome.ok,
          ...(outcome.code === undefined ? {} : { code: outcome.code }),
          ...(outcome.message === undefined ? {} : { message: outcome.message }),
        })
        return
      }

      if (tail === 'connector' && method === 'POST') {
        const body = await readJson(request)
        const serverName = typeof body?.serverName === 'string' ? body.serverName : ''
        if (serverName.length === 0) {
          sendJson(response, 400, { error: 'bad-request', message: '缺少 serverName' })
          return
        }
        const result =
          body?.remove === true
            ? await uninstallConnectorMcp(`mcp-wbm-${serverName}`, mcpDeps)
            : await setConnectorEnabled(serverName, body?.enabled !== false, mcpDeps)
        sendJson(response, result.ok ? 200 : 409, result)
        return
      }

      if (tail === 'plugin' && method === 'POST') {
        const body = await readJson(request)
        const packageName = typeof body?.packageName === 'string' ? body.packageName : ''
        if (packageName.length === 0) {
          sendJson(response, 400, { error: 'bad-request', message: '缺少 packageName' })
          return
        }
        const options = {
          profileDir: deps.profileDir,
          profileName: deps.profileName,
          pnpm: deps.pnpm,
          ...(deps.registry === undefined ? {} : { registry: deps.registry }),
        }
        const outcome =
          body?.remove === true
            ? await uninstallPlugin(options, packageName)
            : await setPluginEnabled(options, packageName, body?.enabled !== false)
        sendJson(response, outcome.ok ? 200 : 409, outcome)
        return
      }

      if (tail === 'snapshot/experts' && method === 'POST') {
        // Runs in the background: the transfer can take minutes on a slow link,
        // and holding the HTTP response open would time out on the way.
        if (isSnapshotRunning()) {
          sendJson(response, 202, { started: true, alreadyRunning: true })
          return
        }
        void downloadExpertSnapshot(deps.cacheRoot).catch(() => undefined)
        sendJson(response, 202, { started: true })
        return
      }

      if (tail === 'snapshot/experts/progress' && method === 'GET') {
        sendJson(response, 200, expertSnapshotProgress())
        return
      }

      if (tail === 'manual' && method === 'POST') {
        const body = await readJson(request)
        const target = typeof body?.target === 'string' ? body.target : ''
        sendJson(response, 200, await manualInstall(target, body ?? {}, deps, mcpDeps))
        return
      }

      sendJson(response, 404, { error: 'not-found' })
    } catch (cause) {
      sendJson(response, 500, { error: 'internal', message: cause instanceof Error ? cause.message : String(cause) })
    }
  }

  const disposers = [
    register({
      kind: 'prefix',
      path: ROUTE_PREFIX,
      handler: (request, response) => {
        void dispatch(request, response)
      },
    }),
  ]
  return () => {
    for (const dispose of disposers) dispose()
  }
}

// ------------------------------------------------------------------ install

async function installById(id: string, deps: UnifiedDeps, installDeps: InstallDeps): Promise<unknown> {
  // `skillfile:<name>` — a skill that ships inside a local WorkBuddy marketplace
  // package; installing it copies the directory instead of downloading a zip.
  if (id.startsWith('skillfile:')) {
    const name = id.slice('skillfile:'.length)
    const raw = await deps.aggregator.rawLocalSkill(name)
    if (raw === undefined || typeof raw.dir !== 'string') {
      return { ok: false, kind: 'skill', target: id, code: 'not-found', message: '本地市场里没有这个技能，请重新同步' }
    }
    const outcome = await installSkillManually({ source: raw.dir, skillRoot: deps.skillRoot, name })
    await recordReceipt(deps.receiptDir, { kind: 'skill', target: name })
    return outcome
  }

  // `market:expert:<expert_id>` — a cloud expert whose zip URL was captured at
  // sync time (see scripts/sync-workbuddy-experts.mjs).
  if (id.startsWith('market:expert:')) {
    const expertId = id.slice('market:expert:'.length)
    const raw = await deps.aggregator.rawMarketExpert(expertId)
    if (raw === undefined || typeof raw.download_url !== 'string') {
      return {
        ok: false,
        kind: 'skill',
        target: id,
        code: 'no-download',
        message: '该专家没有可用的下载地址，请先运行 sync:experts 同步',
      }
    }
    const outcome = await installMarketExpert(
      {
        expertId,
        agentName: raw.agent_name ?? raw.source_id ?? expertId,
        title: raw.profession_zh ?? raw.display_name_zh ?? expertId,
        description: raw.description_zh ?? '',
        profession: raw.profession_zh ?? '',
        ...(raw.version === undefined ? {} : { version: raw.version }),
        downloadUrl: raw.download_url,
        expiresAt: typeof raw.download_expires_at === 'number' ? raw.download_expires_at : null,
      },
      deps.skillRoot,
    )
    await recordReceipt(deps.receiptDir, outcome.result)
    return outcome.result
  }

  const local = parseLocalId(id)
  if (local !== undefined) {
    const item = await deps.aggregator.rawLocal(local.kind, local.catalogId)
    if (item === undefined) {
      return { ok: false, kind: local.kind, target: id, code: 'not-found', message: '目录里没有这个条目' }
    }
    const result = await installItem(item, installDeps)
    await recordReceipt(deps.receiptDir, result)
    return result
  }

  const [origin, tab, ...rest] = id.split(':')
  const upstreamId = rest.join(':')

  if (origin === 'quwork' && tab === 'skill') {
    const entry = await deps.aggregator.rawSkill(upstreamId)
    if (entry === undefined) {
      return { ok: false, kind: 'skill', target: id, code: 'not-found', message: '市场里没有这个技能' }
    }
    const outcome = await installSkill({ skillRoot: deps.skillRoot, entry })
    await recordReceipt(deps.receiptDir, outcome.result)
    return outcome.result
  }

  if (origin === 'quwork' && tab === 'plugin') {
    const entry = await deps.aggregator.rawPlugin(upstreamId)
    if (entry === undefined) {
      return { ok: false, kind: 'plugin', target: id, code: 'not-found', message: '市场里没有这个插件' }
    }
    const outcome = await installPlugin({
      entry,
      profileDir: deps.profileDir,
      pnpm: deps.pnpm,
      ...(deps.registry === undefined ? {} : { registry: deps.registry }),
    })
    await recordReceipt(deps.receiptDir, outcome.result)
    return outcome.result
  }

  return { ok: false, kind: 'skill', target: id, code: 'bad-id', message: '无法识别的条目' }
}

// ------------------------------------------------------------------- manual

async function manualInstall(
  target: string,
  body: Body,
  deps: UnifiedDeps,
  mcpDeps: { profilePath: string; backupDir: string },
): Promise<ManualInstallResult> {
  if (target === 'skill' || target === 'expert') {
    return await installSkillManually({
      source: typeof body.path === 'string' ? body.path : '',
      skillRoot: deps.skillRoot,
      ...(typeof body.name === 'string' && body.name.length > 0 ? { name: body.name } : {}),
    })
  }
  if (target === 'connector') {
    return await installConnectorManually({
      json: typeof body.json === 'string' ? body.json : '',
      deps: mcpDeps,
    })
  }
  if (target === 'plugin') {
    return await installPluginManually({
      spec: typeof body.spec === 'string' ? body.spec : '',
      profileDir: deps.profileDir,
      pnpm: deps.pnpm,
      ...(deps.registry === undefined ? {} : { registry: deps.registry }),
    })
  }
  return { ok: false, kind: 'skill', target, code: 'bad-request', message: '未知的安装目标' }
}

// ------------------------------------------------------------------ helpers

function parseSort(value: string | null): SortMode {
  return value === 'usage' || value === 'name' ? value : 'reco'
}

function parseTab(value: string | null): Tab | undefined {
  return value === 'skill' || value === 'expert' || value === 'connector' || value === 'plugin'
    ? value
    : undefined
}

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

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  response.end(payload)
}

async function readJson(request: IncomingMessage): Promise<Body | null> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > MAX_BODY_BYTES) return null
    chunks.push(buffer)
  }
  if (chunks.length === 0) return null
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
    return typeof parsed === 'object' && parsed !== null ? (parsed as Body) : null
  } catch {
    return null
  }
}

/** Mirror the install route's receipt so both surfaces leave the same trace. */
async function recordReceipt(
  receiptDir: string,
  result: { kind: string; target?: string },
): Promise<void> {
  try {
    await mkdir(receiptDir, { recursive: true, mode: 0o700 })
    const file = join(receiptDir, `${result.kind}-${result.target ?? 'unknown'}.json`)
    await writeFile(file, JSON.stringify({ ...result, at: new Date().toISOString() }, null, 2), { mode: 0o600 })
  } catch {
    // A missing receipt must never fail an otherwise successful install.
  }
}

/** Exposed for the diagnostics route: where this API's cache lives. */
export function describeDeps(deps: UnifiedDeps): Record<string, string> {
  return {
    cacheRoot: deps.cacheRoot,
    skillRoot: deps.skillRoot,
    profileDir: deps.profileDir,
    profilePatch: join(deps.profileDir, 'cordis.patch.yml'),
  }
}
