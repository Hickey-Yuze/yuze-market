/**
 * Fetch a fresh signed download URL for one cloud expert, on demand.
 *
 * Why this exists: `expert/download-url` returns a URL signed for roughly 24
 * hours, so any snapshot older than that can browse but never install. Refreshing
 * the whole catalogue costs ~10 minutes of requests; asking for the one expert
 * the user clicked takes a second.
 *
 * The endpoint needs a logged-in WorkBuddy session, and that session's token
 * lives in WorkBuddy's **main** process — unreadable from disk and uninjectable
 * into a request. So instead of stealing the token we ask the app itself: its
 * renderer exposes `wb.http`, the same authenticated client the market page
 * uses, and its CDP port can be opened through `WORKBUDDY_REMOTE_DEBUGGING_PORT`.
 *
 * Opening that port needs a relaunch. We never do that behind the user's back:
 * `allowRestart: false` reports `needRestart` and the caller asks first.
 */

import { spawn } from 'node:child_process'
import { access } from 'node:fs/promises'

export interface LiveUrlResult {
  readonly ok: boolean
  readonly url?: string
  readonly expiresAt?: number
  readonly filename?: string
  /** The CDP port was closed; retry with `allowRestart: true` to relaunch. */
  readonly needRestart?: boolean
  readonly message?: string
}

const DEFAULT_PORT = 9333
const APP_BINARY = '/Applications/WorkBuddy.app/Contents/MacOS/Electron'
const ENDPOINT = '/portal/operation-platform/market/expert/download-url'

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

interface CdpTarget {
  readonly type?: string
  readonly webSocketDebuggerUrl?: string
}

async function cdpTargets(port: number): Promise<readonly CdpTarget[] | undefined> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(3000) })
    return (await response.json()) as readonly CdpTarget[]
  } catch {
    return undefined
  }
}

interface CdpLink {
  readonly evaluate: (expression: string) => Promise<unknown>
  readonly close: () => void
}

/** Minimal CDP client: one evaluate over the app's result-bearing page. */
async function connectCdp(port: number): Promise<CdpLink | undefined> {
  const targets = await cdpTargets(port)
  const page = targets?.find(target => target.type === 'page' && typeof target.webSocketDebuggerUrl === 'string')
  if (page?.webSocketDebuggerUrl === undefined) return undefined

  const socket = new WebSocket(page.webSocketDebuggerUrl)
  let sequence = 0
  const pending = new Map<number, (message: { result?: unknown }) => void>()

  socket.addEventListener('message', event => {
    const message = JSON.parse(String(event.data)) as { id?: number; result?: unknown }
    if (typeof message.id === 'number' && pending.has(message.id)) {
      pending.get(message.id)?.(message)
      pending.delete(message.id)
    }
  })

  const opened = await new Promise<boolean>(resolve => {
    const timer = setTimeout(() => resolve(false), 5000)
    socket.addEventListener(
      'open',
      () => {
        clearTimeout(timer)
        resolve(true)
      },
      { once: true },
    )
    socket.addEventListener(
      'error',
      () => {
        clearTimeout(timer)
        resolve(false)
      },
      { once: true },
    )
  })
  if (!opened) {
    socket.close()
    return undefined
  }

  const send = (method: string, params: Record<string, unknown> = {}): Promise<{ result?: unknown }> => {
    const id = ++sequence
    socket.send(JSON.stringify({ id, method, params }))
    return new Promise(resolve => pending.set(id, resolve))
  }

  await send('Runtime.enable')

  // The CDP port opens before the renderer has booted `wb`; poll instead of
  // assuming the first evaluate can see it.
  let ready = false
  for (let attempt = 0; attempt < 60; attempt++) {
    const probe = (await send('Runtime.evaluate', {
      expression: "typeof wb !== 'undefined'",
      returnByValue: true,
    })) as { result?: { result?: { value?: unknown } } }
    if (probe.result?.result?.value === true) {
      ready = true
      break
    }
    await sleep(1000)
  }
  if (!ready) {
    socket.close()
    return undefined
  }

  return {
    async evaluate(expression: string): Promise<unknown> {
      const outcome = (await send('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
      })) as { result?: { exceptionDetails?: unknown; result?: { value?: unknown } } }
      if (outcome.result?.exceptionDetails !== undefined) {
        throw new Error('渲染进程执行失败')
      }
      return outcome.result?.result?.value
    },
    close(): void {
      socket.close()
    },
  }
}

/** Relaunch WorkBuddy with its debugging port open (macOS only today). */
async function relaunchWithCdp(port: number, running: boolean): Promise<boolean> {
  if (process.platform !== 'darwin') return false

  if (running) {
    spawn('osascript', ['-e', 'tell application "WorkBuddy" to quit'], { stdio: 'ignore' })
    await sleep(4000)
  }
  spawn('pkill', ['-f', 'WorkBuddy.app/Contents/MacOS/Electron'], { stdio: 'ignore' })
  await sleep(2500)

  const child = spawn(APP_BINARY, [], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, WORKBUDDY_REMOTE_DEBUGGING_PORT: String(port) },
  })
  child.unref()

  for (let attempt = 0; attempt < 45; attempt++) {
    await sleep(1000)
    if ((await cdpTargets(port)) !== undefined) return true
  }
  return false
}

/**
 * Ask the running WorkBuddy for a signed URL for one expert.
 *
 * `allowRestart` gates the only disruptive step (relaunching the app). Without
 * it, a closed port yields `needRestart` so the UI can ask the user first.
 */
export async function fetchLiveExpertUrl(
  expertId: string,
  options: { readonly allowRestart: boolean; readonly port?: number },
): Promise<LiveUrlResult> {
  const port = options.port ?? DEFAULT_PORT

  if (process.platform !== 'darwin') {
    return {
      ok: false,
      message: '自动刷新下载地址目前仅支持 macOS；其他平台请在 WorkBuddy 内安装，或手动导入 zip',
    }
  }
  if (!(await exists(APP_BINARY))) {
    return { ok: false, message: '本机没有安装 WorkBuddy，无法获取签名下载地址' }
  }

  let open = (await cdpTargets(port)) !== undefined
  if (!open) {
    if (!options.allowRestart) {
      return {
        ok: false,
        needRestart: true,
        message:
          '云端专家要用 WorkBuddy 的登录态换一个下载链接，需要重启 WorkBuddy 一次（约 15 秒）。确认后即可安装，之后 24 小时内再装其他云端专家通常无需重启。',
      }
    }
    const running = (await cdpTargets(port)) === undefined
    if (!(await relaunchWithCdp(port, running))) {
      return { ok: false, message: '重启 WorkBuddy 后仍无法连接调试端口' }
    }
    open = true
  }

  const link = await connectCdp(port)
  if (link === undefined) {
    return { ok: false, message: 'WorkBuddy 页面未就绪，请稍后重试' }
  }

  try {
    const raw = await link.evaluate(`(async () => {
      try {
        const response = await wb.http.post(${JSON.stringify(ENDPOINT)}, { expert_id: ${JSON.stringify(expertId)} })
        const data = response && response.data
        if (!data || typeof data.download_url !== 'string') return JSON.stringify({ code: response && response.code })
        return JSON.stringify({ url: data.download_url, expiresAt: data.expires_at, filename: data.filename })
      } catch (error) {
        return JSON.stringify({ error: (error && error.message) || String(error) })
      }
    })()`)

    const parsed = JSON.parse(String(raw ?? '{}')) as {
      url?: string
      expiresAt?: number
      filename?: string
      error?: string
      code?: number
    }

    if (parsed.error !== undefined) return { ok: false, message: `WorkBuddy 返回错误：${parsed.error}` }
    if (parsed.url === undefined) {
      return { ok: false, message: `WorkBuddy 没有返回下载地址（code=${parsed.code ?? '未知'}）` }
    }
    return {
      ok: true,
      url: parsed.url,
      ...(parsed.expiresAt === undefined ? {} : { expiresAt: parsed.expiresAt }),
      ...(parsed.filename === undefined ? {} : { filename: parsed.filename }),
    }
  } catch (cause) {
    return { ok: false, message: `获取下载地址失败：${(cause as Error).message}` }
  } finally {
    link.close()
  }
}
