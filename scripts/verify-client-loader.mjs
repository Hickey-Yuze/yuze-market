/**
 * Verify that the built client half is a valid Host module loader bundle.
 *
 * The Host loads `lib/client.js` by evaluating it and calling
 * `window.__ModuleLoader__.load({ id, factory })`. The bundle must therefore
 * open with that exact call, name the package as the module id, and close by
 * returning the module exports.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const { name } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const bundlePath = join(root, 'lib', 'client.js')

let bundle
try {
  bundle = readFileSync(bundlePath, 'utf8')
} catch {
  console.error(`[verify-client-loader] 缺少构建产物：${bundlePath}`)
  process.exit(1)
}

const failures = []

const loaderCall = `window.__ModuleLoader__.load({ id: ${JSON.stringify(name)}`
if (!bundle.includes(loaderCall)) {
  failures.push(`bundle 未以 ${loaderCall} 开头`)
}
if (!/return module\.exports;\s*\}\s*\}\);\s*$/u.test(bundle.trimEnd())) {
  failures.push('bundle 缺少结尾的 `return module.exports; } });`')
}
if (!bundle.includes('exports.inject = inject;')) {
  failures.push('bundle 未导出 inject')
}
if (!bundle.includes('exports.apply = apply;')) {
  failures.push('bundle 未导出 apply')
}
if (bundle.includes('require("react")') || bundle.includes("require('react')")) {
  failures.push('react 被打进 bundle，宿主要求 react 保持 external')
}
// A required @deepseek-ai module stays external: the bundle must reference it
// through require() rather than carrying an inlined copy of its source.
for (const match of bundle.matchAll(/require2?\("(@deepseek-ai\/[^"]+)"\)/g)) {
  const moduleId = match[1]
  const externalCalls = bundle.split(`require2("${moduleId}")`).length - 1
  if (externalCalls === 0) {
    failures.push(`@deepseek-ai 依赖未通过 require 引用：${moduleId}`)
  }
}
if (/from\s+["']@deepseek-ai\//u.test(bundle) || /import\s+["']@deepseek-ai\//u.test(bundle)) {
  failures.push('bundle 含 ESM 形式的 @deepseek-ai import，宿主 loader 期望 CJS require')
}

if (failures.length > 0) {
  console.error('[verify-client-loader] 失败：')
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}

console.log(`[verify-client-loader] 通过：lib/client.js 是 ${name} 的合法 ModuleLoader bundle`)
