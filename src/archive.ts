/**
 * Archive handling for market packages.
 *
 * The QuWork market distributes both skills and DSH plugins as zip archives
 * hosted on a CDN. Two independent rules apply:
 *
 *  - A zip is untrusted input. Extraction rejects absolute paths, `..`
 *    traversal, symlinks, and oversized members, and every extracted path is
 *    re-checked against the destination root.
 *  - A plugin zip is an npm package in disguise. It is repacked into a
 *    standard `package/`-prefixed npm tarball so pnpm can install it as a
 *    normal local dependency.
 */

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { createRequire } from 'node:module'
import { Readable } from 'node:stream'

const require = createRequire(import.meta.url)

export const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024
export const MAX_TOTAL_BYTES = 1024 * 1024 * 1024
export const MAX_ENTRIES = 20_000
export const MAX_DEPTH = 32
export const MAX_PATH_LENGTH = 512

export class ArchiveError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'ArchiveError'
  }
}

/** Reject a zip member path before it is written to disk. */
function assertSafeEntryPath(entryPath: string): void {
  if (entryPath.length === 0 || entryPath.length > MAX_PATH_LENGTH) {
    throw new ArchiveError('entry-path-invalid', '压缩包内路径长度非法')
  }
  if (entryPath.includes('\0')) {
    throw new ArchiveError('entry-path-invalid', '压缩包内路径包含空字节')
  }
  if (entryPath.startsWith('/') || /^[A-Za-z]:/u.test(entryPath)) {
    throw new ArchiveError('entry-path-absolute', '压缩包内包含绝对路径')
  }
  const segments = entryPath.split(/[/\\]/u)
  if (segments.some(segment => segment === '..')) {
    throw new ArchiveError('entry-path-traversal', '压缩包内包含上级目录穿越')
  }
  if (segments.filter(segment => segment !== '' && segment !== '.').length > MAX_DEPTH) {
    throw new ArchiveError('entry-depth-exceeded', '压缩包目录层级过深')
  }
}

/** Reject a path that escapes the extraction root after resolution. */
function assertInsideRoot(root: string, target: string): void {
  const resolvedRoot = resolve(root)
  const resolvedTarget = resolve(target)
  if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(resolvedRoot + sep)) {
    throw new ArchiveError('entry-path-escape', '压缩包解包越界')
  }
}

export interface DownloadedArchive {
  readonly path: string
  readonly bytes: number
  readonly sha256: string
  readonly cleanup: () => Promise<void>
}

/** Download an https archive with size and timeout ceilings. */
export async function downloadArchive(url: string, timeoutMs = 120_000): Promise<DownloadedArchive> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new ArchiveError('url-invalid', '下载地址非法')
  }
  if (parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '') {
    throw new ArchiveError('url-not-https', '下载地址必须是无凭据的 https 链接')
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const directory = await mkdtemp(join(tmpdir(), 'qurwork-market-'))
  const target = join(directory, 'download.archive')
  try {
    const response = await fetch(parsed.href, {
      signal: controller.signal,
      redirect: 'error',
    })
    if (!response.ok || response.body === null) {
      throw new ArchiveError('download-failed', `下载失败（${response.status}）`)
    }
    const declared = response.headers.get('content-length')
    if (declared !== null) {
      const size = Number(declared)
      if (Number.isFinite(size) && size > MAX_ARCHIVE_BYTES) {
        throw new ArchiveError('archive-too-large', '压缩包超过大小上限')
      }
    }
    const hash = createHash('sha256')
    let written = 0
    const source = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0])
    source.on('data', (chunk: Buffer) => {
      written += chunk.length
      if (written > MAX_ARCHIVE_BYTES) {
        source.destroy(new ArchiveError('archive-too-large', '压缩包超过大小上限'))
        return
      }
      hash.update(chunk)
    })
    await pipeline(source, createWriteStreamSafe(target))
    await stat(target)
    return {
      path: target,
      bytes: written,
      sha256: hash.digest('hex'),
      cleanup: async () => { await rm(directory, { recursive: true, force: true }) },
    }
  } catch (error) {
    await rm(directory, { recursive: true, force: true })
    if (error instanceof ArchiveError) throw error
    if (error instanceof Error && error.name === 'AbortError') {
      throw new ArchiveError('download-timeout', '下载超时')
    }
    throw new ArchiveError('download-failed', error instanceof Error ? error.message : String(error))
  } finally {
    clearTimeout(timer)
  }
}

function createWriteStreamSafe(target: string) {
  // Imported lazily so the module keeps a single filesystem dependency surface.
  const { createWriteStream } = require('node:fs') as typeof import('node:fs')
  return createWriteStream(target, { mode: 0o600 })
}

/** Extract a zip archive into `destination`, rejecting unsafe members. */
export async function extractZip(archivePath: string, destination: string): Promise<void> {
  const yauzl = require('yauzl') as typeof import('yauzl')
  await mkdir(destination, { recursive: true, mode: 0o700 })
  await new Promise<void>((resolvePromise, rejectPromise) => {
    yauzl.open(archivePath, { lazyEntries: true, autoClose: true }, (openError, zipfile) => {
      if (openError !== null || zipfile === undefined) {
        rejectPromise(new ArchiveError('zip-invalid', '压缩包无法打开'))
        return
      }
      let entries = 0
      let totalBytes = 0
      let settled = false
      const fail = (error: Error): void => {
        if (settled) return
        settled = true
        rejectPromise(error)
      }
      zipfile.on('error', () => fail(new ArchiveError('zip-invalid', '压缩包解析失败')))
      zipfile.on('end', () => {
        if (settled) return
        settled = true
        resolvePromise()
      })
      zipfile.on('entry', (entry: import('yauzl').Entry) => {
        if (settled) return
        entries += 1
        if (entries > MAX_ENTRIES) {
          zipfile.close()
          fail(new ArchiveError('too-many-entries', '压缩包条目过多'))
          return
        }
        try {
          assertSafeEntryPath(entry.fileName)
        } catch (error) {
          zipfile.close()
          fail(error instanceof Error ? error : new ArchiveError('entry-path-invalid', '压缩包内路径非法'))
          return
        }
        const externalFileAttributes = (entry as unknown as { externalFileAttributes?: number }).externalFileAttributes ?? 0
        const unixMode = (externalFileAttributes >>> 16) & 0xffff
        const isSymlink = (unixMode & 0o170000) === 0o120000
        const isDirectory = entry.fileName.endsWith('/')
        if (isSymlink) {
          zipfile.close()
          fail(new ArchiveError('symlink-rejected', '压缩包内包含符号链接'))
          return
        }
        const target = resolve(destination, entry.fileName)
        try {
          assertInsideRoot(destination, target)
        } catch (error) {
          zipfile.close()
          fail(error instanceof Error ? error : new ArchiveError('entry-path-escape', '压缩包解包越界'))
          return
        }
        if (isDirectory) {
          mkdir(target, { recursive: true, mode: 0o700 }).catch(() => undefined)
          zipfile.readEntry()
          return
        }
        totalBytes += entry.uncompressedSize
        if (totalBytes > MAX_TOTAL_BYTES) {
          zipfile.close()
          fail(new ArchiveError('archive-too-large', '压缩包解包后体积过大'))
          return
        }
        zipfile.openReadStream(entry, (streamError, readStream) => {
          if (streamError !== null || readStream === undefined) {
            fail(new ArchiveError('zip-invalid', '压缩包条目读取失败'))
            return
          }
          mkdir(dirname(target), { recursive: true, mode: 0o700 })
            .then(() => pipeline(readStream, createWriteStreamSafe(target)))
            .then(() => zipfile.readEntry())
            .catch(() => fail(new ArchiveError('zip-invalid', '压缩包条目写入失败')))
        })
      })
      zipfile.readEntry()
    })
  })
}

/** Locate the package root inside an extracted archive. */
export async function resolvePackageRoot(extracted: string): Promise<string> {
  const direct = join(extracted, 'package.json')
  try {
    const info = await stat(direct)
    if (info.isFile()) return extracted
  } catch {
    // fall through to the single-child scan
  }
  const { readdir } = await import('node:fs/promises')
  const entries = await readdir(extracted, { withFileTypes: true })
  const directories = entries.filter(entry => entry.isDirectory())
  for (const directory of directories) {
    const candidate = join(extracted, directory.name, 'package.json')
    try {
      const info = await stat(candidate)
      if (info.isFile()) return join(extracted, directory.name)
    } catch {
      // keep scanning
    }
  }
  throw new ArchiveError('package-root-missing', '压缩包内没有找到 package.json')
}

export interface PackageManifest {
  readonly name: string
  readonly version: string
  readonly hasDshManifest: boolean
}

/** Read and validate the package manifest of an extracted package root. */
export async function readPackageManifest(packageRoot: string): Promise<PackageManifest> {
  const manifestPath = join(packageRoot, 'package.json')
  let raw: unknown
  try {
    raw = JSON.parse(await readFile(manifestPath, 'utf8')) as unknown
  } catch {
    throw new ArchiveError('manifest-invalid', 'package.json 无法解析')
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ArchiveError('manifest-invalid', 'package.json 结构非法')
  }
  const record = raw as Record<string, unknown>
  const name = record.name
  const version = record.version
  if (typeof name !== 'string' || !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u.test(name)) {
    throw new ArchiveError('manifest-invalid', 'package.json 的 name 不是合法的 npm 包名')
  }
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version)) {
    throw new ArchiveError('manifest-invalid', 'package.json 的 version 不是精确的语义化版本')
  }
  const dsh = record.dsh
  const hasDshManifest = Boolean(dsh) && typeof dsh === 'object' && !Array.isArray(dsh)
  return { name, version, hasDshManifest }
}

/** Repack an extracted package root into a standard npm tarball. */
export async function createNpmArchive(packageRoot: string, destination: string): Promise<void> {
  const tar = require('tar') as typeof import('tar')
  await tar.c({
    cwd: packageRoot,
    file: destination,
    gzip: true,
    noMtime: true,
    portable: true,
    prefix: 'package/',
  }, ['.'])
  const info = await stat(destination)
  if (!info.isFile() || info.size > MAX_ARCHIVE_BYTES) {
    throw new ArchiveError('archive-too-large', '重打包后的压缩包超过大小上限')
  }
}

/** Write a file with restrictive permissions. */
export async function writePrivateFile(target: string, content: string): Promise<void> {
  await mkdir(dirname(target), { recursive: true, mode: 0o700 })
  await writeFile(target, content, { mode: 0o600 })
}

/** Compute the relative path of `target` under `root`, for logging. */
export function relativeUnder(root: string, target: string): string {
  const value = relative(root, target)
  return value.startsWith('..') ? target : value
}
