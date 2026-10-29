/**
 * Composer dock entry —— 点击调用技能 / 专家。
 *
 * Registers into the Host's session-scoped `conversation.input.dock` slot,
 * where the framework injects `inputActions` (setDraft + submit). Picking an
 * installed skill or expert here calls it exactly like the user had typed
 * `/name` and hit send: setDraft('/'+name) then submit, so the Host slash
 * pipeline loads the skill. It sits next to the shared 连接器 panel, hence
 * "像连接器一样：点一下就用，不用每次手输调用指令"。
 *
 * The dock lists installed entries only (what the user can actually invoke),
 * with a search box to jump to one. The market panel keeps the install/remove
 * flows; it announces changes through the INSTALLED_CHANGED_EVENT and asks for
 * a call through dispatchInvokeSkill, so the dock and the panel stay in sync
 * without any shared store.
 */

import { useCallback, useEffect, useState } from 'react'

import type { InstalledSkillEntry } from './api.js'
import { marketApi } from './api.js'
import { Avatar } from './ui.js'

/**
 * Host-injected session input face (the subset this dock needs). The Host
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

/** Ask the composer dock to call `/name` (fire-and-forget from the panel). */
export function dispatchInvokeSkill(name: string): void {
  window.dispatchEvent(new CustomEvent(INVOKE_EVENT, { detail: { name } }))
}

/** Announce that the installed set changed so the dock can refresh. */
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

export function SkillInvokeDock(props: SkillInvokeDockProps): JSX.Element {
  const { inputActions } = props
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [entries, setEntries] = useState<readonly InstalledSkillEntry[]>([])

  const load = useCallback(async (): Promise<void> => {
    try {
      const payload = await marketApi.installed()
      setEntries(payload.skills)
    } catch {
      // The dock degrades to empty; the market panel still owns installs.
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

  useEffect(() => {
    void load()
    const onInstalled = (): void => void load()
    const onInvoke = (event: Event): void => {
      const detail = (event as CustomEvent<{ name?: unknown }>).detail
      if (typeof detail?.name === 'string') invoke(detail.name)
    }
    window.addEventListener(INSTALLED_CHANGED_EVENT, onInstalled)
    window.addEventListener(INVOKE_EVENT, onInvoke)
    return () => {
      window.removeEventListener(INSTALLED_CHANGED_EVENT, onInstalled)
      window.removeEventListener(INVOKE_EVENT, onInvoke)
    }
  }, [invoke, load])

  const skills = entries.filter(entry => entry.kind !== 'expert' && matches(entry, query))
  const experts = entries.filter(entry => entry.kind === 'expert' && matches(entry, query))
  const total = entries.length
  const filtered = skills.length + experts.length

  return (
    <div className="qym qym-skillDock">
      <button
        type="button"
        className="qym-skillDockTrigger"
        data-active={open}
        aria-expanded={open}
        onClick={() => setOpen(wasOpen => !wasOpen)}
      >
        <span className="qym-skillDockLabel">技能 / 专家</span>
        {total > 0 ? <span className="qym-badgeCount">已装 {total}</span> : <span className="qym-badgeCount">调用</span>}
      </button>
      {open ? (
        <div className="qym-skillDockPanel">
          <input
            type="text"
            className="qym-skillSearch"
            placeholder="搜索技能或专家，点击即调用…"
            value={query}
            onChange={event => setQuery(event.target.value)}
            autoFocus
          />
          {total === 0 ? (
            <p className="qym-empty">还没有安装任何技能或专家。到 Yuze-市场安装后再回来。</p>
          ) : (
            <div className="qym-skillList">
              {skills.length > 0 ? (
                <div className="qym-skillGroup">
                  <div className="qym-skillGroupTitle">
                    技能 <span className="qym-badgeCount">{skills.length}</span>
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
                    专家 <span className="qym-badgeCount">{experts.length}</span>
                  </div>
                  <ul>
                    {experts.map(entry => (
                      <DockRow key={entry.name} entry={entry} onPick={() => invoke(entry.name)} />
                    ))}
                  </ul>
                </div>
              ) : null}
              {filtered === 0 ? (
                <p className="qym-empty">
                  没有匹配「{query.trim()}」的技能或专家。
                </p>
              ) : null}
            </div>
          )}
        </div>
      ) : null}
    </div>
  )
}
