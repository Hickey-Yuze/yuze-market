/**
 * Merge the per-batch translation shards into one dictionary.
 *
 * The translation itself runs out-of-band (one shard at a time, so a long pass
 * cannot exceed a single response). This step only validates and assembles:
 * every name must appear once, and a shard that failed to cover its input is
 * reported instead of silently dropping rows.
 *
 * Usage: node scripts/merge-skill-translations.mjs
 */
import { readFile, writeFile, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const ROOT = process.env.TRANSLATION_DIR ?? join(process.cwd(), 'scratch', 'trans')
const CACHE = join(homedir(), '.dsh', 'workbuddy-market', 'cache')
const SNAPSHOT = join(CACHE, 'skills-market.json')
const OUT = join(CACHE, 'skills-zh.json')

const snapshot = JSON.parse(await readFile(SNAPSHOT, 'utf8'))
const names = new Set((snapshot.items ?? []).map(item => item.name).filter(name => typeof name === 'string'))

const files = (await readdir(ROOT).catch(() => [])).filter(name => /^out-\d+\.json$/u.test(name)).sort()
if (files.length === 0) throw new Error(`没有找到翻译分片：${ROOT}/out-N.json`)

const map = {}
let duplicated = 0
for (const file of files) {
  const parsed = JSON.parse(await readFile(join(ROOT, file), 'utf8'))
  for (const [name, value] of Object.entries(parsed.map ?? {})) {
    if (!names.has(name)) continue
    if (map[name] !== undefined) duplicated += 1
    map[name] = value
  }
}

const covered = Object.keys(map).length
const missing = [...names].filter(name => map[name] === undefined)

await writeFile(OUT, `${JSON.stringify({ builtAt: new Date().toISOString(), source: 'translation-shards', total: covered, map }, null, 0)}\n`, 'utf8')

console.log(`[merge] 分片 ${files.length} 个 | 覆盖 ${covered}/${names.size} | 重复 ${duplicated} | 缺失 ${missing.length}`)
if (missing.length > 0) {
  console.log(`[merge] 未覆盖示例：${missing.slice(0, 10).join(', ')}`)
  console.log('[merge] 缺失条目会回退到英文原文')
}
console.log(`[merge] 写入 ${OUT}`)
