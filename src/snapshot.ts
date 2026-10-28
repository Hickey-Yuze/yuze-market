/**
 * On-demand download of the expert catalogue.
 *
 * The expert snapshot is ~20 MB gzipped — too large to embed in a plugin package
 * and pointless to require a WorkBuddy login for. It is published as a release
 * asset, so a fresh machine can pull the same catalogue the author synced,
 * without running the CDP sync script.
 *
 * The asset carries no signed download URLs (they expire in ~24h), so this path
 * gives browsing only; installing a cloud expert still needs a local sync.
 */

import { mkdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'

export const EXPERT_SNAPSHOT_URL =
  'https://github.com/Hickey-Yuze/yuze-market/releases/download/v0.3.1/experts-market.json.gz'

export interface SnapshotOutcome {
  readonly ok: boolean
  readonly total?: number
  readonly builtAt?: string
  readonly bytes?: number
  readonly message?: string
}

interface SnapshotShape {
  readonly builtAt?: string
  readonly total?: number
  readonly items?: readonly unknown[]
}

/** Download, verify and install the expert catalogue into the cache. */
export async function downloadExpertSnapshot(
  cacheRoot: string,
  url: string = EXPERT_SNAPSHOT_URL,
): Promise<SnapshotOutcome> {
  let response: Response
  try {
    response = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(180_000),
      headers: { accept: 'application/gzip, application/octet-stream' },
    })
  } catch (cause) {
    return { ok: false, message: `下载失败：${(cause as Error).message}` }
  }

  if (!response.ok) {
    return { ok: false, message: `下载失败：HTTP ${response.status}` }
  }

  let raw: Buffer
  try {
    raw = Buffer.from(await response.arrayBuffer())
  } catch (cause) {
    return { ok: false, message: `读取响应失败：${(cause as Error).message}` }
  }

  let text: string
  try {
    text = gunzipSync(raw).toString('utf8')
  } catch {
    return { ok: false, message: '下载到的文件不是合法的 gzip，可能被代理改写' }
  }

  let parsed: SnapshotShape
  try {
    parsed = JSON.parse(text) as SnapshotShape
  } catch {
    return { ok: false, message: '快照内容不是合法 JSON' }
  }

  if (!Array.isArray(parsed.items) || parsed.items.length === 0) {
    return { ok: false, message: '快照里没有专家条目' }
  }

  // Write next to the target and rename, so a crash never leaves a half file
  // that the reader would treat as a valid (truncated) catalogue.
  const target = join(cacheRoot, 'experts-market.json')
  const staging = join(cacheRoot, `experts-market.json.${Date.now()}.tmp`)
  try {
    await mkdir(cacheRoot, { recursive: true })
    await writeFile(staging, text, 'utf8')
    await rename(staging, target)
  } catch (cause) {
    return { ok: false, message: `写入失败：${(cause as Error).message}` }
  }

  return {
    ok: true,
    total: parsed.items.length,
    ...(parsed.builtAt === undefined ? {} : { builtAt: parsed.builtAt }),
    bytes: raw.length,
  }
}
