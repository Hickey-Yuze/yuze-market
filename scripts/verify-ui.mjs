/**
 * Render checks for 市场's client half.
 *
 * Everything is server-rendered through `react-dom/server`, which is enough to
 * catch the failures that actually reach the user: a bad prop shape, a missing
 * key, an element type the Host refuses to render, or a state the copy does not
 * cover. The connector row is checked through the *real* hub composition
 * (`h('div', …, descriptor.renderDetail())`) because returning a DOM node from
 * it used to blank the Host's 连接器 panel.
 *
 * Run: npm run verify:ui
 */
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { Card, Chip } from '../scratch/out/client/ui.js'
import { ManualSheet } from '../scratch/out/client/ManualSheet.js'
import { DetailSheet } from '../scratch/out/client/DetailSheet.js'
import { MarketPanel } from '../scratch/out/client/MarketPanel.js'
import { InstalledBoard } from '../scratch/out/client/InstalledBoard.js'
import { createDirectoryPickerWith } from '../scratch/out/client/picker.js'
import {
  YuzeMcpConnectorDetail,
  yuzeMcpConnectorDescriptor,
} from '../scratch/out/client/connector-hub.js'

let failures = 0
function check(label, condition, detail) {
  if (condition) {
    console.log(`  ok   ${label}`)
    return
  }
  failures += 1
  console.log(`  FAIL ${label}${detail === undefined ? '' : ` → ${detail}`}`)
}

const render = element => renderToStaticMarkup(element)
const isElement = value => typeof value === 'object' && value !== null && typeof value.$$typeof === 'symbol'

const skill = {
  id: 'local:skill:alpha',
  tab: 'skill',
  origin: 'local',
  name: 'alpha',
  title: '技能甲',
  description: '一段技能描述',
  category: '效率',
  tags: ['标签一'],
  version: '1.0.0',
  artUrl: '/api/yuze-market/art?id=local%3Askill%3Aalpha',
  examples: ['示例问题一', '示例问题二'],
  installable: true,
}

const expert = {
  id: 'local:expert:beta',
  tab: 'expert',
  origin: 'local',
  name: 'beta',
  title: '专家乙',
  description: '专家描述',
  category: '写作',
  tags: [],
  quickPrompts: ['帮我做一页提纲'],
  installable: true,
}

const connector = {
  id: 'local:connector:foo',
  tab: 'connector',
  origin: 'local',
  name: 'foo',
  title: '连接器甲',
  description: 'MCP 描述',
  tags: [],
  transport: 'streamable-http',
  installable: true,
}

console.log('\n1. 卡片：三种安装态')
{
  const fresh = render(
    createElement(Card, {
      item: skill,
      busy: false,
      onOpen: () => {},
      onInstall: () => {},
    }),
  )
  check('标题与描述渲染', fresh.includes('技能甲') && fresh.includes('一段技能描述'), fresh.slice(0, 200))
  check('未安装显示「安装」', fresh.includes('>安装<'))
  check('带图标请求（artUrl）', fresh.includes('/api/yuze-market/art'), fresh.slice(0, 200))
  check('版本号在脚注', fresh.includes('v1.0.0'))

  const installed = render(
    createElement(Card, {
      item: skill,
      installedAs: 'alpha',
      installedEnabled: true,
      busy: false,
      onOpen: () => {},
      onInstall: () => {},
    }),
  )
  check('已安装显示徽标', installed.includes('已安装'), installed.slice(0, 240))
  check('已安装不再显示安装按钮', !installed.includes('>安装<'))

  const disabled = render(
    createElement(Card, {
      item: skill,
      installedAs: 'alpha',
      installedEnabled: false,
      busy: false,
      onOpen: () => {},
      onInstall: () => {},
    }),
  )
  check('停用态显示「已停用」', disabled.includes('已停用'))

  const blocked = render(
    createElement(Card, {
      item: { ...connector, installable: false, installNote: '只提供 hooks' },
      busy: false,
      onOpen: () => {},
      onInstall: () => {},
    }),
  )
  check('不可安装显示提示', blocked.includes('不可安装'), blocked.slice(0, 240))
}

console.log('\n2. 分类 chip')
{
  const markup = render(createElement(Chip, { active: true, count: 12, onClick: () => {}, children: '效率' }))
  check('选中态与计数', markup.includes('data-active="true"') && markup.includes('12'), markup)
}

console.log('\n3. 详情：未安装 / 已安装 / 引导语')
{
  const fresh = render(
    createElement(DetailSheet, { item: skill, busy: false, onClose: () => {}, onInstall: () => {} }),
  )
  check('标题', fresh.includes('技能甲'))
  check('类型与分类', fresh.includes('技能') && fresh.includes('效率'), fresh.slice(0, 220))
  check('主按钮「安装」', fresh.includes('>安装<'))
  check('需要有「试试这样用」', fresh.includes('试试这样用'))
  check('示例可点击复制', fresh.includes('示例问题一') && fresh.includes('复制'))
  check('ID 展示', fresh.includes('local:skill:alpha'))

  const owned = render(
    createElement(DetailSheet, {
      item: skill,
      installed: {
        name: 'alpha',
        kind: 'skill',
        title: '技能甲',
        description: '',
        enabled: true,
        path: '/x',
      },
      busy: false,
      onClose: () => {},
      onInstall: () => {},
      onToggleEnabled: () => {},
      onRemove: () => {},
    }),
  )
  check('已安装显示停用/删除', owned.includes('停用') && owned.includes('删除'), owned.slice(0, 300))
  check('不再显示安装按钮', !owned.includes('>安装<'))

  const withPrompts = render(
    createElement(DetailSheet, { item: expert, busy: false, onClose: () => {}, onInstall: () => {} }),
  )
  check('专家的引导语出现', withPrompts.includes('帮我做一页提纲'), withPrompts.slice(0, 260))
}

console.log('\n4. 手动安装表单按类型切换')
{
  const skillForm = render(createElement(ManualSheet, { tab: 'skill', onClose: () => {}, onDone: () => {} }))
  check('技能表单要路径', skillForm.includes('目录或压缩包路径'), skillForm.slice(0, 220))
  check('技能表单有名称输入', skillForm.includes('安装名称'))

  const connectorForm = render(createElement(ManualSheet, { tab: 'connector', onClose: () => {}, onDone: () => {} }))
  check('连接器表单是 JSON 文本域', connectorForm.includes('<textarea'), connectorForm.slice(0, 220))
  check('给出 mcpServers 示例', connectorForm.includes('mcpServers'))

  const pluginForm = render(createElement(ManualSheet, { tab: 'plugin', onClose: () => {}, onDone: () => {} }))
  check('插件表单要包名或路径', pluginForm.includes('包名 / 路径'), pluginForm.slice(0, 220))
  check('没有 picker 时不显示选择按钮', !pluginForm.includes('选择…'))

  const withPicker = render(
    createElement(ManualSheet, {
      tab: 'skill',
      onClose: () => {},
      onDone: () => {},
      onPickDirectory: async () => null,
    }),
  )
  check('有 picker 时显示「选择…」', withPicker.includes('选择…'), withPicker.slice(0, 260))
}

console.log('\n5. 主面板首屏（SSR 初始态）')
{
  let markup = ''
  let error = null
  try {
    markup = render(createElement(MarketPanel, {}))
  } catch (cause) {
    error = cause
  }
  check('渲染不抛错', error === null, error?.message)
  check('品牌名是 Yuze·市场', markup.includes('Yuze') && markup.includes('市场'), markup.slice(0, 200))
  check('品牌 logo 内联', markup.includes('data:image/png;base64,'))
  check('四个 tab 都在', ['技能', '专家', '连接器', '插件'].every(label => markup.includes(label)))
  check('有搜索框', markup.includes('qym-searchInput'))
  check('有手动安装入口', markup.includes('手动安装'))
  check('旧品牌字样已清除', !/quwork|workbuddy/iu.test(markup), markup.match(/quwork|workbuddy/iu)?.[0])
}

console.log('\n6. 连接器 Hub 契约（Host 会把 renderDetail 当 React 子节点）')
{
  const descriptor = yuzeMcpConnectorDescriptor()
  check('行名是 Yuze-MCP 连接器', descriptor.name === 'Yuze-MCP 连接器', descriptor.name)
  check('getState 合法', ['on', 'off', 'pending', 'error'].includes(descriptor.getState().state))

  const detail = descriptor.renderDetail()
  check('renderDetail 返回 React 元素', isElement(detail), typeof detail)
  check('renderDetail 返回总览组件', typeof detail?.type === 'function', detail?.type?.name)

  let markup = ''
  let error = null
  try {
    // Exactly what dsh-qw-dingtalk does with a descriptor's detail.
    markup = render(createElement('div', { className: 'dt-hub-detail' }, createElement('span', null, '标题'), detail))
  } catch (cause) {
    error = cause
  }
  check('Hub 组合渲染通过', error === null, error?.message)

  const empty = render(createElement(YuzeMcpConnectorDetail, { initialRows: [] }))
  check('空态提示去市场安装', empty.includes('市场 → 连接器'), empty.slice(0, 240))

  const filled = render(
    createElement(YuzeMcpConnectorDetail, {
      initialRows: [
        { id: 'mcp-wbm-foo', serverName: 'foo', transport: 'streamable-http', enabled: true },
        { id: 'mcp-wbm-bar', serverName: 'bar', transport: 'stdio', enabled: false },
      ],
    }),
  )
  check('渲染出传入的连接器', filled.includes('foo'), filled.slice(0, 260))
  check('行内不再出现授权按钮（授权在详情里）', !filled.includes('授权中'))
}

console.log('\n7. 已安装视图：全局分组卡片（与 tab 无关）')
{
  const markup = render(
    createElement(InstalledBoard, {
      skills: [
        {
          name: 'alpha',
          kind: 'skill',
          title: '技能甲',
          description: '',
          enabled: true,
          path: '/x/alpha',
          version: '1.0.0',
          artUrl: '/api/yuze-market/art?id=local%3Askill%3Aalpha',
        },
        { name: 'beta', kind: 'expert', title: '专家乙', description: '', enabled: false, path: '/x/beta' },
      ],
      connectors: [
        { id: 'mcp-wbm-foo', serverName: 'foo', transport: 'streamable-http', enabled: true },
      ],
      plugins: [{ packageName: 'dsh-demo', version: '1.0.0', enabled: true, builtin: false }],
      busyId: undefined,
      onToggleSkill: () => {},
      onRemoveSkill: () => {},
      onToggleConnector: () => {},
      onRemoveConnector: () => {},
      onTogglePlugin: () => {},
      onRemovePlugin: () => {},
    }),
  )
  check('四个分组都在', ['技能', '专家', '连接器', '插件'].every(name => markup.includes(name)), markup.slice(0, 300))
  check('技能与专家分开成组', markup.includes('data-qym-group="技能"') && markup.includes('data-qym-group="专家"'))
  check('用卡片而不是列表', markup.includes('qym-card--owned') && !markup.includes('qym-row'))
  check('卡片有图标位', markup.includes('qym-avatar'))
  check('停用态可见', markup.includes('已停用'))
  check('每组有计数', markup.includes('qym-count'))

  const empty = render(
    createElement(InstalledBoard, {
      skills: [],
      connectors: [],
      plugins: [],
      onToggleSkill: () => {},
      onRemoveSkill: () => {},
      onToggleConnector: () => {},
      onRemoveConnector: () => {},
      onTogglePlugin: () => {},
      onRemovePlugin: () => {},
    }),
  )
  check('空态提示', empty.includes('还没有安装任何内容'), empty)
}

console.log('\n8. 原生目录选择器：三级回退')
{
  const jsonResponse = body => ({
    ok: true,
    json: async () => body,
  })
  const failResponse = { ok: false, json: async () => ({}) }

  // 1) Desktop 壳同源端点可用 → 直接取它，不碰其它通道
  const viaShell = createDirectoryPickerWith(undefined, {
    fetch: async () => jsonResponse({ path: '/Users/me/skills/demo' }),
    target: {},
  })
  check('走桌面壳端点', JSON.stringify(await viaShell()) === JSON.stringify({ ok: true, path: '/Users/me/skills/demo' }), await viaShell())

  // 2) 桌面壳 404 → 回退到 preload 桥（macOS）
  const viaPreload = createDirectoryPickerWith(undefined, {
    fetch: async () => failResponse,
    target: { __DSH_DIRECTORY_PICKER__: { pick: async () => '/Users/me/other' } },
  })
  check('回退到 preload 桥', (await viaPreload()).path === '/Users/me/other', JSON.stringify(await viaPreload()))

  // 3) 用户取消时不再弹第二个对话框
  let preloadCalls = 0
  const cancelled = createDirectoryPickerWith(undefined, {
    fetch: async () => jsonResponse({ path: null }),
    target: {
      __DSH_DIRECTORY_PICKER__: {
        pick: async () => {
          preloadCalls += 1
          return '/should/not/be/used'
        },
      },
    },
  })
  const cancelledResult = await cancelled()
  check('取消即结束', cancelledResult.ok === true && cancelledResult.path === null, JSON.stringify(cancelledResult))
  check('取消后没有再弹一次', preloadCalls === 0, preloadCalls)

  // 4) 桌面壳与 preload 都没有 → 走 cordis remote，解开 {ok,value}
  const viaRemote = createDirectoryPickerWith(
    { remote: { directoryPicker: { pick: async () => ({ ok: true, value: '/via/remote' }) } } },
    { fetch: async () => failResponse, target: {} },
  )
  check('回退到 remote 命名空间', (await viaRemote()).path === '/via/remote', JSON.stringify(await viaRemote()))

  // 5) 三条都不通 → 明确报告不可用，让面板提示手填
  const none = createDirectoryPickerWith(undefined, { fetch: async () => failResponse, target: {} })
  check('全部不可用时返回 ok:false', (await none()).ok === false, JSON.stringify(await none()))

  // 6) fetch 抛错不影响回退
  const thrown = createDirectoryPickerWith(undefined, {
    fetch: async () => {
      throw new Error('network')
    },
    target: { __DSH_DIRECTORY_PICKER__: { pick: async () => '/after/throw' } },
  })
  check('fetch 抛错后仍回退', (await thrown()).path === '/after/throw')
}

console.log(failures === 0 ? '\n市场界面检查全部通过。\n' : `\n${failures} 项检查失败。\n`)
process.exit(failures === 0 ? 0 : 1)
