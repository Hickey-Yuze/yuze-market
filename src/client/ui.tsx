/**
 * Presentational pieces for 市场.
 *
 * Everything here is dumb: it renders one item and reports clicks. Data loading,
 * installs and mutations live in `MarketPanel`, so a card can be rendered in a
 * test without a network.
 */

import { useState } from 'react'

import type { UnifiedItem } from './api.js'

/** Type label shown in the card's top-right pill. */
const TYPE_LABEL: Readonly<Record<string, string>> = {
  skill: '技能',
  expert: '专家',
  connector: '连接器',
  plugin: '插件',
}

/** 1 234 567 → 123.46万, 123 456 789 → 1.23亿 (the vendor shows the same shape). */
export function formatUsage(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return ''
  if (value >= 1e8) return `${(value / 1e8).toFixed(2)}亿`
  if (value >= 1e4) return `${(value / 1e4).toFixed(value >= 1e6 ? 0 : 1)}万`
  return value.toLocaleString('zh-CN')
}

/** Stable per-title colour, so a tile without artwork still looks intentional. */
function tint(title: string): string {
  const palette = ['#3b6ef6', '#7c5cf6', '#0ea5a4', '#f59e0b', '#ef4444', '#16a34a', '#d946ef', '#0f766e', '#6366f1', '#f97316']
  let hash = 0
  for (let index = 0; index < title.length; index++) hash = (hash * 31 + title.charCodeAt(index)) % 100000
  return palette[hash % palette.length] ?? palette[0]!
}

export interface AvatarProps {
  readonly item: Pick<UnifiedItem, 'artUrl' | 'emoji' | 'title'>
  readonly size?: 'xs' | 'sm' | 'md' | 'lg'
}

/** Brand artwork with a coloured initial fallback that never shows a broken image. */
export function Avatar(props: AvatarProps): JSX.Element {
  const { item, size = 'md' } = props
  const [broken, setBroken] = useState(false)
  const showImage = item.artUrl !== undefined && item.artUrl.length > 0 && !broken
  const sized =
    size === 'xs'
      ? { width: 24, height: 24, borderRadius: '50%', fontSize: 12 }
      : size === 'md'
        ? undefined
        : {
            width: size === 'lg' ? 76 : 30,
            height: size === 'lg' ? 76 : 30,
            borderRadius: size === 'lg' ? 17 : 8,
            fontSize: size === 'lg' ? 34 : 15,
          }

  return (
    <span className="qym-avatar" style={showImage ? sized : { background: tint(item.title), ...sized }} aria-hidden="true">
      {showImage ? (
        <img src={item.artUrl} alt="" loading="lazy" onError={() => setBroken(true)} />
      ) : item.emoji !== undefined && item.emoji.length > 0 ? (
        item.emoji
      ) : (
        (item.title.trim().slice(0, 1) || '·').toUpperCase()
      )}
    </span>
  )
}

export interface CardProps {
  readonly item: UnifiedItem
  /** Installed directory name, when this row is already on disk. */
  readonly installedAs?: string
  readonly installedEnabled?: boolean
  readonly busy: boolean
  readonly onOpen: () => void
  readonly onInstall: () => void
}

/** One grid card: avatar, title, sub-line, type pill, description, install action. */
export function Card(props: CardProps): JSX.Element {
  const { item, installedAs, installedEnabled, busy, onOpen, onInstall } = props
  const installed = installedAs !== undefined
  const usage = formatUsage(item.usage)
  const sub = item.name !== item.title ? item.name : (item.category ?? '')
  const state = busy ? 'loading' : 'idle'

  return (
    <li>
      <article
        className="qym-card"
        data-qym-item={item.id}
        onClick={onOpen}
        onKeyDown={event => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            onOpen()
          }
        }}
        role="button"
        tabIndex={0}
      >
        <div className="qym-cardHead">
          <Avatar item={item} />
          <div className="qym-cardTitleWrap">
            <p className="qym-cardTitle" title={item.title}>
              {item.title}
            </p>
            <div className="qym-cardSub">
              {sub.length > 0 ? <span>{sub}</span> : null}
              {item.version !== undefined && item.version.length > 0 ? (
                <>
                  {sub.length > 0 ? <i className="qym-dot" /> : null}
                  <span>v{item.version}</span>
                </>
              ) : null}
            </div>
          </div>
          <span
            className="qym-tagType"
            data-tone={installed ? (installedEnabled === false ? 'off' : 'on') : undefined}
          >
            {installed ? (installedEnabled === false ? '已停用' : '已安装') : (TYPE_LABEL[item.tab] ?? item.tab)}
          </span>
        </div>

        <p className="qym-cardDesc">{item.description}</p>

        <div className="qym-cardFoot">
          <div className="qym-cardMeta">
            {item.badge !== undefined ? <span>{item.badge}</span> : null}
            {item.category !== undefined && item.category.length > 0 ? (
              <>
                {item.badge !== undefined ? <i className="qym-dot" /> : null}
                <span>{item.category}</span>
              </>
            ) : null}
            {usage.length > 0 ? (
              <>
                <i className="qym-dot" />
                <span>{usage} 安装</span>
              </>
            ) : null}
          </div>
          {installed ? (
            <span className="qym-tagType" data-tone={installedEnabled === false ? 'off' : 'on'}>
              {installedEnabled === false ? '已停用' : '✓ 已安装'}
            </span>
          ) : item.installable ? (
            <button
              type="button"
              className="qym-btnInstall"
              data-state={state}
              disabled={busy}
              onClick={event => {
                event.stopPropagation()
                onInstall()
              }}
            >
              {state === 'loading' ? (
                <>
                  <span className="qym-spinner" />
                  安装中
                </>
              ) : (
                '安装'
              )}
            </button>
          ) : (
            <span className="qym-tagType" data-tone="off">
              不可安装
            </span>
          )}
        </div>
      </article>
    </li>
  )
}

/** Category filter chip with an optional count. */
export function Chip(props: {
  readonly active: boolean
  readonly count?: number
  readonly onClick: () => void
  readonly children: string
}): JSX.Element {
  const { active, count, onClick, children } = props
  return (
    <button type="button" className="qym-chip" data-active={active ? 'true' : 'false'} onClick={onClick}>
      {children}
      {count === undefined ? null : <span className="qym-chipCount">{count}</span>}
    </button>
  )
}

/** Small status pill used inside sheets and installed rows. */
export function Badge(props: { readonly tone: 'on' | 'off'; readonly children: string }): JSX.Element {
  return (
    <span className="qym-badge" data-tone={props.tone}>
      {props.children}
    </span>
  )
}
