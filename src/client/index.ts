/**
 * dsh-pad, browser half: the floating dock in the frame-wide `shell.overlay`
 * layer, plus an invisible composer bridge inside each conversation so the
 * dock can hand prompts to the AI.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { InputActions } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { createElement, useEffect, useSyncExternalStore } from 'react'
// Type-only: the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the renderer-owned slots service (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: declares the shell.overlay slot.
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { composer } from './composer.ts'
import { createDock } from './Dock.tsx'
import { en, type PadKey, zh } from './locales.ts'
import { PadClient } from './pad-client.ts'
import { DOCK_CSS } from './styles.ts'
import { recoverableSlot } from './recoverable-slot.ts'
import { RenderBoundary } from './RenderBoundary.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The panel dock's copy. */
    'dsh-pad': PadKey
  }
}

const NS = 'dsh-pad'

export const inject = ['slots', 'locale']

/** Publishes the mounted composer's input actions to the dock. */
function ComposerBridge({ inputActions }: { inputActions: InputActions }): null {
  useEffect(() => composer.attach(inputActions), [inputActions])
  return null
}

/**
 * Client plugin body.
 *
 * Report a failed activation to Cordis so its diagnostics and retry control
 * stay accurate. Swallowing it leaves an ACTIVE plugin with no dock entrance.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  try {
    // Cordis releases the registered effects when a failed activation throws.
    start(ctx)
  } catch (error) {
    console.error('[dsh-pad] 面板坞启动失败，可在客户端插件诊断中重试：', error)
    throw error
  }
}

/**
 * Register dictionaries, styles, the panel client and both dock slots.
 * @param ctx - client root context.
 */
function start(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-pad: dictionaries')

  ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset['plugin'] = NS
    style.textContent = DOCK_CSS
    document.head.appendChild(style)
    return () => style.remove()
  }, 'dsh-pad: styles')

  const client = new PadClient()
  const Dock = createDock(client)
  function DockEntrance(props: PropsRuntime<'shell.overlay'> & PropsLocale<'dsh-pad'>) {
    const snapshot = useSyncExternalStore(client.subscribe, client.getSnapshot)
    // Only a definition/layout change retries a failed chrome automatically;
    // ordinary source ticks must not repeatedly remount a broken dock.
    const resetKey = JSON.stringify([snapshot.layout, snapshot.panels.map(panel => [panel.id, panel.version])])
    return createElement(RenderBoundary, { t: props.t, resetKey, dock: true }, createElement(Dock, { t: props.t }))
  }
  recoverableSlot(ctx, 'shell.overlay', 'dsh-pad', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'dsh-pad',
    order: 50,
    locale: NS,
  }, DockEntrance))

  recoverableSlot(ctx, 'conversation.input.overlay', 'dsh-pad.composer-bridge', () => ctx.slots.register({
    name: 'conversation.input.overlay',
    id: 'dsh-pad.composer-bridge',
    order: 1000,
  }, (props: PropsRuntime<'conversation.input.overlay'>) => createElement(ComposerBridge, { inputActions: props.inputActions })))

  // The entrance belongs to the shell, independently of the data transport.
  ctx.effect(() => {
    client.start()
    return () => client.stop()
  }, 'dsh-pad: stream')
}
