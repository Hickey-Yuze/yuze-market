/**
 * Composer input-left entry —— 技能 / 专家：点选后在工具条就地渲染 chip。
 *
 * Registers into the Host's session-scoped `conversation.input.left` tool row,
 * ordered before the shared 连接器 entry (order 40), so it sits 连接器左边.
 * The framework injects `inputActions` (setDraft + submit).
 *
 * Two interactions coexist here:
 *  - 点击列表行主体（头像 + 名称）→ 加入/移出「已选」集合，工具条就地渲染
 *    圆形头像 + 名称的胶囊 chip（未选 ⇄ 已选），浮层随之收起；单选替换——
 *    再点触发器可重选另一项直接覆盖，无需先移除。选中只更新 chip（标记
 *    「当前会话跟随此技能」），**不填草稿、不发送任何消息**——技能/专家
 *    装好后已在会话技能目录（模型可自主加载），无需输入 `/名字`；
 *  - 点击行右侧「调用」→ 显式立即调用：setDraft('/'+name) + submit，走宿主
 *    slash 流水线直接加载技能（用户主动触发时才发送）。
 *
 * The entry lists installed entries only (what the user can actually invoke),
 * with a search box to jump to one. The market panel keeps the install/remove
 * flows; it announces changes through the INSTALLED_CHANGED_EVENT and asks for
 * a call through dispatchInvokeSkill, so the entry and the panel stay in sync
 * without any shared store.
 */

import { useCallback, useEffect, useRef, useState } from 'react'

import type { InstalledSkillEntry } from './api.js'
import { marketApi } from './api.js'
import { Avatar } from './ui.js'

/**
 * Host-injected session input face (the subset this entry needs). The Host
 * contract is `SessionStandardProps.inputActions`; we keep a local structural
 * type so the plugin does not depend on Host type packages.
 */
export interface InputActions {
  /** Replace the whole draft. */
  setDraft(text: string): void
  /** Attach one user-invocable skill as durable injected context.
   *  Resolves with the admission result so callers can surface failures. */
  attachSkill?(skillName: string, signal?: AbortSignal): Promise<unknown> | void
  /** Enter submission (slash pipeline / default sink inside). */
  submit(): void
}

export interface SkillInvokeDockProps {
  /** Framework-injected session input actions; absent outside a Session. */
  readonly inputActions?: InputActions | undefined
}

/** Cross-surface event: the market panel asks the dock to call one skill. */
export const INVOKE_EVENT = 'yuze-market:invoke-skill'
/** Cross-surface event: installed set changed, refresh the dock list. */
export const INSTALLED_CHANGED_EVENT = 'yuze-market:installed-changed'

/** Ask the composer entry to call `/name` (fire-and-forget from the panel). */
export function dispatchInvokeSkill(name: string): void {
  window.dispatchEvent(new CustomEvent(INVOKE_EVENT, { detail: { name } }))
}

/** Announce that the installed set changed so the entry can refresh. */
export function announceInstalledChanged(): void {
  window.dispatchEvent(new CustomEvent(INSTALLED_CHANGED_EVENT))
}

function matches(entry: InstalledSkillEntry, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (q.length === 0) return true
  return (
    entry.title.toLowerCase().includes(q) ||
    entry.name.toLowerCase().includes(q) ||
    entry.description.toLowerCase().includes(q)
  )
}

function avatarItem(entry: InstalledSkillEntry): { title: string; artUrl?: string } {
  return { title: entry.title, ...(entry.artUrl === undefined ? {} : { artUrl: entry.artUrl }) }
}

/** 已选胶囊 chip：圆形头像 + 加粗名称 + 移除按钮。主体可点——点它重开浮层重选，
 * 不必先 ✕ 移除；✕ 才是清除选中。 */
function SelectedChip(props: {
  readonly entry: InstalledSkillEntry
  readonly chipRef?: (node: HTMLSpanElement | null) => void
  readonly onReopen: () => void
  readonly onRemove: () => void
}): JSX.Element {
  const { entry, chipRef, onReopen, onRemove } = props
  return (
    <span className="qym-skillChip" ref={chipRef}>
      <button
        type="button"
        className="qym-skillChipMain"
        title="点击重选技能 / 专家"
        aria-label={`重选：${entry.title}`}
        onClick={onReopen}
      >
        <Avatar size="xs" item={avatarItem(entry)} />
        <span className="qym-skillChipName">{entry.title}</span>
      </button>
      <button type="button" className="qym-skillChipRemove" aria-label={`移除 ${entry.title}`} onClick={onRemove}>
        ×
      </button>
    </span>
  )
}

function DockRow(props: {
  readonly entry: InstalledSkillEntry
  readonly selected: boolean
  /** 点击行主体：切换选中（就地 chip / 取消）。 */
  readonly onSelect: () => void
  /** 点击「调用」：维持原直接调用行为。 */
  readonly onCall: () => void
}): JSX.Element {
  const { entry, selected, onSelect, onCall } = props
  return (
    <li>
      <div className="qym-skillRow" data-selected={selected ? 'true' : 'false'}>
        <button type="button" className="qym-skillRowMain" aria-pressed={selected} onClick={onSelect}>
          <Avatar size="sm" item={avatarItem(entry)} />
          <span className="qym-skillRowText">
            <span className="qym-skillRowTitle">{entry.title}</span>
            <span className="qym-skillRowName">/{entry.name}</span>
          </span>
          {selected ? <span className="qym-skillRowSelected">已选</span> : null}
        </button>
        <button type="button" className="qym-skillRowGo" onClick={onCall}>
          调用
        </button>
      </div>
    </li>
  )
}

interface PopoverPos {
  position: 'fixed'
  left: string
  bottom: string
  width: string
}

export function SkillInvokeDock(props: SkillInvokeDockProps): JSX.Element {
  const { inputActions } = props
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [entries, setEntries] = useState<readonly InstalledSkillEntry[]>([])
  /** 已选技能/专家（单选，最多一项），渲染为工具条上的 chip。 */
  const [selected, setSelected] = useState<readonly InstalledSkillEntry[]>([])
  const [pos, setPos] = useState<PopoverPos | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const chipRef = useRef<HTMLSpanElement | null>(null)

  const load = useCallback(async (): Promise<void> => {
    try {
      const payload = await marketApi.installed()
      setEntries(payload.skills)
    } catch {
      // The entry degrades to empty; the market panel still owns installs.
    }
  }, [])

  /** 显式「调用」：setDraft('/'+name) + submit，立即走宿主 slash 流水线。
   *  仅由「调用」按钮与市场面板调用事件触发（用户主动动作）。 */

  /** 显式「调用」：setDraft('/'+name) + submit，立即走宿主 slash 流水线。
   *  仅由「调用」按钮与市场面板调用事件触发（用户主动动作）。 */
  const invoke = useCallback(
    (name: string): void => {
      inputActions?.setDraft(`/${name}`)
      inputActions?.submit()
      setOpen(false)
    },
    [inputActions],
  )

  /** 注入失败提示（attachSkill 调用失败或宿主不支持时显示）。 */
  const [attachError, setAttachError] = useState<string | null>(null)

  /** 把技能/专家全文注入当前会话上下文（宿主 attachSkill Remote）。
   *  成功：宿主对话区出现「注入」标签消息；失败：在浮层给出可见提示。 */
  const attachSkill = useCallback(
    async (entry: InstalledSkillEntry): Promise<void> => {
      if (typeof inputActions?.attachSkill !== 'function') {
        setAttachError(`当前宿主不支持技能注入（attachSkill 不可用），已仅标记选中。`)
        return
      }
      try {
        const result = await inputActions.attachSkill(entry.name)
        if (
          result !== undefined &&
          result !== null &&
          (result as { ok?: boolean }).ok === false
        ) {
          const err = (result as { error?: { message?: string } }).error
          setAttachError(`注入失败：${err?.message ?? '未知错误'}`)
        }
      } catch (e) {
        setAttachError(`注入失败：${(e as Error | undefined)?.message ?? String(e)}`)
      }
    },
    [inputActions],
  )

  /** 点选/取消一项：单选替换（新选覆盖旧选；点已选项则清空），收起浮层。
   *  选中分支调用宿主 `inputActions.attachSkill`——把技能全文作为
   *  `skill-invocation` 消息 followup 落盘进当前会话上下文（UI 显示「已注入
   *  技能」标签）：不碰输入框草稿、不发送任何可见消息，模型此后每轮都会
   *  看到该技能；要立即显式调用用行右侧「调用」。 */
  const toggleSelected = useCallback(
    (entry: InstalledSkillEntry): void => {
      const isSelected = selected.some(item => item.name === entry.name)
      setAttachError(null)
      setSelected(isSelected ? [] : [entry])
      setOpen(false)
      if (!isSelected) void attachSkill(entry)
    },
    [selected, attachSkill],
  )

  const removeSelected = useCallback((name: string): void => {
    setSelected(prev => prev.filter(item => item.name !== name))
  }, [])

  const close = useCallback((): void => {
    setOpen(false)
  }, [])

  // Anchor the popover just above the trigger (or the selected chip, when the
  // trigger is hidden), clamped to the viewport — same placement the shared
  // 连接器 panel uses (qw-dingtalk fallback path).
  const place = useCallback((el: HTMLElement | null): void => {
    const view = typeof window === 'undefined' ? null : window
    if (!el || typeof el.getBoundingClientRect !== 'function' || !view) {
      setPos(null)
      return
    }
    const rect = el.getBoundingClientRect()
    const vw = view.innerWidth || 1024
    const vh = view.innerHeight || 768
    const width = Math.max(300, Math.min(380, vw - 24))
    let left = rect.left
    if (left + width > vw - 12) left = vw - 12 - width
    if (left < 12) left = 12
    setPos({
      position: 'fixed',
      left: `${Math.round(left)}px`,
      bottom: `${Math.round(vh - rect.top + 8)}px`,
      width: `${Math.round(width)}px`,
    })
  }, [])

  /** 打开/收起浮层，锚点为已选 chip（若在）否则触发器按钮。 */
  const toggleMenu = useCallback((): void => {
    setOpen(prev => {
      if (prev) return false
      place(chipRef.current ?? triggerRef.current)
      return true
    })
  }, [place])

  useEffect(() => {
    void load()
    const onInstalled = (): void => void load()
    const onInvoke = (event: Event): void => {
      const detail = (event as CustomEvent<{ name?: unknown }>).detail
      if (typeof detail?.name === 'string') invoke(detail.name)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close()
    }
    window.addEventListener(INSTALLED_CHANGED_EVENT, onInstalled)
    window.addEventListener(INVOKE_EVENT, onInvoke)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener(INSTALLED_CHANGED_EVENT, onInstalled)
      window.removeEventListener(INVOKE_EVENT, onInvoke)
      window.removeEventListener('keydown', onKey)
    }
  }, [invoke, load, close])

  const skills = entries.filter(entry => entry.kind !== 'expert' && matches(entry, query))
  const experts = entries.filter(entry => entry.kind === 'expert' && matches(entry, query))
  const total = entries.length
  const filtered = skills.length + experts.length
  const selectedNames = new Set(selected.map(item => item.name))

  return (
    <span className="qym-skillBar">
      {selected.length > 0 ? (
        <SelectedChip
          entry={selected[0]!}
          chipRef={node => {
            chipRef.current = node
          }}
          onReopen={toggleMenu}
          onRemove={() => removeSelected(selected[0]!.name)}
        />
      ) : null}
      {selected.length === 0 ? (
        <button
          ref={triggerRef}
          type="button"
          className="qym-skillTrigger"
          title="技能 / 专家"
          aria-label="技能 / 专家"
          aria-expanded={open}
          onClick={toggleMenu}
        >
          <svg
            className="qym-skillTriggerIcon"
            width="15"
            height="15"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M8 4.5C6.6 3.3 4.5 3 3 3v9c1.5 0 3.6.3 5 1.5 1.4-1.2 3.5-1.5 5-1.5V3c-1.5 0-3.6.3-5 1.5z" />
            <path d="M8 4.5v9" />
          </svg>
          <span className="qym-skillTriggerLabel">技能 / 专家</span>
          {total > 0 ? <span className="qym-skillTriggerCount">{total}</span> : null}
        </button>
      ) : null}
      {open ? (
        <>
          <div className="qym-skillScrim" onClick={close} />
          <div className="qym-skillMenu" style={pos ?? undefined} role="dialog" aria-label="技能 / 专家">
            <input
              type="text"
              className="qym-skillSearch"
              placeholder="搜索技能或专家，点选即跟随会话…"
              value={query}
              onChange={event => setQuery(event.target.value)}
              autoFocus
            />
            {attachError ? <p className="qym-skillAttachError">{attachError}</p> : null}
            {total === 0 ? (
              <p className="qym-skillEmpty">还没有安装任何技能或专家。到 Yuze-市场安装后再回来。</p>
            ) : (
              <div className="qym-skillList">
                {skills.length > 0 ? (
                  <div className="qym-skillGroup">
                    <div className="qym-skillGroupTitle">
                      技能 <span className="qym-skillGroupCount">{skills.length}</span>
                    </div>
                    <ul>
                      {skills.map(entry => (
                        <DockRow
                          key={entry.name}
                          entry={entry}
                          selected={selectedNames.has(entry.name)}
                          onSelect={() => toggleSelected(entry)}
                          onCall={() => invoke(entry.name)}
                        />
                      ))}
                    </ul>
                  </div>
                ) : null}
                {experts.length > 0 ? (
                  <div className="qym-skillGroup">
                    <div className="qym-skillGroupTitle">
                      专家 <span className="qym-skillGroupCount">{experts.length}</span>
                    </div>
                    <ul>
                      {experts.map(entry => (
                        <DockRow
                          key={entry.name}
                          entry={entry}
                          selected={selectedNames.has(entry.name)}
                          onSelect={() => toggleSelected(entry)}
                          onCall={() => invoke(entry.name)}
                        />
                      ))}
                    </ul>
                  </div>
                ) : null}
                {filtered === 0 ? (
                  <p className="qym-skillEmpty">
                    没有匹配「{query.trim()}」的技能或专家。
                  </p>
                ) : null}
              </div>
            )}
          </div>
        </>
      ) : null}
    </span>
  )
}
