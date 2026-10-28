/**
 * Client half entry point.
 *
 * Registers one sidebar entry — Yuze-市场 — and a single keyed `main` page with
 * four tabs (技能 / 专家 / 连接器 / 插件). Everything is served by the Node half
 * through the Host routes, so no market traffic leaves the Host.
 *
 * The plugin only needs the layout and locale services. When the Host lacks
 * them the registration is skipped instead of breaking the sidebar.
 */

import type { Context } from '@deepseek-ai/cordis'
import { IconBrowseOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { MarketPanel } from './MarketPanel.js'
import { createDirectoryPicker } from './picker.js'
import { registerYuzeMcpConnector } from './connector-hub.js'
import { NS, en, zh } from './locales.js'
import { styles } from './styles.js'

/** The single sidebar entry and panel id for the whole market. */
export const MARKET_PANEL_ID = 'yuze-market'

export const inject = ['slots', 'locale', 'layout']

declare module '@deepseek-ai/cordis' {
  interface Context {
    slots: {
      inject(slot: string, run: () => unknown): void
      register(options: Record<string, unknown>, component: unknown): unknown
    }
    locale: {
      register(namespace: string, dictionaries: { zh: Record<string, string>; en: Record<string, string> }): void
      bind(namespace: string): (key: string, params?: Record<string, unknown>) => string
    }
    layout: {
      selectPanel(id: string): void
      panelInfo: { subscribe(run: () => void): () => void }
    }
  }
}

function MarketPanelIcon(props: { size?: number }): JSX.Element {
  return <IconBrowseOutlineRegular size={props.size ?? 18} />
}

export function apply(ctx: Context): void {
  if (typeof document !== 'undefined' && !document.querySelector('style[data-yuze-market]')) {
    const element = document.createElement('style')
    element.dataset.yuzeMarket = ''
    element.textContent = styles
    document.head.appendChild(element)
  }

  ctx.effect(() => {
    ctx.locale.register(NS, { zh, en })
    return () => {}
  }, 'yuze-market: dictionaries')

  // Show the MCP side inside the shared 连接器 panel when one is mounted.
  ctx.effect(() => registerYuzeMcpConnector(), 'yuze-market: connector row')

  const t = ctx.locale.bind(NS)
  const onPickDirectory = createDirectoryPicker(ctx)

  ctx.slots.inject('main', () =>
    ctx.slots.register(
      {
        name: 'main',
        key: MARKET_PANEL_ID,
        locale: NS,
        inject: () => ({ t, onPickDirectory }),
      },
      MarketPanel,
    ),
  )

  ctx.slots.inject('sidebar.panellist', () =>
    ctx.slots.register(
      {
        name: 'sidebar.panellist',
        id: MARKET_PANEL_ID,
        order: 10,
        label: () => t('market.title'),
        locale: NS,
      },
      MarketPanelIcon,
    ),
  )
}
