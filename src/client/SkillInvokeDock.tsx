/**
 * Composer input-left entry —— 点击调用技能 / 专家。
 *
 * Registers into the Host's session-scoped `conversation.input.left` tool row,
 * ordered before the shared 连接器 entry (order 40), so it sits 连接器左边.
 * The framework injects `inputActions` (setDraft + submit). Picking an
 * installed skill or expert here calls it exactly like the user had typed
 * `/name` and hit send: setDraft('/'+name) then submit, so the Host slash
 * pipeline loads the skill.
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

function DockRow(props: { readonly entry: InstalledSkillEntry; readonly onPick: () => void }): JSX.Element {
  const { entry, onPick } = props
  return (
    <li>
      <button type="button" className="qym-skillRow" onClick={onPick}>
        <Avatar size="sm" item={{ title: entry.title, ...(entry.artUrl === undefined ? {} : { artUrl: entry.artUrl }) }} />
        <span className="qym-skillRowText">
          <span className="qym-skillRowTitle">{entry.title}</span>
          <span className="qym-skillRowName">/{entry.name}</span>
        </span>
        <span className="qym-skillRowGo">调用</span>
      </button>
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
  const [pos, setPos] = useState<PopoverPos | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)

  const load = useCallback(async (): Promise<void> => {
    try {
      const payload = await marketApi.installed()
      setEntries(payload.skills)
    } catch {
      // The entry degrades to empty; the market panel still owns installs.
    }
  }, [])

  const invoke = useCallback(
    (name: string): void => {
      inputActions?.setDraft(`/${name}`)
      inputActions?.submit()
      setOpen(false)
    },
    [inputActions],
  )

  const close = useCallback((): void => {
    setOpen(false)
  }, [])

  // Anchor the popover just above the trigger, clamped to the viewport —
  // same placement the shared 连接器 panel uses (qw-dingtalk fallback path).
  const place = useCallback((): void => {
    const el = triggerRef.current
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

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="qym-skillTrigger"
        title="技能 / 专家"
        aria-label="技能 / 专家"
        aria-expanded={open}
        onClick={() => {
          if (open) {
            close()
            return
          }
          place()
          setOpen(true)
        }}
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
      {open ? (
        <>
          <div className="qym-skillScrim" onClick={close} />
          <div className="qym-skillMenu" style={pos ?? undefined} role="dialog" aria-label="技能 / 专家">
            <input
              type="text"
              className="qym-skillSearch"
              placeholder="搜索技能或专家，点击即调用…"
              value={query}
              onChange={event => setQuery(event.target.value)}
              autoFocus
            />
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
                        <DockRow key={entry.name} entry={entry} onPick={() => invoke(entry.name)} />
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
                        <DockRow key={entry.name} entry={entry} onPick={() => invoke(entry.name)} />
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
    </>
  )
}
