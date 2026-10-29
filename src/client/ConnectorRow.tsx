/**
 * One installed MCP connector, with its authorization state.
 *
 * Both surfaces that list connectors (the 连接器 tab and the row this plugin
 * contributes to the Host's 连接器 panel) render this component, so the switch,
 * the token state and the delete action can never drift apart.
 */

import { describeAuth, useConnectorAuth } from './connector-auth.js'

export interface ConnectorRowProps {
  readonly serverName: string
  readonly transport: string
  readonly enabled: boolean
  /** Catalogue title to display instead of the internal server name. */
  readonly title?: string
  /** Brand icon shown before the name, for child rows of the Yuze-MCP connector. */
  readonly icon?: JSX.Element
  readonly onToggleEnabled: (enabled: boolean) => void
  readonly onRemove: () => void
}

export function ConnectorRow(props: ConnectorRowProps): JSX.Element {
  const { serverName, transport, enabled, title, icon, onToggleEnabled, onRemove } = props
  const { auth, busy, message, pending, authorize, disconnect } = useConnectorAuth([serverName])
  const state = auth[serverName]
  const remote = transport === 'streamable-http'
  const canAuthorize = remote && state !== undefined && state.mcpUrl !== null

  return (
    <li className="qym-row" data-qym-connector={serverName}>
      <div className="qym-rowMain">
        <span className="qym-rowName" title={serverName}>
          {icon !== undefined ? <span className="qym-rowIcon">{icon}</span> : null}
          {title ?? serverName}
        </span>
        <span className="qym-rowMeta">
          {describeAuth(state, pending?.server === serverName, transport)}
          {enabled ? '' : ' · 已停用'}
          {message === null || message.length === 0 ? '' : ` · ${message}`}
        </span>
        {pending !== null ? (
          <a href={pending.url} target="_blank" rel="noreferrer noopener" className="qym-hint">
            打开授权页
          </a>
        ) : null}
      </div>
      <div className="qym-rowActions">
        {state?.authorized === true ? (
          <button type="button" className="qym-btn" disabled={busy === serverName} onClick={() => void disconnect(serverName)}>
            断开
          </button>
        ) : canAuthorize ? (
          <button
            type="button"
            className="qym-btn"
            disabled={busy === serverName}
            onClick={() => void authorize(serverName, state?.mcpUrl ?? '')}
          >
            {busy === serverName ? '授权中…' : state?.expired === true ? '重新授权' : '授权'}
          </button>
        ) : null}
        <button type="button" className="qym-btn" onClick={() => onToggleEnabled(!enabled)}>
          {enabled ? '停用' : '启用'}
        </button>
        <button type="button" className="qym-btn qym-btn--danger" onClick={onRemove}>
          删除
        </button>
      </div>
    </li>
  )
}
