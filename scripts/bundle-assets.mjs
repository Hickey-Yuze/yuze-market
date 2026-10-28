/**
 * Pack the small snapshots into the plugin so a fresh install works offline.
 *
 * The skill catalogue (1 171 rows) and its Chinese copy are ~210 KB gzipped —
 * small enough to ship. The expert catalogue is 20 MB, far too large to embed,
 * so it is published as a release asset and fetched on demand instead
 * (`POST /api/yuze-market/snapshot/experts`).
 *
 * Runs before every build; a machine without the snapshots (CI) simply produces
 * a package without embedded assets, which falls back to the on-demand path.
 */
import { gzipSync } from 'node:zlib'
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const CACHE = join(homedir(), '.dsh', 'workbuddy-market', 'cache')
const OUT = join(process.cwd(), 'assets')

const ASSETS = [
  { source: join(CACHE, 'skills-market.json'), target: 'skills-market.json.gz' },
  { source: join(CACHE, 'skills-zh.json'), target: 'skills-zh.json.gz' },
]

await mkdir(OUT, { recursive: true })

let packed = 0
for (const asset of ASSETS) {
  let raw
  try {
    raw = await readFile(asset.source)
  } catch {
    console.log(`[bundle-assets] 跳过 ${asset.target}（本机没有源文件）`)
    continue
  }
  const gzipped = gzipSync(raw, { level: 9 })
  await writeFile(join(OUT, asset.target), gzipped)
  packed += 1
  console.log(`[bundle-assets] ${asset.target} ${(raw.length / 1024).toFixed(0)}KB → ${(gzipped.length / 1024).toFixed(0)}KB`)
}

if (packed === 0) console.log('[bundle-assets] 未打包任何资源，发布包将依赖按需下载')
