/**
 * Snapshot WorkBuddy's online expert marketplace into the local cache.
 *
 * The marketplace (`POST /portal/operation-platform/market/expert/list`) needs a
 * logged-in WorkBuddy session, and that session lives inside the app: its HTTP
 * client injects `Authorization` + `X-User-Id` in the **main** process, so the
 * token is neither in localStorage nor interceptable from the renderer.
 *
 * Rather than extracting a credential we ask the app itself for the data: the
 * renderer already exposes `wb.http` (the same authenticated client the market
 * page uses) and its own CDP port is supported through
 * `WORKBUDDY_REMOTE_DEBUGGING_PORT`. This script drives that client page by page
 * and streams each chunk back to a loopback receiver, then writes one snapshot
 * the plugin reads on demand.
 *
 * Usage:
 *   WORKBUDDY_REMOTE_DEBUGGING_PORT=9333 open -a WorkBuddy   # or launch once
 *   node scripts/sync-workbuddy-experts.mjs
 *
 * The plugin never talks to WorkBuddy: it only reads the snapshot, so a closed
 * app, an expired session, or an upstream change degrades to the previous
 * snapshot instead of an empty list.
 *
 * Each entry also gets its signed zip URL (`expert/download-url`, valid for
 * roughly 24h the first time it is read) so the plugin can install a cloud
 * expert without a WorkBuddy session. Those URLs expire; re-run this script to
 * refresh them. Pass `--no-download` for a browse-only snapshot.
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const PORT = Number(process.env.WORKBUDDY_CDP_PORT ?? 9333)
const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const OUT = join(DSH_HOME, 'workbuddy-market', 'cache', 'experts-market.json')
const PAGE_SIZE = 100
const WITH_DOWNLOAD = !process.argv.includes('--no-download')
/** Resume from a page, so a mid-run upstream failure does not lose the earlier pages. */
const FROM_PAGE = Math.max(1, Number(process.env.FROM_PAGE ?? '1') || 1)
/** Merge into the existing snapshot instead of replacing it. */
const MERGE = process.argv.includes('--merge')
const DOWNLOAD_CONCURRENCY = 8
const ENDPOINT = '/portal/operation-platform/market/expert/list'

function log(message) {
  console.log(`[sync-experts] ${message}`)
}

const APP_BINARY = '/Applications/WorkBuddy.app/Contents/MacOS/Electron'

async function cdpTargets() {
  const response = await fetch(`http://127.0.0.1:${PORT}/json`, { signal: AbortSignal.timeout(3000) })
  return await response.json()
}

async function cdpAvailable() {
  try {
    await cdpTargets()
    return true
  } catch {
    return false
  }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function waitForCdp(attempts = 30) {
  for (let index = 0; index < attempts; index++) {
    if (await cdpAvailable()) return true
    await sleep(1000)
  }
  return false
}

/**
 * WorkBuddy only opens its CDP port when `WORKBUDDY_REMOTE_DEBUGGING_PORT` is
 * set, and `open -a` cannot carry an environment variable. So this path quits
 * the app, relaunches the binary directly with the variable, and puts it back to
 * a normal launch afterwards — the login session survives because it lives in
 * the app's own storage.
 */
async function relaunchWithCdp() {
  if (process.platform !== 'darwin') {
    throw new Error('自动重启仅支持 macOS；其他平台请手动设置 WORKBUDDY_REMOTE_DEBUGGING_PORT 后启动 WorkBuddy')
  }
  log('WorkBuddy 未开调试端口，自动重启一次以取数')
  spawn('osascript', ['-e', 'tell application "WorkBuddy" to quit'], { stdio: 'ignore' })
  await sleep(4000)
  spawn('pkill', ['-f', 'WorkBuddy.app/Contents/MacOS/Electron'], { stdio: 'ignore' })
  await sleep(3000)
  const child = spawn(APP_BINARY, [], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, WORKBUDDY_REMOTE_DEBUGGING_PORT: String(PORT) },
  })
  child.unref()
  if (!(await waitForCdp())) throw new Error(`重启后仍连不上调试端口 ${PORT}`)
  log('调试端口已就绪')
}

async function restoreNormalLaunch() {
  if (process.platform !== 'darwin') return
  spawn('pkill', ['-f', 'WorkBuddy.app/Contents/MacOS/Electron'], { stdio: 'ignore' })
  await sleep(3000)
  spawn('open', ['-a', 'WorkBuddy'], { stdio: 'ignore' })
  log('已恢复 WorkBuddy 正常启动（无调试端口）')
}

function connect(url) {
  const ws = new WebSocket(url)
  let seq = 0
  const pending = new Map()
  ws.addEventListener('message', event => {
    const message = JSON.parse(event.data)
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message)
      pending.delete(message.id)
    }
  })
  const send = (method, params = {}) => {
    const id = ++seq
    ws.send(JSON.stringify({ id, method, params }))
    return new Promise(resolve => pending.set(id, resolve))
  }
  const opened = new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', () => reject(new Error('CDP socket error')), { once: true })
  })
  return { ws, send, opened }
}

/** Collect the streamed pages. */
function receiver() {
  const experts = []
  let total = 0
  const urls = new Map()
  const server = createServer((request, response) => {
    // The renderer runs from file://, so every loopback fetch is cross-origin.
    response.setHeader('access-control-allow-origin', '*')
    response.setHeader('access-control-allow-headers', 'content-type')
    if (request.method === 'OPTIONS') return response.writeHead(204).end()
    if (request.method !== 'POST') return response.writeHead(404).end()
    const chunks = []
    request.on('data', chunk => chunks.push(chunk))
    request.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        if (typeof body.total === 'number' && body.total > 0) total = body.total
        if (Array.isArray(body.items)) experts.push(...body.items)
        if (Array.isArray(body.urls)) {
          for (const entry of body.urls) {
            if (typeof entry?.expert_id === 'string' && typeof entry?.download_url === 'string') {
              urls.set(entry.expert_id, { url: entry.download_url, expiresAt: entry.expires_at ?? null })
            }
          }
        }
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true }))
      } catch (cause) {
        response.writeHead(400).end(String(cause))
      }
    })
  })
  return { server, experts, urls, getTotal: () => total }
}

const autoRestarted = !(await cdpAvailable())
if (autoRestarted) await relaunchWithCdp()

const targets = await cdpTargets()
const page = targets.find(target => target.type === 'page')
if (page === undefined) throw new Error('WorkBuddy 没有可用的渲染页面')

const sink = receiver()
await new Promise(resolve => sink.server.listen(0, '127.0.0.1', resolve))
const sinkPort = sink.server.address().port

const link = connect(page.webSocketDebuggerUrl)
await link.opened
await link.send('Runtime.enable')

/** The CDP port opens before the renderer finishes loading the app globals. */
const waitForApp = async (attempts = 60) => {
  for (let index = 0; index < attempts; index++) {
    const probe = await link.send('Runtime.evaluate', { expression: `typeof wb !== 'undefined'`, returnByValue: true })
    if (probe.result?.result?.value === true) return true
    await sleep(1000)
  }
  return false
}
if (!(await waitForApp())) throw new Error('WorkBuddy 页面加载完成但 wb 仍不可用（可能还在启动中）')

log(`从 WorkBuddy 拉取专家市场（每页 ${PAGE_SIZE}，回传到 127.0.0.1:${sinkPort}）`)

const script = `(async () => {
  const post = async (body) => {
    const response = await wb.http.post(${JSON.stringify(ENDPOINT)}, body)
    if (response && response.code !== 0) throw new Error('code=' + response.code)
    return response
  }
  const FROM_PAGE = ${FROM_PAGE}
  const first = await post({ page: FROM_PAGE, page_size: ${PAGE_SIZE}, sort_by: 'reco_rank', sort_order: 'desc' })
  const total = first?.data?.total_count ?? first?.data?.total ?? 0
  const send = async (items, pageNo) => {
    await fetch('http://127.0.0.1:${sinkPort}/chunk', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ total, page: pageNo, items }),
    })
  }
  const WITH_DOWNLOAD = ${WITH_DOWNLOAD}
  const CONCURRENCY = ${DOWNLOAD_CONCURRENCY}
  const sendUrls = async (entries) => {
    if (entries.length === 0) return
    await fetch('http://127.0.0.1:${sinkPort}/chunk', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ urls: entries }),
    })
  }
  const grabUrls = async (items) => {
    if (!WITH_DOWNLOAD || items.length === 0) return []
    const out = []
    let cursor = 0
    const worker = async () => {
      for (;;) {
        const index = cursor++
        if (index >= items.length) return
        const item = items[index]
        const expertId = item?.expert_id ?? item?.source_id
        if (typeof expertId !== 'string') continue
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const response = await wb.http.post('/portal/operation-platform/market/expert/download-url', { expert_id: expertId })
            const data = response?.data
            if (typeof data?.download_url === 'string') {
              out.push({ expert_id: expertId, download_url: data.download_url, expires_at: data.expires_at ?? null })
            }
            break
          } catch (cause) {
            if (attempt === 1) break
            await new Promise(r => setTimeout(r, 300))
          }
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker))
    return out
  }
  let pages = 0
  let collected = (first?.data?.experts ?? []).length
  await send(first?.data?.experts ?? [], FROM_PAGE)
  await sendUrls(await grabUrls(first?.data?.experts ?? []))
  pages = FROM_PAGE
  const lastPage = Math.ceil(total / ${PAGE_SIZE})
  for (let pageNo = FROM_PAGE + 1; pageNo <= lastPage; pageNo++) {
    let attempt = 0
    for (;;) {
      try {
        const r = await post({ page: pageNo, page_size: ${PAGE_SIZE}, sort_by: 'reco_rank', sort_order: 'desc' })
        const items = r?.data?.experts ?? []
        collected += items.length
        await send(items, pageNo)
        await sendUrls(await grabUrls(items))
        pages = pageNo
        break
      } catch (cause) {
        if (++attempt >= 3) return JSON.stringify({ total, pages, collected, failedAt: pageNo, error: String(cause) })
        await new Promise(r => setTimeout(r, 600 * attempt))
      }
    }
  }
  return JSON.stringify({ total, pages, collected })
})()`

let evaluation
try {
  evaluation = await link.send('Runtime.evaluate', {
    expression: script,
    awaitPromise: true,
    returnByValue: true,
  })
} catch (cause) {
  if (autoRestarted) await restoreNormalLaunch()
  throw cause
}

link.ws.close()
sink.server.close()

const details = evaluation.result?.exceptionDetails
if (details !== undefined) {
  if (autoRestarted) await restoreNormalLaunch()
  throw new Error(`渲染进程执行失败：${details.exception?.description ?? details.text}`)
}

const summary = JSON.parse(evaluation.result.result.value ?? '{}')
log(`渲染进程报告：total=${summary.total} pages=${summary.pages} collected=${summary.collected}`)
if (summary.error !== undefined) log(`中途失败：page ${summary.failedAt} — ${summary.error}`)

const deduped = new Map()
if (MERGE) {
  try {
    const previous = JSON.parse(await readFile(OUT, 'utf8'))
    for (const item of previous.items ?? []) {
      const id = item?.expert_id ?? item?.source_id
      if (typeof id === 'string' && id.length > 0) deduped.set(id, item)
    }
    log(`合并既有快照：${deduped.size} 条`)
  } catch {
    log('没有可合并的既有快照，按新抓取写入')
  }
}
for (const item of sink.experts) {
  const id = item?.expert_id ?? item?.source_id
  if (typeof id === 'string' && id.length > 0) deduped.set(id, item)
}
let withUrl = 0
for (const [id, item] of deduped) {
  const signed = sink.urls.get(id)
  if (signed === undefined) continue
  withUrl += 1
  deduped.set(id, { ...item, download_url: signed.url, download_expires_at: signed.expiresAt })
}
log(`下载地址：${withUrl}/${deduped.size} 条可安装（约 24 小时有效）`)
const items = [...deduped.values()]
if (items.length === 0) throw new Error('没有拿到任何专家数据')

const payload = {
  builtAt: new Date().toISOString(),
  source: 'workbuddy-market-expert-list',
  endpoint: ENDPOINT,
  total: summary.total ?? items.length,
  downloadable: withUrl,
  items,
}

await mkdir(join(DSH_HOME, 'workbuddy-market', 'cache'), { recursive: true })
await writeFile(OUT, `${JSON.stringify(payload)}\n`, 'utf8')
log(`写入 ${OUT}：${items.length} 条（上游报告 ${payload.total} 条）`)

if (autoRestarted) await restoreNormalLaunch()
