/**
 * The 「已安装」view.
 *
 * It is a view of its own rather than a filter on the current tab: opening it
 * shows every installed skill, expert, connector and plugin at once, grouped by
 * product, so browsing installed items never depends on which tab happens to be
 * active. Everything is a card, matching the market grid.
 */

import type { ReactNode } from 'react'

import type { InstalledConnectorEntry, InstalledPluginEntry, InstalledSkillEntry } from './api.js'
import { describeAuth, useConnectorAuth } from './connector-auth.js'
import { Avatar, Badge } from './ui.js'

export interface InstalledBoardProps {
  readonly skills: readonly InstalledSkillEntry[]
  readonly connectors: readonly InstalledConnectorEntry[]
  readonly plugins: readonly InstalledPluginEntry[]
  readonly busyId?: string | undefined
  readonly onToggleSkill: (entry: InstalledSkillEntry) => void
  readonly onRemoveSkill: (entry: InstalledSkillEntry) => void
  readonly onInvokeSkill: (entry: InstalledSkillEntry) => void
  readonly onToggleConnector: (entry: InstalledConnectorEntry) => void
  readonly onRemoveConnector: (entry: InstalledConnectorEntry) => void
  readonly onTogglePlugin: (entry: InstalledPluginEntry) => void
  readonly onRemovePlugin: (entry: InstalledPluginEntry) => void
}

/** Shared card frame: artwork, title, footnote, badge, action row. */
function Tile(props: {
  readonly artUrl?: string | undefined
  readonly title: string
  readonly subtitle?: string | undefined
  readonly badge: ReactNode
  readonly actions: ReactNode
  readonly id: string
}): JSX.Element {
  const { artUrl, title, subtitle, badge, actions, id } = props
  return (
    <li>
      <article className="qym-card qym-card--owned" data-qym-owned={id}>
        <div className="qym-cardHead">
          <Avatar item={{ title, ...(artUrl === undefined ? {} : { artUrl }) }} />
          <div className="qym-cardTitleWrap">
            <p className="qym-cardTitle" title={title}>
              {title}
            </p>
            {subtitle !== undefined && subtitle.length > 0 ? (
              <div className="qym-cardSub">
                <span>{subtitle}</span>
              </div>
            ) : null}
          </div>
          {badge}
        </div>
        <div className="qym-cardFoot">
          <span />
          <span className="qym-cardActions">{actions}</span>
        </div>
      </article>
    </li>
  )
}

function Group(props: { readonly title: string; readonly count: number; readonly children: ReactNode }): JSX.Element {
  return (
    <section className="qym-group" data-qym-group={props.title}>
      <div className="qym-groupHead">
        <h2 className="qym-groupTitle">{props.title}</h2>
        <span className="qym-count">{props.count}</span>
      </div>
      <ul className="qym-grid">{props.children}</ul>
    </section>
  )
}

/** One installed MCP server; it owns its authorization state. */
function ConnectorTile(props: {
  readonly entry: InstalledConnectorEntry
  readonly busy: boolean
  readonly onToggle: () => void
  readonly onRemove: () => void
}): JSX.Element {
  const { entry, busy, onToggle, onRemove } = props
  const { auth, busy: authBusy, pending, authorize, disconnect } = useConnectorAuth([entry.serverName])
  const state = auth[entry.serverName]
  const remote = entry.transport === 'streamable-http'
  const canAuthorize = remote && state !== undefined && state.mcpUrl !== null

  return (
    <Tile
      id={`connector:${entry.serverName}`}
      {...(entry.artUrl === undefined ? {} : { artUrl: entry.artUrl })}
      title={entry.serverName}
      subtitle={describeAuth(state, pending?.server === entry.serverName, entry.transport)}
      badge={<Badge tone={entry.enabled ? 'on' : 'off'}>{entry.enabled ? '已启用' : '已停用'}</Badge>}
      actions={
        <>
          {state?.authorized === true ? (
            <button type="button" className="qym-btn" onClick={() => void disconnect(entry.serverName)}>
              断开
            </button>
          ) : canAuthorize ? (
            <button
              type="button"
              className="qym-btn"
              disabled={authBusy === entry.serverName}
              onClick={() => void authorize(entry.serverName, state?.mcpUrl ?? '')}
            >
              {authBusy === entry.serverName ? '授权中…' : '授权'}
            </button>
          ) : null}
          <button type="button" className="qym-btn" disabled={busy} onClick={onToggle}>
            {entry.enabled ? '停用' : '启用'}
          </button>
          <button type="button" className="qym-btn qym-btn--danger" disabled={busy} onClick={onRemove}>
            删除
          </button>
        </>
      }
    />
  )
}

export function InstalledBoard(props: InstalledBoardProps): JSX.Element {
  const {
    skills,
    connectors,
    plugins,
    busyId,
    onToggleSkill,
    onRemoveSkill,
    onInvokeSkill,
    onToggleConnector,
    onRemoveConnector,
    onTogglePlugin,
    onRemovePlugin,
  } = props

  const plainSkills = skills.filter(entry => entry.kind !== 'expert')
  const experts = skills.filter(entry => entry.kind === 'expert')
  const total = skills.length + connectors.length + plugins.length

  if (total === 0) {
    return <p className="qym-empty">还没有安装任何内容。切回市场浏览并安装即可。</p>
  }

  return (
    <div className="qym-owned">
      {plainSkills.length > 0 ? (
        <Group title="技能" count={plainSkills.length}>
          {plainSkills.map(entry => (
            <Tile
              key={entry.name}
              id={`skill:${entry.name}`}
              {...(entry.artUrl === undefined ? {} : { artUrl: entry.artUrl })}
              title={entry.title}
              subtitle={[entry.name, entry.version === undefined ? '' : `v${entry.version}`]
                .filter(part => part.length > 0)
                .join(' · ')}
              badge={<Badge tone={entry.enabled ? 'on' : 'off'}>{entry.enabled ? '已启用' : '已停用'}</Badge>}
              actions={
                <>
                  <button type="button" className="qym-btn qym-btn--primary" onClick={() => onInvokeSkill(entry)}>
                    调用
                  </button>
                  <button
                    type="button"
                    className="qym-btn"
                    disabled={busyId === `skill:${entry.name}`}
                    onClick={() => onToggleSkill(entry)}
                  >
                    {entry.enabled ? '停用' : '启用'}
                  </button>
                  <button
                    type="button"
                    className="qym-btn qym-btn--danger"
                    disabled={busyId === `skill:${entry.name}`}
                    onClick={() => onRemoveSkill(entry)}
                  >
                    删除
                  </button>
                </>
              }
            />
          ))}
        </Group>
      ) : null}

      {experts.length > 0 ? (
        <Group title="专家" count={experts.length}>
          {experts.map(entry => (
            <Tile
              key={entry.name}
              id={`expert:${entry.name}`}
              {...(entry.artUrl === undefined ? {} : { artUrl: entry.artUrl })}
              title={entry.title}
              subtitle={entry.name}
              badge={<Badge tone={entry.enabled ? 'on' : 'off'}>{entry.enabled ? '已启用' : '已停用'}</Badge>}
              actions={
                <>
                  <button type="button" className="qym-btn qym-btn--primary" onClick={() => onInvokeSkill(entry)}>
                    调用
                  </button>
                  <button
                    type="button"
                    className="qym-btn"
                    disabled={busyId === `skill:${entry.name}`}
                    onClick={() => onToggleSkill(entry)}
                  >
                    {entry.enabled ? '停用' : '启用'}
                  </button>
                  <button
                    type="button"
                    className="qym-btn qym-btn--danger"
                    disabled={busyId === `skill:${entry.name}`}
                    onClick={() => onRemoveSkill(entry)}
                  >
                    删除
                  </button>
                </>
              }
            />
          ))}
        </Group>
      ) : null}

      {connectors.length > 0 ? (
        <Group title="连接器" count={connectors.length}>
          {connectors.map(entry => (
            <ConnectorTile
              key={entry.serverName}
              entry={entry}
              busy={busyId === `connector:${entry.serverName}`}
              onToggle={() => onToggleConnector(entry)}
              onRemove={() => onRemoveConnector(entry)}
            />
          ))}
        </Group>
      ) : null}

      {plugins.length > 0 ? (
        <Group title="插件" count={plugins.length}>
          {plugins.map(entry => (
            <Tile
              key={entry.packageName}
              id={`plugin:${entry.packageName}`}
              title={entry.packageName}
              subtitle={entry.version.length > 0 ? `v${entry.version}` : '本地包'}
              badge={<Badge tone={entry.enabled ? 'on' : 'off'}>{entry.enabled ? '已启用' : '已停用'}</Badge>}
              actions={
                entry.builtin ? (
                  <span className="qym-hintline">内置，不可改动</span>
                ) : (
                  <>
                    <button
                      type="button"
                      className="qym-btn"
                      disabled={busyId === `plugin:${entry.packageName}`}
                      onClick={() => onTogglePlugin(entry)}
                    >
                      {entry.enabled ? '停用' : '启用'}
                    </button>
                    <button
                      type="button"
                      className="qym-btn qym-btn--danger"
                      onClick={() => onRemovePlugin(entry)}
                    >
                      卸载
                    </button>
                  </>
                )
              }
            />
          ))}
        </Group>
      ) : null}
    </div>
  )
}
