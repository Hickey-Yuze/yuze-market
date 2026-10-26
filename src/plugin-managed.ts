/**
 * Installed-plugin management: enable, disable and uninstall.
 *
 * The Desktop host composes the profile layer stack from exactly one field:
 * `dsh.profile.bundles` in the active profile's `package.json`. A package
 * that is a dependency but not a bundle is installed and listed, yet it is
 * never loaded — which is precisely the "disabled" state the UI shows.
 *
 * So the whole toggle is one list in one file:
 *
 * - enable  -> add the package name back to `dsh.profile.bundles`
 * - disable -> remove it from `dsh.profile.bundles`, keeping the dependency
 * - uninstall -> `pnpm remove` and then drop it from the bundle list
 *
 * Every write is atomic (write a sibling temporary file, then rename),
 * because the host may read the manifest while it is being rewritten.
 */

import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { InstalledPlugin } from './shared/types.js'
import type { PnpmRunner } from './plugin-install.js'

/** Packages the host refuses to let a third party toggle. */
const IMMUTABLE_BUNDLES = new Set(['dsh-base', 'dsh-web-app'])

/**
 * The bare package name, i.e. the unscoped part of `@scope/name`.
 *
 * The host's immutable bundles are named without a scope, so the comparison
 * has to drop it — `@deepseek-ai/dsh-base` is the very bundle `dsh-base`.
 */
function barePackageName(packageName: string): string {
  const slash = packageName.indexOf('/')
  return slash === -1 ? packageName : packageName.slice(slash + 1)
}

export interface PluginManagementOptions {
  /** The active profile directory, e.g. `~/.dsh/profiles/desktop`. */
  readonly profileDir: string
  /** The active profile name, e.g. `desktop`. */
  readonly profileName: string
  /** pnpm runner used for the uninstall. */
  readonly pnpm: PnpmRunner
  /** Optional pnpm registry override. */
  readonly registry?: string
}

export interface PluginMutationOutcome {
  readonly ok: boolean
  readonly packageName: string
  readonly error?: string
  readonly code?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function errorOutcome(packageName: string, error: string, code: string): PluginMutationOutcome {
  return { ok: false, packageName, error, code }
}

/** Read the profile manifest, or `undefined` when it cannot be parsed. */
async function readProfileManifest(profileDir: string): Promise<Record<string, unknown> | undefined> {
  let raw: string
  try {
    raw = await readFile(join(profileDir, 'package.json'), 'utf8')
  } catch {
    return undefined
  }
  try {
    const parsed = JSON.parse(raw) as unknown
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

/** Write the profile manifest atomically. */
async function writeProfileManifest(profileDir: string, manifest: Record<string, unknown>): Promise<boolean> {
  const manifestPath = join(profileDir, 'package.json')
  const temporary = `${manifestPath}.dsm-tmp`
  try {
    await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 })
    await rename(temporary, manifestPath)
    return true
  } catch {
    await rm(temporary, { force: true })
    return false
  }
}

/** Read the declared bundle names of a profile manifest. */
function readBundles(manifest: Record<string, unknown>): string[] {
  const dsh = isRecord(manifest.dsh) ? manifest.dsh : undefined
  const profile = dsh !== undefined && isRecord(dsh.profile) ? dsh.profile : undefined
  const bundles = profile !== undefined && Array.isArray(profile.bundles) ? profile.bundles : []
  return bundles.filter((item): item is string => typeof item === 'string')
}

/** Add or remove one package from `dsh.profile.bundles`. */
async function setBundle(profileDir: string, packageName: string, enabled: boolean): Promise<boolean> {
  const manifest = await readProfileManifest(profileDir)
  if (manifest === undefined) return false
  const dsh = isRecord(manifest.dsh) ? { ...manifest.dsh } : {}
  const profile = isRecord(dsh.profile) ? { ...dsh.profile } : {}
  const bundles = readBundles(manifest)
  const next = enabled
    ? bundles.includes(packageName)
      ? bundles
      : [...bundles, packageName]
    : bundles.filter((item) => item !== packageName)
  profile.bundles = next
  dsh.profile = profile
  return writeProfileManifest(profileDir, { ...manifest, dsh })
}

/**
 * Whether the package is declared as a dependency of the profile.
 *
 * The three outcomes are kept apart on purpose: an unreadable manifest is a
 * broken profile, not a package that happens to be missing.
 */
async function dependencyState(
  profileDir: string,
  packageName: string,
): Promise<'declared' | 'missing' | 'unreadable'> {
  const manifest = await readProfileManifest(profileDir)
  if (manifest === undefined) return 'unreadable'
  const dependencies = {
    ...(isRecord(manifest.dependencies) ? manifest.dependencies : {}),
    ...(isRecord(manifest.devDependencies) ? manifest.devDependencies : {}),
  }
  return packageName in dependencies ? 'declared' : 'missing'
}

/** Reject an operation when the target is not a direct profile dependency. */
async function rejectUndeclared(
  profileDir: string,
  packageName: string,
  missingMessage: string,
): Promise<PluginMutationOutcome | undefined> {
  const state = await dependencyState(profileDir, packageName)
  if (state === 'declared') return undefined
  if (state === 'unreadable') {
    return errorOutcome(packageName, 'profile 清单不可读', 'manifest-unavailable')
  }
  return errorOutcome(packageName, missingMessage, 'invalid-target')
}

/**
 * List the installed plugins with their live enable state.
 *
 * A plugin counts as enabled when the host will load it, that is when its
 * name is in `dsh.profile.bundles`.
 */
export async function listManagedPlugins(options: {
  readonly profileDir: string
}): Promise<InstalledPlugin[]> {
  const manifest = await readProfileManifest(options.profileDir)
  if (manifest === undefined) return []
  const dependencies = {
    ...(isRecord(manifest.dependencies) ? manifest.dependencies : {}),
    ...(isRecord(manifest.devDependencies) ? manifest.devDependencies : {}),
  }
  const bundles = new Set(readBundles(manifest))
  const result: InstalledPlugin[] = []
  for (const [packageName, version] of Object.entries(dependencies)) {
    if (typeof version !== 'string') continue
    if (packageName.startsWith('@deepseek-ai/')) continue
    result.push({
      packageName,
      version: version.startsWith('file:') ? '' : version.replace(/^[\^~]/u, ''),
      enabled: bundles.has(packageName),
      builtin: IMMUTABLE_BUNDLES.has(barePackageName(packageName)),
    })
  }
  return result
}

/** Enable or disable one installed plugin. */
export async function setPluginEnabled(
  options: PluginManagementOptions,
  packageName: string,
  enabled: boolean,
): Promise<PluginMutationOutcome> {
  if (typeof packageName !== 'string' || packageName.trim() === '') {
    return errorOutcome(packageName, '缺少插件名', 'bad-request')
  }
  if (IMMUTABLE_BUNDLES.has(barePackageName(packageName))) {
    return errorOutcome(packageName, '该插件不可停用', 'immutable-target')
  }
  const rejected = await rejectUndeclared(options.profileDir, packageName, '该插件未安装')
  if (rejected !== undefined) return rejected
  const written = await setBundle(options.profileDir, packageName, enabled)
  if (!written) return errorOutcome(packageName, '写入 profile 清单失败', 'persistence-failed')
  return { ok: true, packageName }
}

/** Remove one plugin from the profile: the npm dependency and the bundle row. */
export async function uninstallPlugin(
  options: PluginManagementOptions,
  packageName: string,
): Promise<PluginMutationOutcome> {
  if (typeof packageName !== 'string' || packageName.trim() === '') {
    return errorOutcome(packageName, '缺少插件名', 'bad-request')
  }
  if (IMMUTABLE_BUNDLES.has(barePackageName(packageName))) {
    return errorOutcome(packageName, '该插件不可卸载', 'immutable-target')
  }
  const rejected = await rejectUndeclared(options.profileDir, packageName, '该插件未安装')
  if (rejected !== undefined) return rejected

  const args = ['remove', packageName, '--reporter=ndjson']
  if (options.registry !== undefined) args.push(`--registry=${options.registry}`)
  const run = options.pnpm.runPlugin(args, options.profileDir)
  let stderr = ''
  let stdout = ''
  run.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8')
  })
  run.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8')
  })
  const done = await run.done
  if (done.exitCode !== 0) {
    const { describePnpmFailure } = await import('./plugin-install.js')
    return errorOutcome(
      packageName,
      describePnpmFailure(stdout, stderr) || `pnpm 退出码 ${done.exitCode ?? 'null'}`,
      'uninstall-failed',
    )
  }

  await setBundle(options.profileDir, packageName, false)
  return { ok: true, packageName }
}
