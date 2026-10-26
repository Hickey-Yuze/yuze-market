/**
 * Node half entry point.
 *
 * Mounts two route families on the host web server:
 *
 * - `/api/qurwork-market/*` — the QuWork skill directory and DSH plugin market
 *   (remote backend, installs into the DSH skill root / profile package.json).
 * - `/api/workbuddy-market/*` — the WorkBuddy expert, skill and connector
 *   catalogue (local JSON cache, connectors install as `dsh-mcp-client`
 *   entries in the profile's `cordis.patch.yml`).
 *
 * The plugin waits for the Host services it needs and stays inert on a host
 * that provides no web server, so importing it can never break a profile boot.
 */

import { readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { MarketApiClient } from './market-api.js'
import { mountMarketRoutes, resolveDshHome } from './routes.js'
import type { PnpmRunner } from './plugin-install.js'
import { MarketCatalog, defaultCatalogPath } from './wb/catalog.js'
import { mountMarketRoutes as mountWorkBuddyRoutes } from './wb/routes.js'
import { Aggregator } from './aggregate.js'
import { mountOAuthRoutes } from './oauth/routes.js'
import { mountUnifiedRoutes } from './unified-routes.js'
import { findConnectorUrl, setConnectorHeaders } from './wb/mcp-install.js'

export const name = 'qurwork-market'

/** Host services this plugin consumes. */
export const inject = ['webServer']

interface WebServerLike {
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse) => void
  }): () => void
}

interface DesktopPnpmLike extends PnpmRunner {}

declare module '@deepseek-ai/cordis' {
  interface Context {
    webServer: WebServerLike
    desktopPnpm?: DesktopPnpmLike
  }
}

export interface QurworkMarketConfig {
  /** Override the market backend base URL. */
  readonly apiBaseUrl?: string
  /** Override the DSH home used to locate the user skill root. */
  readonly dshHome?: string
  /** Override the profile directory plugins are installed into. */
  readonly profileDir?: string
  /** Override the npm registry used for plugin installs. */
  readonly registry?: string
  /** Profile name whose `cordis.patch.yml` receives WorkBuddy connector entries. */
  readonly profile?: string
}

/** Apply the plugin to a cordis context. */
export function apply(ctx: Context, config: QurworkMarketConfig = {}): void {
  ctx.inject(['webServer'], (hostCtx) => {
    const dshHome = resolveDshHome(config.dshHome)
    const skillRoot = join(dshHome, 'skills')
    const receiptDir = join(dshHome, 'qurwork-market')

    const mount = (): (() => void) => {
      const pnpm = hostCtx.get('desktopPnpm')
      const profileDir = config.profileDir ?? resolve(defaultProfileDir(hostCtx))
      const market = new MarketApiClient(config.apiBaseUrl)

      const disposeQurwork = mountMarketRoutes(
        route => hostCtx.webServer.register(route),
        {
          market,
          // Without the host pnpm service there is no safe way to install a
          // plugin, so the route answers with a clear failure instead.
          pnpm: pnpm ?? unavailablePnpm(),
          skillRoot,
          profileDir,
          receiptDir,
          ...(config.registry === undefined ? {} : { registry: config.registry }),
        },
      )

      // WorkBuddy catalogue: experts / skills / connectors. The connector
      // installer edits the profile patch so the host loads them as MCP
      // clients on the next boot.
      const workBuddyCatalog = new MarketCatalog(defaultCatalogPath(dshHome))
      const profilePath = resolveProfilePatch(dshHome, config.profile)
      const backupDir = join(dshHome, 'workbuddy-market', 'backups')
      const disposeWorkBuddy = mountWorkBuddyRoutes(
        route => hostCtx.webServer.register(route),
        {
          catalog: workBuddyCatalog,
          cacheRoot: join(dshHome, 'workbuddy-market', 'cache'),
          skillRoot,
          profilePath,
          backupDir,
        },
      )

      // OAuth connectors (e.g. Tencent Docs) cannot use a static bearer token
      // forever, so the plugin owns the authorization-code + PKCE flow and
      // writes the issued token back into the profile's MCP headers.
      const disposeOAuth = mountOAuthRoutes(route => hostCtx.webServer.register(route), {
        dshHome,
        callbackPort: 17321,
        updateHeaders: (serverName, headers) => setConnectorHeaders(serverName, headers, { profilePath, backupDir }),
        readUrl: serverName => findConnectorUrl(serverName, { profilePath, backupDir }),
      })

      // The panel's own API: four tabs, one item shape, one install entry point.
      const aggregator = new Aggregator({
        catalog: workBuddyCatalog,
        market,
        expertSnapshot: join(dshHome, 'workbuddy-market', 'cache', 'experts-market.json'),
        skillSnapshot: join(dshHome, 'workbuddy-market', 'cache', 'skills-market.json'),
        skillTranslation: join(dshHome, 'workbuddy-market', 'cache', 'skills-zh.json'),
      })
      const disposeUnified = mountUnifiedRoutes(route => hostCtx.webServer.register(route), {
        aggregator,
        catalog: workBuddyCatalog,
        market,
        cacheRoot: join(dshHome, 'workbuddy-market', 'cache'),
        skillRoot,
        profileDir,
        profileName: basename(profileDir),
        profilePath,
        backupDir,
        receiptDir,
        pnpm: pnpm ?? unavailablePnpm(),
        ...(config.registry === undefined ? {} : { registry: config.registry }),
      })

      return () => {
        disposeQurwork()
        disposeWorkBuddy()
        disposeOAuth()
        disposeUnified()
      }
    }

    const dispose = mount()
    ctx.effect(() => dispose, 'yuze-market: http routes')
  })
}

/**
 * Resolve the profile patch file that WorkBuddy connector installs write into.
 *
 * A profile is whichever directory under `<dshHome>/profiles` owns a
 * `cordis.patch.yml`; when several do, the most recently written one is the
 * profile the user is actually running. An explicit name always wins so a
 * multi-profile host can target `work` without touching `desktop`.
 */
export function resolveProfilePatch(dshHome: string, override?: string): string {
  const name = override ?? process.env.DSH_PROFILE
  if (name !== undefined && name.length > 0) {
    return join(dshHome, 'profiles', name, 'cordis.patch.yml')
  }

  const root = join(dshHome, 'profiles')
  let best: { path: string; mtime: number } | null = null
  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const candidate = join(root, entry.name, 'cordis.patch.yml')
      try {
        const info = statSync(candidate)
        if (best === null || info.mtimeMs > best.mtime) best = { path: candidate, mtime: info.mtimeMs }
      } catch {
        // No patch file in this profile — skip it.
      }
    }
  } catch {
    // Older hosts keep a single implicit profile.
  }
  return best?.path ?? join(root, 'desktop', 'cordis.patch.yml')
}

function defaultProfileDir(ctx: Context): string {
  const profiles = ctx.get('desktopProfiles') as { current?: { dir?: string } } | undefined
  const dir = profiles?.current?.dir
  if (typeof dir === 'string' && dir.length > 0) return dir
  return join(resolveDshHome(), 'profiles', 'desktop')
}

function unavailablePnpm(): PnpmRunner {
  return {
    runPlugin() {
      const handle = {
        stdout: null as unknown as NodeJS.ReadableStream,
        stderr: null as unknown as NodeJS.ReadableStream,
        done: Promise.resolve({ exitCode: 1, signal: null }),
        cancel() {},
      }
      return handle
    },
  }
}
