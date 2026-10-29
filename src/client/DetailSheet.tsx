/**
 * The detail sheet opened by clicking a card.
 *
 * Mirrors what a macOS inspector shows: identity at the top, one primary action
 * beside it, then the prose, the facts, and the example prompts. Every action
 * that mutates state is delegated to the panel — the sheet only reports intent.
 */

import { useState } from 'react'

import type { InstalledSkillEntry, UnifiedItem } from './api.js'
import { Avatar, Badge, formatUsage } from './ui.js'

export interface DetailSheetProps {
  readonly item: UnifiedItem
  readonly installed?: InstalledSkillEntry
  readonly busy: boolean
  readonly notice?: string
  /** Stage label while a long install runs (restart → signature → download). */
  readonly progress?: string
  /**
   * Set when the install needs WorkBuddy relaunched for a fresh signature. The
   * sheet has to own this prompt: it is the surface the user just clicked on,
   * and the panel-level banner sits behind the scrim where nobody can reach it.
   */
  readonly restartPrompt?: string
  readonly onConfirmRestart?: () => void
  readonly onCancelRestart?: () => void
  readonly onClose: () => void
  readonly onInstall: () => void
  readonly onToggleEnabled?: (enabled: boolean) => void
  readonly onRemove?: () => void
}

const KIND_LABEL: Readonly<Record<string, string>> = {
  skill: '技能',
  expert: '专家',
  connector: '连接器',
  plugin: '插件',
}

/** Prompt examples: experts carry quick prompts, skills carry examples. */
function examplesOf(item: UnifiedItem): readonly string[] {
  if (item.quickPrompts !== undefined && item.quickPrompts.length > 0) return item.quickPrompts
  if (item.examples !== undefined && item.examples.length > 0) return item.examples
  if (item.prompt !== undefined && item.prompt.length > 0) return [item.prompt]
  return []
}

export function DetailSheet(props: DetailSheetProps): JSX.Element {
  const {
    item,
    installed,
    busy,
    notice,
    progress,
    restartPrompt,
    onConfirmRestart,
    onCancelRestart,
    onClose,
    onInstall,
    onToggleEnabled,
    onRemove,
  } = props
  const [copied, setCopied] = useState<number | null>(null)
  const examples = examplesOf(item)

  const copy = (text: string, index: number): void => {
    void navigator.clipboard?.writeText(text).then(
      () => {
        setCopied(index)
        setTimeout(() => setCopied(current => (current === index ? null : current)), 1400)
      },
      () => undefined,
    )
  }

  return (
    <div className="qym-scrim" role="presentation" onClick={onClose}>
      <div
        className="qym-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={item.title}
        data-qym-detail={item.id}
        onClick={event => event.stopPropagation()}
      >
        <div className="qym-sheetHead">
          <Avatar item={item} size="lg" />
          <div style={{ flex: 1, minWidth: 0 }}>
            <h2 className="qym-sheetTitle">{item.title}</h2>
            <p className="qym-sheetSub">
              {[KIND_LABEL[item.tab] ?? item.tab, item.category, item.author]
                .filter(value => value !== undefined && value.length > 0)
                .join(' · ')}
            </p>
            <div className="qym-actions" style={{ marginTop: 10 }}>
              {installed === undefined ? (
                <button
                  type="button"
                  className="qym-btn qym-btn--primary qym-btn--lg"
                  disabled={busy || !item.installable}
                  onClick={onInstall}
                >
                  {busy ? (progress ?? '安装中…') : item.installable ? '安装' : '不可安装'}
                </button>
              ) : (
                <>
                  <Badge tone={installed.enabled ? 'on' : 'off'}>
                    {installed.enabled ? '已安装' : '已停用'}
                  </Badge>
                  {onToggleEnabled !== undefined ? (
                    <button
                      type="button"
                      className="qym-btn"
                      disabled={busy}
                      onClick={() => onToggleEnabled(!installed.enabled)}
                    >
                      {installed.enabled ? '停用' : '启用'}
                    </button>
                  ) : null}
                  {onRemove !== undefined ? (
                    <button type="button" className="qym-btn qym-btn--danger" disabled={busy} onClick={onRemove}>
                      删除
                    </button>
                  ) : null}
                </>
              )}
            </div>
          </div>
          <button type="button" className="qym-close" aria-label="关闭" onClick={onClose}>
            ×
          </button>
        </div>

        {restartPrompt !== undefined && restartPrompt.length > 0 ? (
          <div className="qym-note" data-snapshot-hint="">
            <span>{restartPrompt}</span>
            <span className="qym-actions">
              <button type="button" className="qym-btn" onClick={onCancelRestart}>
                取消
              </button>
              <button
                type="button"
                className="qym-btn qym-btn--primary"
                disabled={busy}
                onClick={onConfirmRestart}
              >
                {busy ? (progress ?? '处理中…') : '重启 WorkBuddy 并安装'}
              </button>
            </span>
          </div>
        ) : null}

        {notice !== undefined && notice.length > 0 ? (
          <p className="qym-note" data-tone={notice.startsWith('已') ? 'ok' : 'error'}>
            {notice}
          </p>
        ) : null}

        {item.description.length > 0 ? <p className="qym-sheetBody">{item.description}</p> : null}

        {!item.installable && item.installNote !== undefined ? (
          <p className="qym-note">{item.installNote}</p>
        ) : null}

        <div className="qym-divider" />

        <div className="qym-facts">
          {item.version !== undefined && item.version.length > 0 ? (
            <div>
              <div className="qym-factKey">版本</div>
              <div className="qym-factValue">{item.version}</div>
            </div>
          ) : null}
          {item.usage !== undefined ? (
            <div>
              <div className="qym-factKey">使用量</div>
              <div className="qym-factValue">⚡ {formatUsage(item.usage)}</div>
            </div>
          ) : null}
          {item.transport !== undefined ? (
            <div>
              <div className="qym-factKey">传输</div>
              <div className="qym-factValue">{item.transport}</div>
            </div>
          ) : null}
          {installed !== undefined ? (
            <div>
              <div className="qym-factKey">安装为</div>
              <div className="qym-factValue">{installed.name}</div>
            </div>
          ) : null}
          <div>
            <div className="qym-factKey">标识</div>
            <div className="qym-factValue">{item.name}</div>
          </div>
        </div>

        {item.tags.length > 0 ? (
          <div className="qym-tags">
            {item.tags.slice(0, 8).map(tag => (
              <Badge key={tag} tone="off">
                {tag}
              </Badge>
            ))}
          </div>
        ) : null}

        {examples.length > 0 ? (
          <>
            <div className="qym-divider" />
            <p className="qym-sectionTitle">试试这样用</p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {examples.slice(0, 5).map((text, index) => (
                <button
                  key={`${index}:${text.slice(0, 12)}`}
                  type="button"
                  className="qym-prompt"
                  title="点击复制"
                  onClick={() => copy(text, index)}
                >
                  <span className="qym-promptText">{text}</span>
                  <span style={{ flex: 'none', opacity: 0.5, fontSize: 11 }}>
                    {copied === index ? '已复制' : '复制'}
                  </span>
                </button>
              ))}
            </div>
          </>
        ) : null}
      </div>
    </div>
  )
}
