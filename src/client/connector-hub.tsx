/**
 * This plugin's rows inside the Host's shared 连接器 panel.
 *
 * Two kinds of rows are published:
 *
 * - one summary row (`Yuze-MCP 连接器`) that carries the marketplace mark and
 *   reports how many servers are wired up;
 * - one row per installed MCP server, named after its catalogue title and
 *   carrying its own brand icon, connection label and enable switch — the same
 *   shape the Host's own connectors use, so the panel reads as one list rather
 *   than a link into a sub-page.
 *
 * `renderDetail()` is rendered by the hub as a **React child**
 * (`h('div', { className: 'dt-hub-detail' }, …, descriptor.renderDetail())`), so
 * it must return a React element. Returning a DOM node throws
 * "Objects are not valid as a React child" and takes the whole panel down.
 *
 * Rows are registered and disposed dynamically: the hub's `register` returns a
 * disposer and re-registering the same id replaces it, which is how a refresh
 * updates the list without a reload.
 */

import { useEffect, useMemo, useState } from 'react'

import { marketApi, type InstalledConnectorEntry } from './api.js'
import { BRAND_LOGO } from './brand.js'
import { describeAuth, useConnectorAuth } from './connector-auth.js'
import type { AuthState } from './connector-auth.js'

const HUB_KEY = '__dshConnectorHub'
const SUMMARY_ID = 'yuze-mcp-connectors'
const ROW_PREFIX = 'yuze-mcp-'

/** One row's live state, as the hub expects it. */
interface HubState {
  readonly state: 'on' | 'off' | 'pending' | 'error'
  readonly label?: string
  readonly busy?: boolean
}

/** The shape a hub descriptor is allowed to use. */
interface HubDescriptor {
  readonly id: string
  readonly name: string
  readonly order?: number
  readonly icon?: unknown
  getState: () => HubState
  subscribe: (listener: () => void) => () => void
  enable?: () => unknown
  disable?: () => unknown
  renderDetail: () => JSX.Element
}

interface Hub {
  register(descriptor: HubDescriptor): unknown
  list?(): readonly HubDescriptor[]
}

// ------------------------------------------------------------- shared state

let summary: HubState = { state: 'pending', label: '读取中' }
let rows: readonly InstalledConnectorEntry[] = []
let authByServer = new Map<string, AuthState>()
const listeners = new Set<() => void>()
const disposers = new Map<string, () => void>()
let attached = false

function hub(): Hub | undefined {
  if (typeof window === 'undefined') return undefined
  const value = (window as unknown as Record<string, unknown>)[HUB_KEY]
  return value && typeof value === 'object' ? (value as Hub) : undefined
}

function emit(): void {
  for (const listener of listeners) {
    try {
      listener()
    } catch {
      // A broken listener must not stop the others.
    }
  }
}

async function readStatus(server: string): Promise<AuthState | null> {
  try {
    const response = await fetch(`/api/qurwork-market/oauth/status?server=${encodeURIComponent(server)}`)
    if (!response.ok) return null
    return (await response.json()) as AuthState
  } catch {
    return null
  }
}

/** Label + tone for one installed server, matching what the panel expects. */
function stateOf(entry: InstalledConnectorEntry): HubState {
  if (!entry.enabled) return { state: 'off', label: '已停用' }
  const auth = authByServer.get(entry.serverName)
  if (entry.transport !== 'streamable-http') return { state: 'on', label: '已接入' }
  if (auth?.authorized === true) return { state: 'on', label: '已连接' }
  if (auth === undefined) return { state: 'on', label: '已接入' }
  return { state: 'off', label: '待授权' }
}

function iconFor(entry: InstalledConnectorEntry): JSX.Element {
  const src = entry.artUrl
  if (src === undefined || src.length === 0) {
    return <img src={BRAND_LOGO} alt="" style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
  }
  return <img src={src} alt="" style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
}

function nameFor(entry: InstalledConnectorEntry): string {
  const title = entry.title
  if (title !== undefined && title.length > 0) return title
  return entry.serverName
}

// ------------------------------------------------------------------ the rows

/** Detail body for one server: authorization, enable state and removal, in place. */
function ConnectorDetail(props: { readonly entry: InstalledConnectorEntry }): JSX.Element {
  const { entry } = props
  const { auth, busy, message, pending, authorize, disconnect } = useConnectorAuth([entry.serverName])
  const state = auth[entry.serverName]
  const remote = entry.transport === 'streamable-http'
  const canAuthorize = remote && state !== undefined && state.mcpUrl !== null
  const [working, setWorking] = useState<'toggle' | 'remove' | undefined>(undefined)
  const [gone, setGone] = useState(false)

  const toggle = async (): Promise<void> => {
    setWorking('toggle')
    try {
      await marketApi.setConnectorEnabled(entry.serverName, !entry.enabled)
      await refreshAll()
    } finally {
      setWorking(undefined)
    }
  }

  const remove = async (): Promise<void> => {
    setWorking('remove')
    try {
      await marketApi.removeConnector(entry.serverName)
      setGone(true)
      await refreshAll()
    } finally {
      setWorking(undefined)
    }
  }

  if (gone) {
    return (
      <p className="qym-hint" data-qym-connector-detail={entry.serverName}>
        已从 MCP 配置移除，重启 Harness 后生效。
      </p>
    )
  }

  return (
    <div className="qym" data-qym-connector-detail={entry.serverName}>
      <ul className="qym-rows">
        <li className="qym-row">
          <div className="qym-rowMain">
            <span className="qym-rowName">{nameFor(entry)}</span>
            <span className="qym-rowMeta">
              {describeAuth(state, pending?.server === entry.serverName, entry.transport)}
              {entry.enabled ? '' : ' · 已停用'}
              {message === null || message.length === 0 ? '' : ` · ${message}`}
            </span>
            {pending !== null ? (
              <a href={pending.url} target="_blank" rel="noreferrer noopener" className="qym-hint">
                打开授权页
              </a>
            ) : null}
          </div>
          <div className="qym-rowActions">
            {state?.authorized === true ? (
              <button
                type="button"
                className="qym-btn"
                disabled={busy === entry.serverName}
                onClick={() => void disconnect(entry.serverName)}
              >
                断开
              </button>
            ) : canAuthorize ? (
              <button
                type="button"
                className="qym-btn qym-btn--primary"
                disabled={busy === entry.serverName}
                onClick={() => void authorize(entry.serverName, state?.mcpUrl ?? '')}
              >
                {busy === entry.serverName ? '授权中…' : '授权'}
              </button>
            ) : null}
            <button type="button" className="qym-btn" disabled={working !== undefined} onClick={() => void toggle()}>
              {working === 'toggle' ? '处理中…' : entry.enabled ? '停用' : '启用'}
            </button>
            <button
              type="button"
              className="qym-btn qym-btn--danger"
              disabled={working !== undefined}
              onClick={() => void remove()}
            >
              {working === 'remove' ? '删除中…' : '删除'}
            </button>
          </div>
        </li>
      </ul>
    </div>
  )
}

/**
 * Summary body: a line of context only.
 *
 * The installed servers already have a row each, so listing them again here
 * duplicated every name and every action. This panel explains where they are and
 * leaves the operations on the rows themselves.
 */
function SummaryDetail(): JSX.Element {
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading')
  const [count, setCount] = useState(0)

  useEffect(() => {
    let alive = true
    void refreshAll().then(
      () => {
        if (!alive) return
        setCount(rows.length)
        setPhase('ready')
      },
      () => {
        if (alive) setPhase('error')
      },
    )
    return () => {
      alive = false
    }
  }, [])

  if (phase === 'loading') return <p className="qym-empty">读取中…</p>
  if (phase === 'error') return <p className="qym-error">读取失败，请重试</p>
  if (count === 0) {
    return <p className="qym-empty">还没有接入连接器。打开「市场 → 连接器」安装后会自动出现在这里。</p>
  }

  return (
    <div className="qym" data-qym-connector-detail="summary">
      <p className="qym-hint">
        已接入 {count} 个连接器，每个都在左侧单独一行：点开行可授权、停用或删除，行右侧的开关用于快速启用或停用。
      </p>
    </div>
  )
}

function summaryDescriptor(): HubDescriptor {
  return {
    id: SUMMARY_ID,
    name: 'Yuze-MCP 连接器',
    order: 90,
    icon: <img src={BRAND_LOGO} alt="" style={{ width: '100%', height: '100%', objectFit: 'contain' }} />,
    getState: () => summary,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    renderDetail: () => <SummaryDetail />,
  }
}

function rowDescriptor(entry: InstalledConnectorEntry, index: number): HubDescriptor {
  const server = entry.serverName
  const toggle = async (enabled: boolean): Promise<void> => {
    await marketApi.setConnectorEnabled(server, enabled)
    await refreshAll()
  }
  return {
    id: `${ROW_PREFIX}${server}`,
    name: nameFor(entry),
    order: 100 + index,
    icon: iconFor(entry),
    getState: () => stateOf(entry),
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    enable: () => toggle(true),
    disable: () => toggle(false),
    renderDetail: () => <ConnectorDetail entry={entry} />,
  }
}

// ------------------------------------------------------------- registration

/** Re-read the installed list and refresh every row in place. */
export async function refreshYuzeMcpConnector(): Promise<void> {
  try {
    await refreshAll()
  } catch {
    summary = { state: 'error', label: '读取失败' }
    emit()
  }
}

async function refreshAll(): Promise<void> {
  const payload = await marketApi.installed()
  rows = payload.connectors
  summary =
    rows.length > 0 ? { state: 'on', label: `已接入 ${rows.length} 个` } : { state: 'off', label: '未接入' }

  const remote = rows.filter(entry => entry.transport === 'streamable-http')
  const pairs = await Promise.all(remote.map(async entry => [entry.serverName, await readStatus(entry.serverName)] as const))
  const next = new Map<string, AuthState>()
  for (const [server, state] of pairs) if (state !== null) next.set(server, state)
  authByServer = next

  emit()
  syncRows()
}

/** Register/refresh one row per installed server, disposing the ones that left. */
function syncRows(): void {
  const target = hub()
  if (target === undefined || typeof target.register !== 'function' || !attached) return

  const alive = new Set<string>([SUMMARY_ID])
  for (const [index, entry] of rows.entries()) {
    const id = `${ROW_PREFIX}${entry.serverName}`
    alive.add(id)
    disposers.get(id)?.()
    try {
      disposers.set(id, target.register(rowDescriptor(entry, index)) as () => void)
    } catch {
      // A rejected descriptor must not take the other rows down.
    }
  }

  for (const [id, dispose] of [...disposers]) {
    if (alive.has(id)) continue
    dispose()
    disposers.delete(id)
  }
}

/**
 * Register the rows now, or as soon as another plugin publishes the hub.
 * Returns a disposer so a plugin unload does not leave dead rows behind.
 */
export function registerYuzeMcpConnector(): () => void {
  if (typeof document === 'undefined') return () => {}
  if (attached) return () => {}

  const attach = (): boolean => {
    const target = hub()
    if (!target || typeof target.register !== 'function') return false
    if (attached) return true
    try {
      disposers.set(SUMMARY_ID, target.register(summaryDescriptor()) as () => void)
      attached = true
      void refreshYuzeMcpConnector()
      return true
    } catch {
      return false
    }
  }

  if (attach()) return () => {}

  const onReady = (): void => {
    attach()
  }
  document.addEventListener('dsh-connector-hub-ready', onReady)
  return () => document.removeEventListener('dsh-connector-hub-ready', onReady)
}

/** Backwards-compatible alias for the previous export name. */
export const registerWorkBuddyConnector = registerYuzeMcpConnector

export interface ConnectorDetailProps {
  readonly initialRows?: readonly InstalledConnectorEntry[]
}

/** Legacy export kept for the render tests: renders one server's detail body. */
export function YuzeMcpConnectorDetail(props: ConnectorDetailProps): JSX.Element {
  const { initialRows } = props
  const first = initialRows?.[0]
  const [phase] = useState<'ready'>('ready')
  const list = useMemo(() => initialRows ?? [], [initialRows])
  if (first !== undefined) return <ConnectorDetail entry={first} />
  return (
    <div className="qym" data-qym-connector-detail="">
      {phase === 'ready' && list.length === 0 ? (
        <p className="qym-empty">还没有接入连接器。打开「市场 → 连接器」安装后会自动出现在这里。</p>
      ) : null}
    </div>
  )
}

export function yuzeMcpConnectorDescriptor(): HubDescriptor {
  return summaryDescriptor()
}
