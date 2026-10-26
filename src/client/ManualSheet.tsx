/**
 * Manual install sheet.
 *
 * Each tab accepts the artefact that actually exists for that product, so the
 * form never asks for something the Host cannot use:
 *
 * - 技能 / 专家: a local directory or a `.zip` holding `SKILL.md`
 * - 连接器: the `mcp.json` body (or a flat `{serverName, transport, url}`)
 * - 插件: an npm package name, a `.tgz`, or a package directory
 */

import { useState } from 'react'

import { marketApi, type Tab } from './api.js'

export interface ManualSheetProps {
  readonly tab: Tab
  readonly onClose: () => void
  readonly onDone: (message: string) => void
  /** Opens the Host's native folder chooser; undefined hides the button. */
  readonly onPickDirectory?: () => Promise<{ readonly ok: boolean; readonly path?: string | null }>
}

const CONNECTOR_PLACEHOLDER = `{
  "mcpServers": {
    "my-server": {
      "transport": "streamable-http",
      "url": "https://example.com/mcp"
    }
  }
}`

const TITLES: Readonly<Record<Tab, string>> = {
  skill: '手动安装技能',
  expert: '手动安装专家',
  connector: '手动添加连接器',
  plugin: '手动安装插件',
}

export function ManualSheet(props: ManualSheetProps): JSX.Element {
  const { tab, onClose, onDone, onPickDirectory } = props
  const [source, setSource] = useState('')
  const [name, setName] = useState('')
  const [json, setJson] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const [picking, setPicking] = useState(false)

  const pick = async (): Promise<void> => {
    if (onPickDirectory === undefined) return
    setPicking(true)
    setError(undefined)
    try {
      const outcome = await onPickDirectory()
      if (!outcome.ok) {
        setError('当前宿主没有可用的系统目录选择器，请直接填写路径')
        return
      }
      if (typeof outcome.path === 'string' && outcome.path.length > 0) setSource(outcome.path)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setPicking(false)
    }
  }

  const submit = async (): Promise<void> => {
    setBusy(true)
    setError(undefined)
    try {
      const payload: Record<string, unknown> =
        tab === 'connector'
          ? { target: 'connector', json }
          : tab === 'plugin'
            ? { target: 'plugin', spec: source }
            : { target: tab === 'expert' ? 'expert' : 'skill', path: source, ...(name.length > 0 ? { name } : {}) }
      const result = await marketApi.manual(payload)
      if (!result.ok) {
        setError(result.message ?? '安装失败')
        return
      }
      onDone(result.message ?? '安装完成')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const hint =
    tab === 'connector'
      ? '支持完整 mcp.json，或扁平对象 { "serverName": "...", "transport": "streamable-http", "url": "..." }'
      : tab === 'plugin'
        ? '包名（如 dsh-cron-board）、.tgz 文件路径，或本地包目录'
        : '本地目录或 .zip 路径，目录内需要 SKILL.md'

  return (
    <div className="qym-scrim" role="presentation" onClick={onClose}>
      <div
        className="qym-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={TITLES[tab]}
        data-qym-manual={tab}
        onClick={event => event.stopPropagation()}
      >
        <div className="qym-sheetHead">
          <div style={{ flex: 1, minWidth: 0 }}>
            <h2 className="qym-sheetTitle">{TITLES[tab]}</h2>
            <p className="qym-sheetSub">{hint}</p>
          </div>
          <button type="button" className="qym-close" aria-label="关闭" onClick={onClose}>
            ×
          </button>
        </div>

        {tab === 'connector' ? (
          <div className="qym-field">
            <label className="qym-label" htmlFor="qym-manual-json">
              MCP 配置
            </label>
            <textarea
              id="qym-manual-json"
              className="qym-textarea"
              value={json}
              placeholder={CONNECTOR_PLACEHOLDER}
              onChange={event => setJson(event.target.value)}
            />
          </div>
        ) : (
          <>
            <div className="qym-field">
              <label className="qym-label" htmlFor="qym-manual-source">
                {tab === 'plugin' ? '包名 / 路径' : '目录或压缩包路径'}
              </label>
              <div className="qym-pickRow">
                <input
                  id="qym-manual-source"
                  className="qym-input"
                  value={source}
                  spellCheck={false}
                  placeholder={
                    tab === 'plugin' ? 'dsh-cron-board 或 /Users/you/packages/my-plugin' : '/Users/you/skills/my-skill'
                  }
                  onChange={event => setSource(event.target.value)}
                />
                {onPickDirectory === undefined ? null : (
                  <button type="button" className="qym-btn" disabled={picking} onClick={() => void pick()}>
                    {picking ? '选择中…' : '选择…'}
                  </button>
                )}
              </div>
            </div>
            {tab !== 'plugin' ? (
              <div className="qym-field">
                <label className="qym-label" htmlFor="qym-manual-name">
                  安装名称（可选，留空则用目录名）
                </label>
                <input
                  id="qym-manual-name"
                  className="qym-input"
                  value={name}
                  spellCheck={false}
                  placeholder="my-skill"
                  onChange={event => setName(event.target.value)}
                />
              </div>
            ) : null}
          </>
        )}

        {error !== undefined ? (
          <p className="qym-note" data-tone="error">
            {error}
          </p>
        ) : null}

        <div className="qym-actions" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="qym-btn" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="qym-btn qym-btn--primary"
            disabled={busy || (tab === 'connector' ? json.trim().length === 0 : source.trim().length === 0)}
            onClick={() => void submit()}
          >
            {busy ? '安装中…' : '安装'}
          </button>
        </div>
      </div>
    </div>
  )
}
