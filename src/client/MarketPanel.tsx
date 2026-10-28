/**
 * 市场 — one page, four tabs, no product walls.
 *
 * Layout follows the approved redesign: a sticky header with the brand, search
 * and the two global actions; a pill tab row with a sort selector; a scrollable
 * chip row; then a maximum four-column card grid. Everything below the grid is
 * additive (installed board, detail sheet, manual install).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  marketApi,
  type InstalledConnectorEntry,
  type InstalledPayload,
  type InstalledPluginEntry,
  type InstalledSkillEntry,
  type SortMode,
  type Tab,
  type UnifiedItem,
  type UnifiedList,
} from './api.js'
import { ConnectorRow } from './ConnectorRow.js'
import { DetailSheet } from './DetailSheet.js'
import { InstalledBoard } from './InstalledBoard.js'
import { ManualSheet } from './ManualSheet.js'
import { BRAND_LOGO as BRAND } from './brand.js'
import { Badge, Card, Chip } from './ui.js'

export interface MarketPanelProps {
  readonly t?: (key: string, params?: Record<string, string | number>) => string
  readonly defaultTab?: Tab
  /** Host folder chooser, injected by the entry point. */
  readonly onPickDirectory?: () => Promise<{ readonly ok: boolean; readonly path?: string | null }>
}

const TABS: readonly { readonly id: Tab; readonly label: string }[] = [
  { id: 'skill', label: '技能' },
  { id: 'expert', label: '专家' },
  { id: 'connector', label: '连接器' },
  { id: 'plugin', label: '插件' },
]

const SORTS: readonly { readonly id: SortMode; readonly label: string }[] = [
  { id: 'reco', label: '综合推荐' },
  { id: 'usage', label: '最多安装' },
  { id: 'name', label: '名称 A–Z' },
]

const PAGE_SIZE = 60
const EMPTY_INSTALLED: InstalledPayload = { skills: [], connectors: [], plugins: [] }

/** Mirror the Host's `serverName` rule so a catalogue row matches its MCP entry. */
function serverNameOf(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9_-]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 32)
  return cleaned.length > 0 ? cleaned : 'connector'
}

type Status = 'loading' | 'ready' | 'error'

/** The brand mark: Yuze's whale, inlined so no asset request is needed. */
const BRAND_LOGO = BRAND

export function MarketPanel(props: MarketPanelProps): JSX.Element {
  const { defaultTab = 'skill', onPickDirectory } = props
  const [tab, setTab] = useState<Tab>(defaultTab)
  const [sort, setSort] = useState<SortMode>('reco')
  const [keyword, setKeyword] = useState('')
  const [debounced, setDebounced] = useState('')
  const [category, setCategory] = useState<string | undefined>(undefined)
  const [list, setList] = useState<UnifiedList | undefined>(undefined)
  const [page, setPage] = useState(1)
  const [status, setStatus] = useState<Status>('loading')
  const [error, setError] = useState<string | undefined>(undefined)
  const [installed, setInstalled] = useState<InstalledPayload>(EMPTY_INSTALLED)
  const [busyId, setBusyId] = useState<string | undefined>(undefined)
  const [notice, setNotice] = useState<string | undefined>(undefined)
  const [openId, setOpenId] = useState<string | undefined>(undefined)
  const [manualOpen, setManualOpen] = useState(false)
  const [showInstalled, setShowInstalled] = useState(false)
  const [fetchingSnapshot, setFetchingSnapshot] = useState(false)
  const [snapshotNotice, setSnapshotNotice] = useState<string | undefined>(undefined)
  const alive = useRef(true)
  const searchRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  // ⌘K / Ctrl+K focuses the search box, matching the redesign.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        searchRef.current?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(keyword.trim()), 280)
    return () => clearTimeout(timer)
  }, [keyword])

  const loadInstalled = useCallback(async (): Promise<void> => {
    try {
      const payload = await marketApi.installed()
      if (alive.current) setInstalled(payload)
    } catch {
      // The grid still works without the installed index; it only loses badges.
    }
  }, [])

  const load = useCallback(
    async (nextPage: number, append: boolean): Promise<void> => {
      if (!append) setStatus('loading')
      setError(undefined)
      try {
        const response = await marketApi.items({
          tab,
          q: debounced,
          category,
          page: nextPage,
          pageSize: PAGE_SIZE,
          sort,
        })
        if (!alive.current) return
        setList(previous =>
          append && previous !== undefined ? { ...response, items: [...previous.items, ...response.items] } : response,
        )
        setPage(response.page)
        setStatus('ready')
      } catch (cause) {
        if (!alive.current) return
        setError(cause instanceof Error ? cause.message : String(cause))
        setStatus('error')
      }
    },
    [tab, debounced, category, sort],
  )

  useEffect(() => {
    void load(1, false)
  }, [load])

  useEffect(() => {
    void loadInstalled()
  }, [loadInstalled])

  const items = list?.items ?? []

  const skillIndex = useMemo(() => new Map(installed.skills.map(entry => [entry.name, entry])), [installed.skills])
  const connectorIndex = useMemo(
    () => new Map(installed.connectors.map(entry => [entry.serverName, entry])),
    [installed.connectors],
  )
  const pluginIndex = useMemo(
    () => new Map(installed.plugins.map(entry => [entry.packageName, entry])),
    [installed.plugins],
  )

  const installedFor = useCallback(
    (item: UnifiedItem): InstalledSkillEntry | undefined => {
      if (item.tab !== 'skill' && item.tab !== 'expert') return undefined
      return skillIndex.get(item.name) ?? installed.skills.find(entry => entry.marketId === item.name)
    },
    [installed.skills, skillIndex],
  )

  const installedConnector = useCallback(
    (item: UnifiedItem): InstalledConnectorEntry | undefined => connectorIndex.get(serverNameOf(item.name)),
    [connectorIndex],
  )

  const installedPlugin = useCallback(
    (item: UnifiedItem): InstalledPluginEntry | undefined => pluginIndex.get(item.name),
    [pluginIndex],
  )

  const openItem = items.find(item => item.id === openId)
  const installedTotal = installed.skills.length + installed.connectors.length + installed.plugins.length

  const afterMutation = useCallback(
    async (message: string): Promise<void> => {
      setNotice(message)
      await loadInstalled()
      await load(1, false)
    },
    [load, loadInstalled],
  )

  const install = useCallback(
    async (item: UnifiedItem): Promise<void> => {
      setBusyId(item.id)
      setNotice(undefined)
      try {
        const result = await marketApi.install(item.id)
        if (!result.ok) {
          setNotice(result.message ?? '安装失败')
          return
        }
        await afterMutation(
          item.tab === 'connector' || item.tab === 'plugin' ? '已安装，重启 Harness 后生效' : '安装完成',
        )
      } catch (cause) {
        setNotice(cause instanceof Error ? cause.message : String(cause))
      } finally {
        setBusyId(undefined)
      }
    },
    [afterMutation],
  )

  const toggleSkill = useCallback(
    async (entry: InstalledSkillEntry): Promise<void> => {
      setBusyId(`skill:${entry.name}`)
      try {
        const result = await marketApi.setSkillEnabled(entry.name, !entry.enabled)
        if (!result.ok) {
          setNotice(result.message ?? '操作失败')
          return
        }
        await afterMutation(entry.enabled ? '已停用' : '已启用')
      } finally {
        setBusyId(undefined)
      }
    },
    [afterMutation],
  )

  const removeSkill = useCallback(
    async (entry: InstalledSkillEntry): Promise<void> => {
      setBusyId(`skill:${entry.name}`)
      try {
        const result = await marketApi.removeSkill(entry.name)
        if (!result.ok) {
          setNotice(result.message ?? '删除失败')
          return
        }
        setOpenId(undefined)
        await afterMutation('已删除（副本保留在 skills/.trash）')
      } finally {
        setBusyId(undefined)
      }
    },
    [afterMutation],
  )

  const toggleConnector = useCallback(
    async (entry: InstalledConnectorEntry): Promise<void> => {
      setBusyId(`connector:${entry.serverName}`)
      try {
        const result = await marketApi.setConnectorEnabled(entry.serverName, !entry.enabled)
        if (!result.ok) {
          setNotice(result.message ?? '操作失败')
          return
        }
        await afterMutation(entry.enabled ? '已停用，重启后生效' : '已启用，重启后生效')
      } finally {
        setBusyId(undefined)
      }
    },
    [afterMutation],
  )

  const removeConnector = useCallback(
    async (entry: InstalledConnectorEntry): Promise<void> => {
      setBusyId(`connector:${entry.serverName}`)
      try {
        const result = await marketApi.removeConnector(entry.serverName)
        if (!result.ok) {
          setNotice(result.message ?? '删除失败')
          return
        }
        await afterMutation('连接器已移除，重启后生效')
      } finally {
        setBusyId(undefined)
      }
    },
    [afterMutation],
  )

  const togglePlugin = useCallback(
    async (entry: InstalledPluginEntry): Promise<void> => {
      setBusyId(`plugin:${entry.packageName}`)
      try {
        const result = await marketApi.setPluginEnabled(entry.packageName, !entry.enabled)
        if (!result.ok) {
          setNotice(result.message ?? '操作失败')
          return
        }
        await afterMutation(entry.enabled ? '已停用，重启后生效' : '已启用，重启后生效')
      } finally {
        setBusyId(undefined)
      }
    },
    [afterMutation],
  )

  const removePlugin = useCallback(
    async (entry: InstalledPluginEntry): Promise<void> => {
      setBusyId(`plugin:${entry.packageName}`)
      try {
        const result = await marketApi.removePlugin(entry.packageName)
        if (!result.ok) {
          setNotice(result.message ?? '卸载失败')
          return
        }
        await afterMutation('插件已卸载，重启后生效')
      } finally {
        setBusyId(undefined)
      }
    },
    [afterMutation],
  )

  const fetchSnapshot = useCallback(async (): Promise<void> => {
    setFetchingSnapshot(true)
    setSnapshotNotice(undefined)
    try {
      const result = await marketApi.fetchExpertSnapshot()
      if (!result.ok) {
        setSnapshotNotice(result.message ?? '获取失败')
        return
      }
      setSnapshotNotice(`已获取 ${(result.total ?? 0).toLocaleString('zh-CN')} 位专家`)
      await load(1, false)
    } catch (cause) {
      setSnapshotNotice(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setFetchingSnapshot(false)
    }
  }, [load])

  const detailEntry = openItem === undefined ? undefined : installedFor(openItem)

  return (
    <section className="qym" data-qym-panel="market">
      <header className="qym-header">
        <div className="qym-headerInner">
          <div className="qym-brand">
            <div className="qym-brandLogo">
              <img src={BRAND_LOGO} alt="Yuze" />
            </div>
            <div className="qym-brandName">
              Yuze<span>· 市场</span>
            </div>
          </div>

          <div className="qym-search">
            <svg className="qym-searchIcon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
              <circle cx="11" cy="11" r="7" />
              <path d="m21 21-4.3-4.3" />
            </svg>
            <input
              ref={searchRef}
              className="qym-searchInput"
              value={keyword}
              placeholder="搜索技能、专家、连接器或插件，一键发现与安装…"
              onChange={event => setKeyword(event.target.value)}
            />
            {keyword.length === 0 ? <span className="qym-searchKbd">⌘K</span> : null}
            {keyword.length > 0 ? (
              <button type="button" className="qym-searchClear" aria-label="清空搜索" onClick={() => setKeyword('')}>
                ✕
              </button>
            ) : null}
          </div>

          <div className="qym-headerActions">
            <button
              type="button"
              className="qym-btnGhost"
              data-active={showInstalled ? 'true' : 'false'}
              onClick={() => setShowInstalled(value => !value)}
            >
              已安装 <span className="qym-badgeCount">{installedTotal}</span>
            </button>
            <button type="button" className="qym-btnGhost" onClick={() => setManualOpen(true)}>
              手动安装
            </button>
          </div>
        </div>
      </header>

      <div className="qym-toolbar">
        <div className="qym-tabs" role="tablist">
          {TABS.map(entry => (
            <button
              key={entry.id}
              type="button"
              role="tab"
              className="qym-tab"
              data-active={tab === entry.id && !showInstalled ? 'true' : 'false'}
              aria-selected={tab === entry.id && !showInstalled}
              onClick={() => {
                setTab(entry.id)
                setCategory(undefined)
                setShowInstalled(false)
                setNotice(undefined)
              }}
            >
              {entry.label}
              {tab === entry.id && list !== undefined ? <span className="qym-tabCount">{list.total}</span> : null}
            </button>
          ))}
        </div>
        <div className="qym-toolbarRight">
          <select
            className="qym-select"
            aria-label="排序方式"
            value={sort}
            onChange={event => setSort(event.target.value as SortMode)}
          >
            {SORTS.map(entry => (
              <option key={entry.id} value={entry.id}>
                {entry.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {!showInstalled && (list?.categories.length ?? 0) > 0 ? (
        <div className="qym-chips">
          <Chip active={category === undefined} count={list?.total} onClick={() => setCategory(undefined)}>
            全部分类
          </Chip>
          {(list?.categories ?? []).map(entry => (
            <Chip
              key={entry.name}
              active={category === entry.name}
              count={entry.count}
              onClick={() => setCategory(category === entry.name ? undefined : entry.name)}
            >
              {entry.name}
            </Chip>
          ))}
        </div>
      ) : null}

      <div className="qym-gridWrap">
        {notice !== undefined ? (
          <p className="qym-note" data-tone={notice.startsWith('已') ? 'ok' : 'error'}>
            {notice}
          </p>
        ) : null}

        {!showInstalled && tab === 'expert' && list?.expertSnapshotMissing === true ? (
          <div className="qym-note" data-snapshot-hint="">
            <span>
              当前只有内置的 {list.total} 位专家。完整目录约 27 000 位、压缩后 20 MB，下载后即可离线浏览（安装云端专家仍需本机同步）。
            </span>
            <button
              type="button"
              className="qym-btn qym-btn--primary"
              disabled={fetchingSnapshot}
              onClick={() => void fetchSnapshot()}
            >
              {fetchingSnapshot ? '获取中…' : '获取完整目录'}
            </button>
          </div>
        ) : null}

        {snapshotNotice !== undefined ? (
          <p className="qym-note" data-tone={snapshotNotice.startsWith('已') ? 'ok' : 'error'}>
            {snapshotNotice}
          </p>
        ) : null}

        {showInstalled ? (
          <InstalledBoard
            skills={installed.skills}
            connectors={installed.connectors}
            plugins={installed.plugins}
            busyId={busyId}
            onToggleSkill={entry => void toggleSkill(entry)}
            onRemoveSkill={entry => void removeSkill(entry)}
            onToggleConnector={entry => void toggleConnector(entry)}
            onRemoveConnector={entry => void removeConnector(entry)}
            onTogglePlugin={entry => void togglePlugin(entry)}
            onRemovePlugin={entry => void removePlugin(entry)}
          />
        ) : status === 'error' ? (
          <p className="qym-error">{error ?? '加载失败'}</p>
        ) : status === 'loading' ? (
          <p className="qym-empty">加载中…</p>
        ) : items.length === 0 ? (
          <div className="qym-empty">
            <div className="qym-emptyIcon">🔍</div>
            {list?.degraded === true ? '远程市场暂时不可用' : '没有匹配的条目'}
          </div>
        ) : (
          <>
            <ul className="qym-grid">
              {items.map(item => {
                const skill = installedFor(item)
                const connector = installedConnector(item)
                const plugin = installedPlugin(item)
                const installedAs = skill?.name ?? connector?.serverName ?? plugin?.packageName
                const enabled = skill?.enabled ?? connector?.enabled ?? plugin?.enabled
                return (
                  <Card
                    key={item.id}
                    item={item}
                    {...(installedAs === undefined ? {} : { installedAs })}
                    {...(enabled === undefined ? {} : { installedEnabled: enabled })}
                    busy={busyId === item.id}
                    onOpen={() => setOpenId(item.id)}
                    onInstall={() => void install(item)}
                  />
                )
              })}
            </ul>
            {list?.hasMore === true ? (
              <div className="qym-more">
                <button type="button" className="qym-btn" onClick={() => void load(page + 1, true)}>
                  加载更多
                </button>
              </div>
            ) : null}
          </>
        )}
      </div>

      {openItem !== undefined ? (
        <DetailSheet
          item={openItem}
          {...(detailEntry === undefined ? {} : { installed: detailEntry })}
          busy={busyId !== undefined}
          {...(notice === undefined ? {} : { notice })}
          onClose={() => setOpenId(undefined)}
          onInstall={() => void install(openItem)}
          {...(detailEntry === undefined
            ? {}
            : {
                onToggleEnabled: () => void toggleSkill(detailEntry),
                onRemove: () => void removeSkill(detailEntry),
              })}
        />
      ) : null}

      {manualOpen ? (
        <ManualSheet
          tab={tab}
          onClose={() => setManualOpen(false)}
          onDone={message => {
            setManualOpen(false)
            void afterMutation(message)
          }}
          {...(onPickDirectory === undefined ? {} : { onPickDirectory })}
        />
      ) : null}
    </section>
  )
}
