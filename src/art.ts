/**
 * Brand artwork for every catalogue entry, served from the local cache.
 *
 * Upstream ships three different icon shapes and the panel should never have to
 * know which is which:
 *
 * - connectors: a file relative to the connector directory
 *   (`ai.workbuddy/assets/icon.png`)
 * - skills: a loose `<source>.<svg|png>` under the marketplace bundle's `icons/`
 * - experts: an absolute https URL on the CDN
 *
 * The first two are read from disk (no outbound request, no CSP surprise); the
 * last redirects to the CDN so the renderer can cache it like any image.
 * Every path is resolved and re-checked against its root: `icon.file` and `name`
 * both come from upstream JSON.
 */

import { readFile, stat } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'

import type { MarketItem, MarketKind } from './wb/types.js'

export interface ArtResult {
  readonly kind: 'bytes' | 'redirect' | 'none'
  readonly bytes?: Buffer
  readonly contentType?: string
  readonly location?: string
}

/** The slice of the catalogue this module needs. */
export interface ArtCatalog {
  find(kind: MarketKind, id: string): Promise<MarketItem | undefined>
}

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  png: 'image/png',
  svg: 'image/svg+xml',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
}

function inside(root: string, candidate: string): boolean {
  const normalizedRoot = root.endsWith(sep) ? root : `${root}${sep}`
  return candidate === root || candidate.startsWith(normalizedRoot)
}

async function readImage(path: string, format?: string): Promise<ArtResult> {
  try {
    const info = await stat(path)
    if (!info.isFile() || info.size === 0) return { kind: 'none' }
    const extension = (format ?? path.split('.').pop() ?? '').toLowerCase()
    return {
      kind: 'bytes',
      bytes: await readFile(path),
      contentType: CONTENT_TYPES[extension] ?? 'application/octet-stream',
    }
  } catch {
    return { kind: 'none' }
  }
}

/** A skill icon lives next to the unpacked marketplace bundle, keyed by source slug. */
async function skillArt(item: MarketItem, cacheRoot: string): Promise<ArtResult> {
  const bundle = item.zipName ?? item.source
  const slug = item.source ?? item.name
  if (bundle === undefined || slug === undefined) return { kind: 'none' }

  const iconsRoot = resolve(cacheRoot, 'skills', bundle, 'icons')
  for (const extension of ['svg', 'png', 'webp', 'jpg']) {
    const candidate = resolve(iconsRoot, `${slug}.${extension}`)
    if (!inside(iconsRoot, candidate)) continue
    const found = await readImage(candidate, extension)
    if (found.kind !== 'none') return found
  }
  return { kind: 'none' }
}

/** A connector icon ships inside the connector package. */
async function connectorArt(item: MarketItem, cacheRoot: string): Promise<ArtResult> {
  const icon = item.icon
  // Upstream writes an explicit `null` for connectors without artwork.
  if (icon == null) return { kind: 'none' }
  const connectorRoot = resolve(cacheRoot, 'mcp-connectors', 'extracted', 'connectors', item.dirName ?? item.name)
  const candidate = resolve(connectorRoot, icon.file)
  if (!inside(connectorRoot, candidate)) return { kind: 'none' }
  return await readImage(candidate, icon.format)
}

/**
 * Resolve the artwork for one entry.
 *
 * `kind` is the catalogue family; an unknown id or a missing file returns
 * `none` so the client can fall back to its own placeholder instead of a broken
 * image request.
 */
export async function resolveArt(
  catalog: ArtCatalog,
  cacheRoot: string,
  kind: MarketKind,
  id: string,
): Promise<ArtResult> {
  const item = await catalog.find(kind, id)
  if (item === undefined) return { kind: 'none' }

  switch (kind) {
    case 'connector':
      return await connectorArt(item, cacheRoot)
    case 'skill':
      return await skillArt(item, cacheRoot)
    case 'expert': {
      const location = typeof item.avatarUrl === 'string' ? item.avatarUrl : undefined
      if (location === undefined || !/^https:\/\//u.test(location)) return { kind: 'none' }
      return { kind: 'redirect', location }
    }
  }
}

/** Convenience for the routes: the on-disk bundle root a skill came from. */
export function skillBundleRoot(cacheRoot: string, zipName: string): string {
  return join(cacheRoot, 'skills', zipName)
}
