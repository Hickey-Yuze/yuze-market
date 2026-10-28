/**
 * Produce the published expert catalogue (`experts-market.json.gz`).
 *
 * The sync output is a faithful copy of the API and carries ~30 fields per row,
 * many of which the panel never shows (tenant mode, lifecycle, ranking hints,
 * English duplicates). Shipping all of it costs roughly twice the download time
 * for no visible benefit, so this keeps the fields the UI actually renders.
 *
 * Signed `download_url`s are intentionally dropped: they expire in ~24h, so a
 * downloaded catalogue would advertise installs that can never complete.
 *
 * Usage: node scripts/build-expert-asset.mjs [outputPath]
 */
import { gzipSync } from 'node:zlib'
import { readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const SOURCE = join(homedir(), '.dsh', 'workbuddy-market', 'cache', 'experts-market.json')
const OUT = process.argv[2] ?? join(process.cwd(), 'experts-market.json.gz')

/** Only what the card, the chip rail and the detail sheet read. */
const FIELDS = [
  'expert_id',
  'agent_name',
  'display_name_zh',
  'profession_zh',
  'profession_en',
  'description_zh',
  'icon',
  'version',
  'categories_detail',
  'tags_zh',
  'quick_prompts',
  'use_count',
  'default_init_prompt',
]

const raw = JSON.parse(await readFile(SOURCE, 'utf8'))
const items = []
for (const entry of raw.items ?? []) {
  const row = {}
  for (const field of FIELDS) {
    if (entry[field] !== undefined && entry[field] !== null) row[field] = entry[field]
  }
  if (typeof row.expert_id === 'string' || typeof row.agent_name === 'string') items.push(row)
}

const payload = {
  builtAt: new Date().toISOString(),
  source: 'yuze-market release asset (browse-only, no signed download urls)',
  total: items.length,
  items,
}

const json = JSON.stringify(payload)
const gz = gzipSync(Buffer.from(json, 'utf8'), { level: 9 })
await writeFile(OUT, gz)

const mb = n => `${(n / 1024 / 1024).toFixed(1)}MB`
console.log(`[expert-asset] ${items.length} 条 | 原始 ${mb(Buffer.byteLength(json))} → gzip ${mb(gz.length)}`)
console.log(`[expert-asset] 写入 ${OUT}`)
