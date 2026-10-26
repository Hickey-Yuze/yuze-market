/**
 * Native folder chooser, tried through every channel the Desktop shell exposes.
 *
 * Three exist and none covers every platform on its own:
 *
 * 1. `POST /_dsh/desktop/pick-directory` — the shell's own same-origin route.
 *    macOS and Windows both use it, and it is the only one that works on
 *    Windows.
 * 2. `window.__DSH_DIRECTORY_PICKER__` — a macOS preload bridge that is live
 *    even before the Host's client plugins have mounted.
 * 3. `ctx.remote.directoryPicker.pick()` — the cordis remote namespace, which
 *    returns `{ ok, value }` and may not be mounted in every composition.
 *
 * A channel that is simply absent reports `unavailable` so the next one runs; a
 * chooser the user cancelled reports `cancelled` and stops the chain, otherwise
 * cancelling once would pop a second dialog.
 */

import type { Context } from '@deepseek-ai/cordis'

export type PickOutcome = { readonly ok: true; readonly path: string | null } | { readonly ok: false }

export interface Attempt {
  readonly status: 'picked' | 'cancelled' | 'unavailable'
  readonly path?: string
}

const DESKTOP_PICK_PATH = '/_dsh/desktop/pick-directory'

async function pickViaDesktopShell(call: typeof fetch = fetch): Promise<Attempt> {
  try {
    const response = await call(DESKTOP_PICK_PATH, {
      method: 'POST',
      headers: { accept: 'application/json' },
    })
    if (!response.ok) return { status: 'unavailable' }
    const body = (await response.json()) as { path?: unknown }
    if (!('path' in body)) return { status: 'unavailable' }
    return typeof body.path === 'string' && body.path.length > 0
      ? { status: 'picked', path: body.path }
      : { status: 'cancelled' }
  } catch {
    return { status: 'unavailable' }
  }
}

async function pickViaPreload(target: { readonly __DSH_DIRECTORY_PICKER__?: { pick?: unknown } } = window as never): Promise<Attempt> {
  const bridge = target.__DSH_DIRECTORY_PICKER__
  if (bridge === undefined || typeof bridge.pick !== 'function') return { status: 'unavailable' }
  try {
    const value = (await (bridge.pick as () => Promise<unknown>).call(bridge)) as unknown
    if (typeof value === 'string' && value.length > 0) return { status: 'picked', path: value }
    if (value === null || value === undefined) return { status: 'cancelled' }
    if (typeof value === 'object') {
      const path = (value as { path?: unknown }).path
      if (typeof path === 'string' && path.length > 0) return { status: 'picked', path }
      if (path === null) return { status: 'cancelled' }
    }
    return { status: 'unavailable' }
  } catch {
    return { status: 'unavailable' }
  }
}

async function pickViaRemote(ctx: Context | undefined): Promise<Attempt> {
  if (ctx === undefined) return { status: 'unavailable' }
  const remote = (ctx as unknown as { remote?: unknown }).remote
  if (remote === null || remote === undefined || typeof remote !== 'object') return { status: 'unavailable' }
  const namespace = (remote as { directoryPicker?: unknown }).directoryPicker
  if (namespace === null || namespace === undefined || typeof namespace !== 'object') return { status: 'unavailable' }
  const pick = (namespace as { pick?: unknown }).pick
  if (typeof pick !== 'function') return { status: 'unavailable' }
  try {
    const result = (await (pick as () => Promise<unknown>).call(namespace)) as unknown
    if (result === null || result === undefined) return { status: 'unavailable' }
    const envelope = result as { ok?: unknown; value?: unknown }
    if (envelope.ok === false) return { status: 'unavailable' }
    const value = envelope.ok === true ? envelope.value : result
    if (typeof value === 'string' && value.length > 0) return { status: 'picked', path: value }
    if (value === null) return { status: 'cancelled' }
    return { status: 'unavailable' }
  } catch {
    return { status: 'unavailable' }
  }
}

export interface PickerEnvironment {
  readonly ctx?: Context
  readonly fetch?: typeof fetch
  readonly target?: { readonly __DSH_DIRECTORY_PICKER__?: { pick?: unknown } }
}

export function createDirectoryPicker(ctx: Context): () => Promise<PickOutcome> {
  return createDirectoryPickerWith(ctx, {})
}

/** Same chain with injectable transport, so it can be exercised without a Host. */
export function createDirectoryPickerWith(ctx: Context | undefined, env: PickerEnvironment): () => Promise<PickOutcome> {
  return async (): Promise<PickOutcome> => {
    // Sequential on purpose: building an array of the three calls would invoke
    // every bridge before inspecting the first result, i.e. pop three dialogs.
    const channels = [
      () => pickViaDesktopShell(env.fetch),
      () => pickViaPreload(env.target),
      () => pickViaRemote(ctx),
    ]
    for (const channel of channels) {
      const attempt = await channel()
      if (attempt.status === 'picked' && attempt.path !== undefined) return { ok: true, path: attempt.path }
      if (attempt.status === 'cancelled') return { ok: true, path: null }
    }
    return { ok: false }
  }
}
