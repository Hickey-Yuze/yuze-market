/**
 * Materialise the snapshots embedded in the package.
 *
 * A fresh install on another machine has an empty cache, which used to mean
 * "the skill list is empty until you run a script". The small catalogues are
 * shipped inside the package (gz), so the first boot can unpack them; the large
 * expert catalogue is fetched on demand instead (see `snapshot-routes`).
 *
 * Runs once per cache key: an existing file always wins, so a locally synced
 * snapshot is never overwritten by the older bundled copy.
 */

import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { gunzipSync } from 'node:zlib'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** `<package>/assets`, next to `lib/`. */
const ASSETS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets')

const BUNDLED: readonly { readonly file: string; readonly target: string }[] = [
  { file: 'skills-market.json.gz', target: 'skills-market.json' },
  { file: 'skills-zh.json.gz', target: 'skills-zh.json' },
]

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/**
 * Unpack any bundled snapshot the cache is missing.
 * Returns the names it materialised, for logging and diagnostics.
 */
export async function ensureBundledAssets(cacheRoot: string): Promise<readonly string[]> {
  const unpacked: string[] = []
  for (const asset of BUNDLED) {
    const target = join(cacheRoot, asset.target)
    if (await exists(target)) continue
    let raw: Buffer
    try {
      raw = await readFile(join(ASSETS_DIR, asset.file))
    } catch {
      // A package built without assets (e.g. CI) simply skips this.
      continue
    }
    try {
      await mkdir(cacheRoot, { recursive: true })
      await writeFile(target, gunzipSync(raw))
      unpacked.push(asset.target)
    } catch {
      // A corrupt bundle must not stop the plugin from loading.
    }
  }
  return unpacked
}
