/**
 * dsh-pad, browser half: the floating dock in the frame-wide `shell.overlay`
 * layer, plus an invisible composer bridge inside each conversation so the
 * dock can hand prompts to the AI.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { InputActions } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { Component, createElement, useEffect, type ReactNode } from 'react'
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
 * A dock that fails to render would otherwise vanish without a trace: show the
 * message in place of the dock so the failure is reportable.
 */
class DockBoundary extends Component<{ children?: ReactNode }, { error?: Error }> {
  state: { error?: Error } = {}

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error }
  }

  render(): ReactNode {
    const error = this.state.error
    if (error === undefined) return this.props.children
    return createElement('div', {
      style: {
        position: 'fixed', right: '12px', top: '64px', zIndex: 99999, maxWidth: 'min(420px,80vw)',
        padding: '10px 12px', borderRadius: '12px', background: '#b00020', color: '#fff',
        font: '12px/18px ui-monospace,Consolas,monospace', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
      },
    }, `面板坞渲染失败：${error.message}`)
  }
}

/**
 * Client plugin body.
 *
 * Like the Host half, a broken dock must not break the shell: the web UI is
 * shared with everything else, so a failure here only disables the dock.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  try {
    start(ctx)
  } catch (error) {
    console.error('[dsh-pad] 面板坞启动失败，已禁用。在插件目录运行 `node scripts/doctor.mjs` 自检：', error)
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
  ctx.effect(() => {
    client.start()
    return () => client.stop()
  }, 'dsh-pad: stream')

  const Dock = createDock(client)
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'dsh-pad',
    order: 50,
    locale: NS,
  }, (props: PropsRuntime<'shell.overlay'> & PropsLocale<'dsh-pad'>) => createElement(DockBoundary, null, createElement(Dock, { t: props.t }))))

  ctx.slots.inject('conversation.input.overlay', () => ctx.slots.register({
    name: 'conversation.input.overlay',
    id: 'dsh-pad.composer-bridge',
    order: 1000,
  }, (props: PropsRuntime<'conversation.input.overlay'>) => createElement(ComposerBridge, { inputActions: props.inputActions })))
}
