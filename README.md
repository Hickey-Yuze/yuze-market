# Yuze-市场

DeepSeek Harness（DSH）的一体化市场插件：**技能 / 专家 / 连接器 / 插件** 四个板块，一个侧栏入口，统一浏览、安装与管理。

> 包名 `yuze-market` · 插件 id `yuze-market` · 连接器在宿主中显示为「Yuze-MCP 连接器」

![四栏市场](docs/preview.png)

## 它解决什么

QuWork 的技能与插件、WorkBuddy 的专家与连接器，原本分散在四个互不相通的市场里，命名、图标、安装方式各不相同。这个插件把它们归一成一套界面和一套操作：

| 板块 | 数据来源 | 规模 |
|---|---|---|
| 技能 | WorkBuddy 本地插件市场的 `skills/` + QuWork 技能市场 | 1 400+ |
| 专家 | WorkBuddy 在线专家市场快照 | 26 900+ |
| 连接器 | WorkBuddy 官方连接器市场（MCP） | 500 |
| 插件 | QuWork DSH 插件市场 | 36 |

所有条目统一为同一种卡片（图标、标题、类型、描述、分类、安装量）与同一个详情面板；安装、启用、停用、删除都走同一组接口。

## 功能

- **四板块网格**：胶囊 tab + 分类 chip + 排序（综合 / 最多安装 / 名称），最大四列自适应。
- **详情面板**：大图标、描述、版本、标识、标签、引导语（点击复制），可安装 / 启停 / 删除。
- **已安装视图**：不跟随 tab，一次列出全部内容并按类型分组，卡片式管理。
- **手动安装**：技能/专家支持目录或 zip，连接器支持粘贴 `mcp.json`，插件支持包名 / tgz / 目录。
- **连接器 OAuth**：授权码 + PKCE 全流程在插件内完成（本机回调 `127.0.0.1:17321`），token 写入 profile 的 MCP headers 并在过期后自动续期。
- **连接器 Hub**：向宿主的「连接器」面板注册一行市场标识 + 每个已安装 MCP 单独一行（图标、中文名、连接状态、启停开关）。

## 安装

本地开发（推荐，改完 `pnpm build` 刷新即生效）：

```bash
git clone https://github.com/Hickey-Yuze/yuze-market.git
cd yuze-market
pnpm install
pnpm build
```

然后在 DSH 的活动 profile（`~/.dsh/profiles/desktop/package.json`）里加一行：

```json
"yuze-market": "link:/absolute/path/to/yuze-market"
```

并把 `yuze-market` 加进同一文件的 `dsh.profile.bundles`，最后 `pnpm install` 并重启 Harness。

或用发布包：

```bash
pnpm add "https://github.com/Hickey-Yuze/yuze-market/releases/latest/download/yuze-market-0.3.0.tgz"
```

## 数据快照

市场的条目不是实时拉取的：三份快照落在 `~/.dsh/workbuddy-market/cache/`，插件只读快照，因此断网或上游改版时是「数据旧一点」而不是「列表空」。

| 快照 | 生成命令 | 说明 |
|---|---|---|
| `catalog.json` | 外部生成 | 连接器 + 部分技能，从 WorkBuddy 官方市场包解析（生成脚本不在本仓库） |
| `skills-market.json` | `pnpm sync:skills` | 扫描 WorkBuddy 本地插件市场，秒级，不需要登录 |
| `experts-market.json` | `pnpm sync:experts` | 通过 WorkBuddy 自带 CDP 端口分页拉取在线专家市场（15–20 分钟） |
| `skills-zh.json` | `pnpm merge:zh` | 技能标题/描述的中文覆盖，缺失时回退英文 |

专家与技能之外的板块在快照缺失时会回退到内置数据源，不会白屏。

## 开发

```bash
pnpm typecheck     # 服务端 + 客户端类型检查
pnpm check         # 构建 + 类型 + 包契约 + 客户端 loader + OAuth + API + UI 全链路
```

`pnpm check` 里有 166 项断言，覆盖：

- OAuth 授权码 + PKCE 全流程（含取消、过期、无 refresh token）
- 市场 API（合并、排序、分页、图标、启停、删除、手动安装）
- 客户端渲染（卡片三态、详情、已安装视图、连接器 Hub 契约、目录选择器三级回退）
- 包契约（exports / `cordis.patch.yml` / client bundle 的 ModuleLoader 形状）

## 设计约束

写插件前值得知道的几条，都是踩过的坑：

1. **不要依赖宿主的 `--dsw-alias-*` 变量**：它们在插件 slot 内没有定义，会导致弹层透明、按钮文字与背景同色。样式自带 token。
2. **布局要在受限容器里验**（如 1180×640）：面板高度固定，flex 子项默认会被压缩；预览用自然高度页面看不出塌陷。
3. **Hub 的 `renderDetail` 必须返回 React 元素**：返回原生 DOM 会抛 `Objects are not valid as a React child`，整块「管理连接器」白屏。
4. **目录选择器没有文件版本**：宿主只提供目录选择（`/_dsh/desktop/pick-directory`），zip/tgz 只能手填路径。
5. **连接器只支持 stdio 与 streamable-http**：仅提供旧 SSE 传输的连接器会被拦截并说明原因。

## 已知限制

- 云端专家的 zip 走签名地址（约 24 小时有效），过期后需重跑 `pnpm sync:experts` 才能继续安装。
- 上游有十余条技能描述本身是 YAML 占位符（`|` 或 `>`），插件按原样展示，不编造内容。
- 技能标题来自上游，部分是英文专名（如 `pdf`、`3-statements`），中文说明在其后。
- 连接器 id 前缀仍为历史值 `mcp-wbm-`，仅影响配置文件内的标识，不影响显示。

## License

MIT
