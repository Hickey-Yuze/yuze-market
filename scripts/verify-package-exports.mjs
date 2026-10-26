/**
 * Verify the package contract the Host relies on.
 *
 * The Host resolves the plugin through its `exports` map, reads the bundle
 * patch from `dsh.bundle.patch`, and mounts the client half through
 * `dsh.client`. Any mismatch here shows up as a plugin that silently does
 * not load, so the checks are explicit.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const failures = []

if (manifest.type !== 'module') failures.push('package.json 的 type 必须是 module')
if (manifest.main !== 'lib/index.js') failures.push('main 必须是 lib/index.js')
if (manifest.exports?.['.']?.default !== './lib/index.js') {
  failures.push('exports["."] 必须指向 ./lib/index.js')
}
if (manifest.exports?.['./client']?.default !== './lib/client.js') {
  failures.push('exports["./client"] 必须指向 ./lib/client.js')
}
if (manifest.exports?.['./package.json'] !== './package.json') {
  failures.push('exports 必须包含 ./package.json')
}
if (manifest.exports?.['./cordis.patch.yml'] !== './cordis.patch.yml') {
  failures.push('exports 必须包含 ./cordis.patch.yml')
}
if (manifest.dsh?.bundle?.patch !== './cordis.patch.yml') {
  failures.push('dsh.bundle.patch 必须是 ./cordis.patch.yml')
}
if (manifest.dsh?.client?.platform !== 'web') {
  failures.push('dsh.client.platform 必须是 web')
}
if (!Array.isArray(manifest.dsh?.client?.inject) || manifest.dsh.client.inject.length === 0) {
  failures.push('dsh.client.inject 必须是非空数组')
}

// The Host loads a client half only from packages that ship one. A package
// without a "./client" export is a platform seed module and has to be
// declared as external, or the module graph rejects the whole plugin.
const SEED_MODULES = new Set([
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
])
for (const dependency of manifest.dsh?.client?.inject ?? []) {
  if (SEED_MODULES.has(dependency)) {
    failures.push(`dsh.client.inject 不能包含平台 seed 模块 ${dependency}，应放入 dsh.client.external`)
  }
}
for (const dependency of manifest.dsh?.client?.external ?? []) {
  if (!SEED_MODULES.has(dependency)) {
    failures.push(`dsh.client.external 只能声明平台 seed 模块，${dependency} 不是`)
  }
}
for (const dependency of Object.keys(manifest.dependencies ?? {})) {
  if (dependency.startsWith('@deepseek-ai/')) {
    failures.push(`禁止声明 @deepseek-ai 依赖：${dependency}`)
  }
}
if (!Array.isArray(manifest.files) || !manifest.files.includes('lib')) {
  failures.push('files 必须包含 lib')
}

// The bundle patch must insert this exact package under this exact id.
let patch
try {
  patch = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')
} catch {
  failures.push('缺少 cordis.patch.yml')
}
if (patch !== undefined) {
  if (!patch.includes(`- id: ${manifest.name}`)) {
    failures.push(`cordis.patch.yml 的 insert id 必须是 ${manifest.name}`)
  }
  if (!patch.includes(`name: ${manifest.name}`) && !patch.includes(`name: '${manifest.name}'`)) {
    failures.push(`cordis.patch.yml 的 insert name 必须是 ${manifest.name}`)
  }
}

if (failures.length > 0) {
  console.error('[verify-package-exports] 失败：')
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}

console.log(`[verify-package-exports] 通过：${manifest.name} 的包契约完整`)
