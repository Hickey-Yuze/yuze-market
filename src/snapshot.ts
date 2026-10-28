/**
 * On-demand download of the expert catalogue.
 *
 * The catalogue is ~12 MB gzipped — too large to embed in a plugin package and
 * pointless to require a WorkBuddy login for. It is published as a release asset
 * so a fresh machine can pull the same catalogue the author synced, without
 * running the CDP sync script.
 *
 * Two constraints shape this module:
 *
 * - The transfer is slow from some networks (tens of KB/s), so the request runs
 *   in the background and exposes byte progress instead of holding an HTTP
 *   response open for minutes.
 * - The asset carries no signed download URLs (they expire in ~24h), so this
 *   path gives browsing only; installing a cloud expert still needs a local sync.
 */

import { mkdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'

export const EXPERT_SNAPSHOT_URL =
  'https://github.com/Hickey-Yuze/yuze-market/releases/download/v0.3.1/experts-market.json.gz'

export type SnapshotState = 'idle' | 'running' | 'done' | 'error'

export interface SnapshotProgress {
  readonly state: SnapshotState
  /** Bytes received so far. */
  readonly received: number
  /** Content-Length when the server provided one, else 0. */
  readonly total: number
  readonly message?: string
  readonly updatedAt: number
}

let progress: SnapshotProgress = { state: 'idle', received: 0, total: 0, updatedAt: Date.now() }

/** Current byte progress of the background fetch. */
export function expertSnapshotProgress(): SnapshotProgress {
  return progress
}

export interface SnapshotOutcome {
  readonly ok: boolean
  readonly total?: number
  readonly builtAt?: string
  readonly bytes?: number
  readonly message?: string
}

interface SnapshotShape {
  readonly builtAt?: string
  readonly items?: readonly unknown[]
}

function report(next: Omit<SnapshotProgress, 'updatedAt'>): void {
  progress = { ...next, updatedAt: Date.now() }
}

/**
 * Download, verify and install the expert catalogue.
 *
 * The file is written to a temporary sibling and renamed into place, so a crash
 * or a cancelled download never leaves a truncated catalogue that the reader
 * would treat as valid.
 */
export async function downloadExpertSnapshot(
  cacheRoot: string,
  url: string = EXPERT_SNAPSHOT_URL,
): Promise<SnapshotOutcome> {
  report({ state: 'running', received: 0, total: 0 })

  let response: Response
  try {
    response = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(600_000),
      headers: { accept: 'application/gzip, application/octet-stream' },
    })
  } catch (cause) {
    const message = `下载失败：${(cause as Error).message}`
    report({ state: 'error', received: 0, total: 0, message })
    return { ok: false, message }
  }

  if (!response.ok) {
    const message = `下载失败：HTTP ${response.status}`
    report({ state: 'error', received: 0, total: 0, message })
    return { ok: false, message }
  }

  const total = Number(response.headers.get('content-length') ?? 0)
  const chunks: Buffer[] = []
  let received = 0

  try {
    const reader = response.body?.getReader()
    if (reader === undefined) throw new Error('响应没有可读的 body')
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      const chunk = Buffer.from(value)
      chunks.push(chunk)
      received += chunk.length
      // Throttle: one update per ~256 KB keeps the poller honest without churn.
      if (received - progress.received > 256 * 1024) {
        report({ state: 'running', received, total })
      }
    }
  } catch (cause) {
    const message = `读取响应失败：${(cause as Error).message}`
    report({ state: 'error', received, total, message })
    return { ok: false, message }
  }

  report({ state: 'running', received, total })

  let text: string
  try {
    text = gunzipSync(Buffer.concat(chunks)).toString('utf8')
  } catch {
    const message = '下载到的文件不是合法的 gzip，可能被代理改写'
    report({ state: 'error', received, total, message })
    return { ok: false, message }
  }

  let parsed: SnapshotShape
  try {
    parsed = JSON.parse(text) as SnapshotShape
  } catch {
    const message = '快照内容不是合法 JSON'
    report({ state: 'error', received, total, message })
    return { ok: false, message }
  }

  if (!Array.isArray(parsed.items) || parsed.items.length === 0) {
    const message = '快照里没有专家条目'
    report({ state: 'error', received, total, message })
    return { ok: false, message }
  }

  const target = join(cacheRoot, 'experts-market.json')
  const staging = join(cacheRoot, `experts-market.json.${Date.now()}.tmp`)
  try {
    await mkdir(cacheRoot, { recursive: true })
    await writeFile(staging, text, 'utf8')
    await rename(staging, target)
  } catch (cause) {
    const message = `写入失败：${(cause as Error).message}`
    report({ state: 'error', received, total, message })
    return { ok: false, message }
  }

  report({ state: 'done', received, total, message: `已获取 ${parsed.items.length} 位专家` })
  return {
    ok: true,
    total: parsed.items.length,
    ...(parsed.builtAt === undefined ? {} : { builtAt: parsed.builtAt }),
    bytes: received,
  }
}

/** True while a download is in flight; the route refuses a second start. */
export function isSnapshotRunning(): boolean {
  return progress.state === 'running'
}
