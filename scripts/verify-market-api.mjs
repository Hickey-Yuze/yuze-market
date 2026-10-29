/**
 * End-to-end check of the 市场 API (`/api/yuze-market/*`).
 *
 * Builds a throwaway DSH home — one skill, one expert, one installed connector,
 * a profile manifest with a plugin, and a tiny catalogue with brand artwork — so
 * every route is exercised against real files instead of mocks:
 *
 *   items (4 tabs, merged + deduped)   art (skill + connector bytes)
 *   installed                          enable / disable / remove (skills)
 *   connector enable / disable / remove   plugin enable / remove
 *   manual skill / connector
 *
 * Run: npm run verify:api
 */
import { createServer } from 'node:http'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { createReadStream } from 'node:fs'

import { Aggregator } from '../scratch/server-out/aggregate.js'
import { installMarketExpert } from '../scratch/server-out/market-expert-install.js'
import { MarketApiClient } from '../scratch/server-out/market-api.js'
import { MarketCatalog } from '../scratch/server-out/wb/catalog.js'
import { mountUnifiedRoutes } from '../scratch/server-out/unified-routes.js'
import { writeZip } from './lib/minizip.mjs'
import { downloadExpertSnapshot, expertSnapshotProgress } from '../scratch/server-out/snapshot.js'
import { gzipSync } from 'node:zlib'

const HOME = join(process.cwd(), 'scratch', 'api-home')
const SKILL_ROOT = join(HOME, 'skills')
const CACHE = join(HOME, 'workbuddy-market', 'cache')
const PROFILE = join(HOME, 'profiles', 'desktop')
const PATCH = join(PROFILE, 'cordis.patch.yml')

let failures = 0
function check(label, condition, detail) {
  if (condition) {
    console.log(`  ok   ${label}`)
    return
  }
  failures += 1
  console.log(`  FAIL ${label}${detail === undefined ? '' : ` → ${detail}`}`)
}

const skillMd = (name, description) => `---\nname: ${name}\ndescription: ${description}\n---\n\n正文\n`

// -------------------------------------------------------------- fake market

const remoteSkill = {
  id: 9001,
  name: 'remote-skill',
  name_cn: '远程技能',
  description: '来自远程市场的技能',
  version: '2.0.0',
  tags: ['远程'],
  categories: ['效率'],
  owner: 'tester',
  url: 'https://example.test/skill.zip',
}

const market = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1')
  const json = body => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify(body))
  }
  if (url.pathname === '/api/skill/list') {
    return json({ items: [remoteSkill], total: 1 })
  }
  if (url.pathname === '/api/dsh_plugin/list') {
    return json({
      items: [
        {
          id: 7001,
          name: 'dsh-demo-plugin',
          name_cn: '示例插件',
          description: '一个远程插件',
          version: '1.0.0',
          tags: [],
          keywords: [],
          author: 'tester',
          download_url: 'https://example.test/plugin.zip',
        },
      ],
      total: 1,
    })
  }
  response.writeHead(404).end('{}')
})

// ------------------------------------------------------------------ fixtures

async function seed() {
  await rm(HOME, { recursive: true, force: true })
  await mkdir(SKILL_ROOT, { recursive: true })
  await mkdir(PROFILE, { recursive: true })

  // one ordinary skill
  await mkdir(join(SKILL_ROOT, 'alpha'), { recursive: true })
  await writeFile(join(SKILL_ROOT, 'alpha', 'SKILL.md'), skillMd('alpha', '本地技能 A'))
  await writeFile(
    join(SKILL_ROOT, 'alpha', '.workbuddy-market.json'),
    JSON.stringify({ kind: 'skill', id: 'alpha', title: '技能甲', installedAt: '2026-01-01T00:00:00.000Z' }),
  )

  // one expert
  await mkdir(join(SKILL_ROOT, 'beta'), { recursive: true })
  await writeFile(join(SKILL_ROOT, 'beta', 'SKILL.md'), skillMd('beta', '专家 B'))
  await writeFile(
    join(SKILL_ROOT, 'beta', '.workbuddy-market.json'),
    JSON.stringify({ kind: 'expert', id: 'beta', title: '专家乙' }),
  )

  // catalogue: one skill, one expert, one connector (with artwork on disk)
  const catalog = {
    builtAt: '2026-01-01T00:00:00.000Z',
    experts: {
      items: [
        {
          kind: 'expert',
          id: 'beta',
          name: 'beta',
          title: '专家乙',
          description: '目录里的专家',
          category: '效率',
          tags: [],
          avatarUrl: 'https://example.test/avatar.png',
          quickPrompts: ['帮我做一页提纲'],
          promptUrl: 'https://example.test/beta.md',
          installable: true,
        },
        {
          kind: 'expert',
          id: 'ui-one',
          name: 'ui-one',
          title: '像素君',
          titleEn: 'Pixel',
          profession: 'UI 设计师',
          description: '精通设计系统与组件库',
          descriptionEn: 'Owns the design system and frontend components',
          category: '产品设计',
          tags: ['UI设计', '组件库'],
          avatarUrl: 'https://example.test/ui.png',
          promptUrl: 'https://example.test/ui.md',
          installable: true,
        },
        {
          kind: 'expert',
          id: 'gamma',
          name: 'gamma',
          title: '专家丙',
          description: '未安装的专家',
          category: '写作',
          tags: [],
          avatarUrl: 'https://example.test/gamma.png',
          promptUrl: 'https://example.test/gamma.md',
          installable: true,
        },
      ],
    },
    skills: {
      items: [
        {
          kind: 'skill',
          id: 'alpha',
          name: 'alpha',
          title: '技能甲',
          description: '目录里的技能',
          category: '效率',
          tags: [],
          emoji: '🧩',
          version: '1.0.0',
          source: 'alpha',
          zipName: 'bundle-a',
          examples: ['示例问题一'],
          installable: true,
        },
      ],
    },
    connectors: {
      items: [
        {
          kind: 'connector',
          id: 'foo',
          name: 'foo',
          title: '连接器甲',
          description: '示例 MCP',
          category: '工具',
          tags: [],
          version: '1.0.0',
          mcp: { serverName: 'foo', transport: 'streamable-http', url: 'https://example.test/mcp' },
          icon: { file: 'ai.workbuddy/assets/icon.png', format: 'png' },
          dirName: 'foo',
          installable: true,
        },
        {
          // Upstream writes explicit nulls; a row like this used to throw and
          // take the whole list down.
          kind: 'connector',
          id: 'bare',
          name: 'bare',
          title: '没有 MCP 的连接器',
          description: '',
          tags: [],
          mcp: null,
          icon: null,
          installable: false,
          installNote: '只提供 hooks',
        },
      ],
    },
    totals: { experts: 3, skills: 1, connectors: 1 },
  }
  await mkdir(CACHE, { recursive: true })
  await writeFile(join(CACHE, 'catalog.json'), JSON.stringify(catalog))

  // skill artwork + connector artwork on disk
  await mkdir(join(CACHE, 'skills', 'bundle-a', 'icons'), { recursive: true })
  await writeFile(join(CACHE, 'skills', 'bundle-a', 'icons', 'alpha.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')
  const connectorAssets = join(CACHE, 'mcp-connectors', 'extracted', 'connectors', 'foo', 'ai.workbuddy', 'assets')
  await mkdir(connectorAssets, { recursive: true })
  await writeFile(join(connectorAssets, 'icon.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))

  // a skill that ships inside a local marketplace package
  const packagedSkill = join(HOME, 'marketplace', 'pkg', 'skills', 'packaged-skill')
  await mkdir(packagedSkill, { recursive: true })
  await writeFile(
    join(packagedSkill, 'SKILL.md'),
    '---\nname: packaged-skill\ndescription: 来自本地市场包的技能\n---\n\n正文\n',
  )
  await writeFile(
    join(CACHE, 'skills-market.json'),
    JSON.stringify({
      builtAt: new Date().toISOString(),
      total: 1,
      items: [
        { name: 'packaged-skill', title: 'packaged-skill', description: '来自本地市场包的技能', market: 'official', plugin: 'pkg', dir: packagedSkill },
      ],
    }),
  )

  // profile: one connector entry + one installed plugin
  await writeFile(
    PATCH,
    `# test patch
- insert:
    - id: mcp-wbm-foo
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: foo
        transport: streamable-http
        url: 'https://example.test/mcp'
`,
  )
  await writeFile(
    join(PROFILE, 'package.json'),
    JSON.stringify({
      name: 'desktop',
      dependencies: { 'dsh-demo-plugin': '^1.0.0' },
      dsh: { profile: { bundles: ['dsh-demo-plugin'] } },
    }),
  )
}

// ------------------------------------------------------------------- harness

const fakePnpm = {
  runPlugin: () => ({
    stdout: { on: () => {} },
    stderr: { on: () => {} },
    done: Promise.resolve({ exitCode: 0, signal: null }),
    cancel: () => {},
  }),
}

await seed()
await new Promise(resolve => market.listen(0, '127.0.0.1', resolve))
const marketUrl = `http://127.0.0.1:${market.address().port}`

const catalog = new MarketCatalog(join(CACHE, 'catalog.json'))
const api = new MarketApiClient(marketUrl)

// A two-row cloud snapshot: one with a live signature, one already expired.
const snapshotPath = join(CACHE, 'experts-market.json')
await writeFile(
  snapshotPath,
  JSON.stringify({
    builtAt: new Date().toISOString(),
    total: 2,
    items: [
      {
        expert_id: 'ex_live',
        agent_name: 'cloud-live',
        profession_zh: '云端可用专家',
        description_zh: '带有效下载地址',
        icon: 'https://example.test/live.png',
        categories_detail: [{ name_zh: '技术工程' }],
        tags_zh: ['云端'],
        use_count: 12345,
        download_url: 'https://example.test/live.zip',
        download_expires_at: Date.now() + 86_400_000,
      },
      {
        expert_id: 'ex_stale',
        agent_name: 'cloud-stale',
        profession_zh: '云端过期专家',
        description_zh: '下载地址已过期',
        use_count: 10,
        download_url: 'https://example.test/stale.zip',
        download_expires_at: Date.now() - 1000,
      },
    ],
  }),
)

const aggregator = new Aggregator({ catalog, market: api, expertSnapshot: snapshotPath, skillSnapshot: join(CACHE, 'skills-market.json') })

const routes = []
const dispose = mountUnifiedRoutes(
  route => {
    routes.push(route)
    return () => {}
  },
  {
    aggregator,
    catalog,
    market: api,
    cacheRoot: CACHE,
    skillRoot: SKILL_ROOT,
    profileDir: PROFILE,
    profileName: 'desktop',
    profilePath: PATCH,
    backupDir: join(HOME, 'backups'),
    receiptDir: join(HOME, 'receipts'),
    pnpm: fakePnpm,
  },
)

const server = createServer((request, response) => {
  for (const route of routes) {
    if ((request.url ?? '').startsWith(route.path)) return route.handler(request, response)
  }
  response.writeHead(404).end('no route')
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}/api/yuze-market`

const get = async path => {
  const response = await fetch(`${base}${path}`)
  return { status: response.status, body: await response.json().catch(() => ({})) }
}
const post = async (path, payload, headers = {}) => {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(payload),
  })
  return { status: response.status, body: await response.json().catch(() => ({})) }
}

try {
  console.log('\n1. 技能 tab：两个市场合并、同名去重')
  {
    const { status, body } = await get('/items?tab=skill&pageSize=100')
    check('HTTP 200', status === 200, status)
    check('合并后有 3 条（本地市场包 + 目录 + 远程）', body.items.length === 3, body.items.map(i => i.name).join(','))
    check('本地市场包的技能排在最前', body.items[0].id.startsWith('skillfile:'), body.items[0].id)
    check('目录条目紧随其后', body.items[1].name === 'alpha', body.items[1]?.name)
    const remote = body.items.find(item => item.name === 'remote-skill')
    check('远程条目带来源标记', remote?.origin === 'remote', remote?.origin)
    check('分类来自合并结果', body.categories.length >= 1, JSON.stringify(body.categories))
    check('目录条目有 artUrl', body.items.filter(item => item.id.startsWith('local:skill:')).every(item => typeof item.artUrl === 'string'))
  }

  console.log('\n2. 专家 / 连接器 / 插件 tab')
  {
    const experts = await get('/items?tab=expert&pageSize=100')
    check('专家 5 条（3 本地 + 2 云端）', experts.body.items.length === 5, experts.body.items.length)
    const bundled = experts.body.items.find(item => item.name === 'beta')
    check('本地专家带引导语', Array.isArray(bundled?.quickPrompts), JSON.stringify(bundled))

    const connectors = await get('/items?tab=connector&pageSize=100')
    check('连接器 2 条（含 mcp:null 的坏行）', connectors.body.items.length === 2, connectors.body.items.length)
    check('连接器带传输方式', connectors.body.items[0].transport === 'streamable-http')
    check('mcp:null 的条目仍可列出', connectors.body.items.some(item => item.name === 'bare'), JSON.stringify(connectors.body.items.map(i => i.name)))
    const bare = connectors.body.items.find(item => item.name === 'bare')
    check('无 MCP 的提示是「没有声明端点」', (bare?.installNote ?? '').includes('没有声明 MCP 端点'), bare?.installNote)

    const plugins = await get('/items?tab=plugin&pageSize=100')
    check('插件来自远程', plugins.body.items.length === 1 && plugins.body.items[0].origin === 'remote', plugins.body.items.length)

    const bad = await get('/items?tab=nope')
    check('非法 tab → 400', bad.status === 400, bad.status)
  }

  console.log('\n2b. 云端专家快照')
  {
    const experts = await get('/items?tab=expert&pageSize=100')
    const names = experts.body.items.map(item => item.name)
    check('云端专家并进列表', names.includes('cloud-live') && names.includes('cloud-stale'), names.join(','))
    check('按使用量降序', experts.body.items[0].name === 'cloud-live', names[0])
    const live = experts.body.items.find(item => item.name === 'cloud-live')
    check('带地址的云端专家可安装', live?.installable === true, JSON.stringify(live))
    check('带使用量', live?.usage === 12345, live?.usage)
    check('带云端徽标', live?.badge === '云端', live?.badge)
    check('用 CDN 图标', String(live?.artUrl).startsWith('https://example.test'), live?.artUrl)
    const stale = experts.body.items.find(item => item.name === 'cloud-stale')
    // 签名改为安装时现取，快照里的过期地址不再决定可安装性
    check('过期签名仍可尝试安装', stale?.installable === true, JSON.stringify(stale))
  }

  console.log('\n3. 搜索覆盖职业名 / 标签 / 英文描述')
  {
    const byProfession = await get('/items?tab=expert&q=' + encodeURIComponent('UI 设计师'))
    check('按职业名搜到', byProfession.body.items.some(item => item.name === 'ui-one'), byProfession.body.items.length)
    const byTag = await get('/items?tab=expert&q=' + encodeURIComponent('组件库'))
    check('按标签搜到', byTag.body.items.some(item => item.name === 'ui-one'), byTag.body.items.length)
    const byEnglish = await get('/items?tab=expert&q=frontend')
    check('按英文描述搜到', byEnglish.body.items.some(item => item.name === 'ui-one'), byEnglish.body.items.length)
    const shown = byEnglish.body.items.find(item => item.name === 'ui-one')
    check('专家标题用职业名', shown?.title === 'UI 设计师', shown?.title)
    check('人名不出现在标题里', shown?.title !== '像素君')
  }

  console.log('\n3b. 搜索与分类过滤')
  {
    const search = await get('/items?tab=expert&q=丙')
    check('按中文标题搜索', search.body.items.length === 1 && search.body.items[0].name === 'gamma', search.body.items.length)
    const filtered = await get(`/items?tab=expert&category=${encodeURIComponent('写作')}`)
    check('按分类过滤', filtered.body.items.length === 1 && filtered.body.items[0].name === 'gamma')
  }

  console.log('\n4. 图标')
  {
    const skillArt = await fetch(`${base}/art?id=${encodeURIComponent('local:skill:alpha')}`)
    check('技能图标 200', skillArt.status === 200, skillArt.status)
    check('技能图标是 svg', (skillArt.headers.get('content-type') ?? '').includes('svg'), skillArt.headers.get('content-type'))

    const connectorArt = await fetch(`${base}/art?id=${encodeURIComponent('local:connector:foo')}`)
    check('连接器图标 200', connectorArt.status === 200, connectorArt.status)
    check('连接器图标是 png', connectorArt.headers.get('content-type') === 'image/png', connectorArt.headers.get('content-type'))

    const expertArt = await fetch(`${base}/art?id=${encodeURIComponent('local:expert:beta')}`, { redirect: 'manual' })
    check('专家图标 302 到 CDN', expertArt.status === 302, expertArt.status)
    check('重定向目标是头像地址', expertArt.headers.get('location') === 'https://example.test/avatar.png', expertArt.headers.get('location'))

    const missing = await fetch(`${base}/art?id=${encodeURIComponent('local:skill:nope')}`)
    check('缺失图标 404', missing.status === 404, missing.status)
  }

  console.log('\n5. 已安装总览')
  {
    const { body } = await get('/installed')
    check('技能含 alpha', body.skills.some(entry => entry.name === 'alpha'))
    check('专家 kind=expert', body.skills.find(entry => entry.name === 'beta')?.kind === 'expert')
    check('连接器 enabled=true', body.connectors[0]?.enabled === true, JSON.stringify(body.connectors))
    check('插件来自 profile', body.plugins[0]?.packageName === 'dsh-demo-plugin')
  }

  console.log('\n6. 技能停用 / 启用 / 删除')
  {
    const off = await post('/enable', { name: 'alpha', enabled: false })
    check('停用 HTTP 200', off.status === 200 && off.body.ok === true, JSON.stringify(off.body))
    check('目录搬进 .disabled', await stat(join(SKILL_ROOT, '.disabled', 'alpha', 'SKILL.md')).then(() => true, () => false))
    check('正式目录已消失', await stat(join(SKILL_ROOT, 'alpha')).then(() => false, () => true))
    const listed = await get('/installed')
    check('列表里标记为停用', listed.body.skills.find(entry => entry.name === 'alpha')?.enabled === false)

    const on = await post('/enable', { name: 'alpha', enabled: true })
    check('启用 HTTP 200', on.status === 200 && on.body.ok === true)
    check('目录搬回原位', await stat(join(SKILL_ROOT, 'alpha', 'SKILL.md')).then(() => true, () => false))

    const removed = await post('/remove', { name: 'alpha' })
    check('删除 HTTP 200', removed.status === 200 && removed.body.ok === true, JSON.stringify(removed.body))
    check('技能目录已删除', await stat(join(SKILL_ROOT, 'alpha')).then(() => false, () => true))
    const trash = await readFile(join(HOME, 'skills'), 'utf8').catch(() => '')
    void trash
    const listed2 = await get('/installed')
    check('列表里已消失', !listed2.body.skills.some(entry => entry.name === 'alpha'))
    check('非法的名字被拒绝', (await post('/remove', { name: '../etc' })).status === 409)
  }

  console.log('\n7. 连接器停用 / 删除')
  {
    const off = await post('/connector', { serverName: 'foo', enabled: false })
    check('停用 HTTP 200', off.status === 200 && off.body.ok === true, JSON.stringify(off.body))
    const text = await readFile(PATCH, 'utf8')
    check('写入 disabled: true', /disabled:\s*true/u.test(text), text)
    const listed = await get('/installed')
    check('列表里 enabled=false', listed.body.connectors[0]?.enabled === false)

    const on = await post('/connector', { serverName: 'foo', enabled: true })
    check('启用后移除标记', on.body.ok === true && !/disabled:\s*true/u.test(await readFile(PATCH, 'utf8')))

    const removed = await post('/connector', { serverName: 'foo', remove: true })
    check('删除 HTTP 200', removed.body.ok === true, JSON.stringify(removed.body))
    check('条目已从 patch 移除', !(await readFile(PATCH, 'utf8')).includes('mcp-wbm-foo'))
    const listed2 = await get('/installed')
    check('列表为空', listed2.body.connectors.length === 0)
  }

  console.log('\n8. 插件停用 / 卸载')
  {
    const off = await post('/plugin', { packageName: 'dsh-demo-plugin', enabled: false })
    check('停用 HTTP 200', off.body.ok === true, JSON.stringify(off.body))
    const manifest = JSON.parse(await readFile(join(PROFILE, 'package.json'), 'utf8'))
    check('从 bundles 移除', !manifest.dsh.profile.bundles.includes('dsh-demo-plugin'), JSON.stringify(manifest.dsh))

    const on = await post('/plugin', { packageName: 'dsh-demo-plugin', enabled: true })
    check('启用写回 bundles', on.body.ok === true)
    const again = JSON.parse(await readFile(join(PROFILE, 'package.json'), 'utf8'))
    check('bundles 已恢复', again.dsh.profile.bundles.includes('dsh-demo-plugin'))
    check('内置插件不可停用', (await post('/plugin', { packageName: '@deepseek-ai/dsh-base', enabled: false })).status === 409)
  }

  console.log('\n9. 手动安装')
  {
    const source = join(HOME, 'manual-src')
    await mkdir(source, { recursive: true })
    await writeFile(join(source, 'SKILL.md'), skillMd('manual-skill', '手动装进来的'))
    const installed = await post('/manual', { target: 'skill', path: source, name: 'manual-skill' })
    check('技能手动安装成功', installed.body.ok === true, JSON.stringify(installed.body))
    check('落地到 skills 根', await stat(join(SKILL_ROOT, 'manual-skill', 'SKILL.md')).then(() => true, () => false))

    const packaged = await post('/install', { id: 'skillfile:packaged-skill' })
    check('本地市场技能安装成功', packaged.body.ok === true, JSON.stringify(packaged.body))
    check('复制到了 skills 根', await stat(join(SKILL_ROOT, 'packaged-skill', 'SKILL.md')).then(() => true, () => false))

    const connector = await post('/manual', {
      target: 'connector',
      json: JSON.stringify({ mcpServers: { bar: { transport: 'streamable-http', url: 'https://example.test/bar' } } }),
    })
    check('连接器手动添加成功', connector.body.ok === true, JSON.stringify(connector.body))
    check('写入 patch', (await readFile(PATCH, 'utf8')).includes('serverName: bar'))

    const badJson = await post('/manual', { target: 'connector', json: '{oops' })
    check('坏 JSON 明确报错', badJson.body.ok === false && badJson.body.code === 'bad-json', JSON.stringify(badJson.body))

    const sse = await post('/manual', {
      target: 'connector',
      json: JSON.stringify({ serverName: 'sse-one', transport: 'sse', url: 'https://example.test/sse' }),
    })
    check('SSE 传输被拒绝', sse.body.ok === false && sse.body.code === 'unsupported-transport', JSON.stringify(sse.body))
  }

  console.log('\n10. 云端专家安装（下载 zip → 转成技能）')
  {
    const pkg = join(HOME, 'expert-pkg')
    await mkdir(join(pkg, '.codebuddy-plugin'), { recursive: true })
    await mkdir(join(pkg, 'agents'), { recursive: true })
    await writeFile(
      join(pkg, '.codebuddy-plugin', 'plugin.json'),
      JSON.stringify({ agentName: 'cloud-install-test', agents: ['./agents/test.md'], version: '9.9.9' }),
    )
    await writeFile(
      join(pkg, 'agents', 'test.md'),
      '---\nname: whatever\ndescription: 来自云端包的专家\n---\n\n你是测试专家。\n',
    )
    // Store-only zip written in-process: `zip` does not exist on Windows runners.
    const zipPath = join(HOME, 'expert.zip')
    await writeZip(zipPath, [
      {
        name: '.codebuddy-plugin/plugin.json',
        data: JSON.stringify({ agentName: 'cloud-install-test', agents: ['./agents/test.md'], version: '9.9.9' }),
      },
      {
        name: 'agents/test.md',
        data: [
          '---',
          'name: whatever',
          'description: 来自云端包的专家',
          '---',
          '',
          '你是测试专家。详见 `skills/helper/SKILL.md`，封面见 ![图](assets/cover.png)。',
          '另有一个正文未提及的孤儿文件。',
          '',
        ].join('\n'),
      },
      { name: 'skills/helper/SKILL.md', data: '---\nname: helper\ndescription: 附加技能\n---\n\n辅助内容\n' },
      { name: 'skills/helper/notes.md', data: '辅助备注\n' },
      { name: 'assets/cover.png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
      { name: 'assets/orphan.txt', data: '不该被带走\n' },
    ])

    const fileServer = createServer((request, response) => {
      response.setHeader('content-type', 'application/zip')
      createReadStream(zipPath).pipe(response)
    })
    await new Promise(resolve => fileServer.listen(0, '127.0.0.1', resolve))
    const zipUrl = `http://127.0.0.1:${fileServer.address().port}/expert.zip`

    const ok = await installMarketExpert(
      {
        expertId: 'ex_test',
        agentName: 'cloud-install-test',
        title: '云端安装测试',
        description: '来自云端包的专家',
        profession: '云端安装测试',
        version: '9.9.9',
        downloadUrl: zipUrl,
        expiresAt: Date.now() + 60_000,
      },
      SKILL_ROOT,
    )
    fileServer.close()
    check('安装成功', ok.result.ok === true, JSON.stringify(ok.result))
    const skillFile = join(SKILL_ROOT, 'cloud-install-test', 'SKILL.md')
    const content = await readFile(skillFile, 'utf8').catch(() => '')
    check('生成了 SKILL.md', content.length > 0)
    check('frontmatter 名字规范', /name: cloud-install-test/u.test(content), content.slice(0, 120))
    check('保留了正文', content.includes('你是测试专家'), content.slice(0, 200))
    check('正文里没有重复 frontmatter', (content.match(/^---$/gm) ?? []).length === 2, content.slice(0, 200))

    const exists = async p => stat(p).then(() => true, () => false)
    check('引用的文件被一并复制', await exists(join(SKILL_ROOT, 'cloud-install-test', 'skills', 'helper', 'SKILL.md')))
    check('目录引用整体展开', await exists(join(SKILL_ROOT, 'cloud-install-test', 'skills', 'helper', 'notes.md')))
    check('引用的图片被复制', await exists(join(SKILL_ROOT, 'cloud-install-test', 'assets', 'cover.png')))
    check('未被引用的文件不复制', !(await exists(join(SKILL_ROOT, 'cloud-install-test', 'assets', 'orphan.txt'))))
    check('复制结果写进 warnings', (ok.result.warnings ?? []).some(w => /引用文件/u.test(w)), JSON.stringify(ok.result.warnings))

    const expired = await installMarketExpert(
      {
        expertId: 'ex_old',
        agentName: 'cloud-old',
        title: '过期',
        description: '过期',
        profession: '过期',
        downloadUrl: zipUrl,
        expiresAt: Date.now() - 1000,
      },
      SKILL_ROOT,
    )
    check('过期地址明确拒绝', expired.result.ok === false && expired.result.code === 'download-expired', JSON.stringify(expired.result))
  }

  console.log('\n10b. 专家快照：缺失标记与按需下载')
  {
    // 不传快照 → 回退内置目录并打标记
    const bare = new Aggregator({ catalog, market: api })
    const missing = await bare.list({ tab: 'expert', pageSize: 5 })
    check('无快照时标记 expertSnapshotMissing', missing.expertSnapshotMissing === true, JSON.stringify(missing).slice(0, 120))
    check('回退到内置目录', missing.total > 0, missing.total)

    // 用本地 gzip 源替换发布地址
    const payload = {
      builtAt: new Date().toISOString(),
      total: 2,
      items: [
        { expert_id: 'dl-1', agent_name: 'dl-one', profession_zh: '下载专家一', description_zh: '来自快照', use_count: 5 },
        { expert_id: 'dl-2', agent_name: 'dl-two', profession_zh: '下载专家二', description_zh: '来自快照', use_count: 3 },
      ],
    }
    const gz = gzipSync(Buffer.from(JSON.stringify(payload), 'utf8'))
    const source = createServer((request, response) => {
      response.setHeader('content-type', 'application/gzip')
      response.end(gz)
    })
    await new Promise(resolve => source.listen(0, '127.0.0.1', resolve))
    const url = `http://127.0.0.1:${source.address().port}/experts.json.gz`

    const target = join(HOME, 'snapshot-cache')
    const ok = await downloadExpertSnapshot(target, url)
    source.close()
    check('下载并解压成功', ok.ok === true && ok.total === 2, JSON.stringify(ok))
    check('进度状态为 done', expertSnapshotProgress().state === 'done', JSON.stringify(expertSnapshotProgress()))
    const written = JSON.parse(await readFile(join(target, 'experts-market.json'), 'utf8'))
    check('落盘内容完整', written.items.length === 2, written.items?.length)

    const badSource = createServer((request, response) => {
      response.setHeader('content-type', 'application/gzip')
      response.end(Buffer.from('not gzip'))
    })
    await new Promise(resolve => badSource.listen(0, '127.0.0.1', resolve))
    const bad = await downloadExpertSnapshot(target, `http://127.0.0.1:${badSource.address().port}/x.gz`)
    badSource.close()
    check('坏 gzip 明确报错', bad.ok === false && /gzip/u.test(bad.message ?? ''), JSON.stringify(bad))
    check('失败后进度标记 error', expertSnapshotProgress().state === 'error', JSON.stringify(expertSnapshotProgress()))

  }

  console.log('\n11. 跨站写请求被拒绝')
  {
    const cross = await post('/enable', { name: 'beta', enabled: false }, { origin: 'https://evil.test' })
    check('跨域 → 403', cross.status === 403, cross.status)
  }

  console.log('\n12. 安装路由透传 allowRestart')
  {
    // Regression: the route used to drop the body flag, so "重启 WorkBuddy 并安装"
    // re-sent the request the server had just refused and answered `need-restart`
    // forever — the button looked dead.
    const routes = await readFile(join(process.cwd(), 'scratch', 'server-out', 'unified-routes.js'), 'utf8')
    check(
      '安装分支读取 body.allowRestart',
      /allowRestart\s*:\s*body\?\.allowRestart\s*===\s*true/u.test(routes),
      '未在 unified-routes 安装分支找到 allowRestart 透传',
    )
    check(
      'installById 把 allowRestart 透传给现取签名',
      /allowRestart\s*:\s*options\.allowRestart\s*===\s*true/u.test(routes),
      'installById 未把 allowRestart 传给 fetchLiveExpertUrl',
    )
  }
} finally {
  dispose()
  server.close()
  market.close()
  await rm(HOME, { recursive: true, force: true })
}

console.log(failures === 0 ? '\n市场 API 检查全部通过。\n' : `\n${failures} 项检查失败。\n`)
process.exit(failures === 0 ? 0 : 1)
