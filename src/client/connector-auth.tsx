/**
 * Shared authorization state for remote (OAuth) MCP connectors.
 *
 * Two surfaces show the same thing: the MCP row this plugin contributes to the
 * Host's 连接器 panel, and the 已安装 strip in 市场's 连接器 tab. Both read the
 * Node half's `/oauth/status|start|disconnect` routes through this hook, so the
 * flow (open the consent page, poll until the token lands) is written once.
 *
 * The token exchange itself never happens in the browser: the plugin owns the
 * loopback callback and writes the bearer into the profile's MCP headers.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

const OAUTH = '/api/yuze-market/oauth'

/** 2s × 150 = 5 minutes, matching the loopback listener's own timeout. */
const POLL_INTERVAL_MS = 2000
const POLL_ATTEMPTS = 150

/** Authorization state of one remote connector, as `/status` reports it. */
export interface AuthState {
  readonly server: string
  readonly mcpUrl: string | null
  readonly authorized: boolean
  readonly daysLeft: number | null
  readonly scope: string
  readonly obtainedAt?: string | null
  /** True when `/status` exchanged an expired token for a fresh one. */
  readonly refreshed?: boolean
  /** True when the stored token expired and no refresh token was available. */
  readonly expired?: boolean
}

export interface PendingAuth {
  readonly server: string
  readonly url: string
}

export interface ConnectorAuth {
  readonly auth: Readonly<Record<string, AuthState>>
  readonly busy: string | null
  readonly message: string | null
  readonly pending: PendingAuth | null
  authorize: (server: string, mcpUrl: string) => Promise<void>
  disconnect: (server: string) => Promise<void>
  reread: (server: string) => Promise<void>
  dismiss: () => void
}

const delay = (milliseconds: number): Promise<void> => new Promise(resolve => setTimeout(resolve, milliseconds))

async function readStatus(server: string): Promise<AuthState | null> {
  try {
    const response = await fetch(`${OAUTH}/status?server=${encodeURIComponent(server)}`)
    if (!response.ok) return null
    return (await response.json()) as AuthState
  } catch {
    return null
  }
}

/**
 * Electron may swallow `window.open`. A programmatic anchor click issued from
 * the button's own gesture survives more often, and both surfaces keep the raw
 * link visible, so a blocked popup costs a click instead of the whole flow.
 */
function openExternally(url: string): void {
  try {
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.target = '_blank'
    anchor.rel = 'noreferrer noopener'
    anchor.style.display = 'none'
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
  } catch {
    // Ignored: the visible 打开授权页 link is the fallback.
  }
}

function describeError(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

/**
 * Track authorization for `servers`, refreshing the cache whenever that set
 * changes. Reads are best-effort: a failed status query leaves the row on its
 * previous label instead of blanking the panel.
 */
export function useConnectorAuth(
  servers: readonly string[],
  initial?: Readonly<Record<string, AuthState>>,
): ConnectorAuth {
  const [auth, setAuth] = useState<Record<string, AuthState>>(() => ({ ...(initial ?? {}) }))
  const [busy, setBusy] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [pending, setPending] = useState<PendingAuth | null>(null)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const key = servers.join('|')

  useEffect(() => {
    if (key.length === 0) return
    let cancelled = false
    void (async () => {
      const names = key.split('|')
      const pairs = await Promise.all(names.map(async name => [name, await readStatus(name)] as const))
      if (cancelled || !alive.current) return
      setAuth(previous => {
        const next: Record<string, AuthState> = { ...previous }
        for (const [name, state] of pairs) if (state !== null) next[name] = state
        return next
      })
    })()
    return () => {
      cancelled = true
    }
  }, [key])

  const reread = useCallback(async (server: string): Promise<void> => {
    const state = await readStatus(server)
    if (state === null || !alive.current) return
    setAuth(previous => ({ ...previous, [server]: state }))
  }, [])

  const authorize = useCallback(
    async (server: string, mcpUrl: string): Promise<void> => {
      setBusy(server)
      setMessage(null)
      try {
        const response = await fetch(`${OAUTH}/start`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ server, mcpUrl }),
        })
        const body = (await response.json()) as { authUrl?: string; message?: string }
        if (!response.ok || typeof body.authUrl !== 'string') {
          setBusy(null)
          setMessage(`授权启动失败：${body.message ?? '未知错误'}`)
          return
        }

        setPending({ server, url: body.authUrl })
        openExternally(body.authUrl)
        console.info(`[yuze-market] 授权页：${body.authUrl}`)

        for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt++) {
          await delay(POLL_INTERVAL_MS)
          if (!alive.current) return
          const state = await readStatus(server)
          if (state !== null) setAuth(previous => ({ ...previous, [server]: state }))
          if (state?.authorized === true) {
            setPending(null)
            setBusy(null)
            setMessage(state.refreshed === true ? '授权成功，凭据已续期' : '授权成功，重启 Harness 后连接器即可调用')
            return
          }
        }
        setPending(null)
        setBusy(null)
        setMessage('授权超时（5 分钟），请重新发起')
      } catch (cause) {
        setBusy(null)
        setMessage(`授权失败：${describeError(cause)}`)
      }
    },
    [],
  )

  const disconnect = useCallback(async (server: string): Promise<void> => {
    setBusy(server)
    setMessage(null)
    try {
      const response = await fetch(`${OAUTH}/disconnect`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ server }),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      setAuth(previous => {
        const next = { ...previous }
        delete next[server]
        return next
      })
      const state = await readStatus(server)
      if (state !== null && alive.current) setAuth(previous => ({ ...previous, [server]: state }))
      setMessage('已断开，凭据已删除')
    } catch (cause) {
      setMessage(`断开失败：${describeError(cause)}`)
    } finally {
      setBusy(null)
    }
  }, [])

  const dismiss = useCallback(() => setMessage(null), [])

  return useMemo(
    () => ({ auth, busy, message, pending, authorize, disconnect, reread, dismiss }),
    [auth, busy, message, pending, authorize, disconnect, reread, dismiss],
  )
}

/** The one-line state label both surfaces share. */
export function describeAuth(
  state: AuthState | undefined,
  pending: boolean,
  transport: string,
): string {
  if (transport !== 'streamable-http') return transport
  if (state === undefined) return '读取中'
  if (state.mcpUrl === null) return transport
  if (state.authorized) {
    if (state.refreshed === true) return '已续期 · 重启后生效'
    return state.daysLeft === null ? '已授权' : `已授权 · ${state.daysLeft} 天`
  }
  if (pending) return '等待授权…'
  return state.expired === true ? '凭据已过期' : '需要授权'
}
