/**
 * A panel's runtime: its HTML, CSS and script inside a sandboxed iframe.
 *
 * The frame gets `sandbox="allow-scripts"` without `allow-same-origin` (an
 * opaque origin: no cookies, no storage, no access to the dock's DOM) and a
 * CSP of `default-src 'none'` (no network). Its only way out is postMessage
 * to this component, which accepts a fixed set of requests from exactly this
 * frame carrying this frame's token.
 */
import { type PointerEvent as ReactPointerEvent, useEffect, useMemo, useRef, useState } from 'react'
import type { PanelData, PanelRunResult, PanelView } from '../shared/types.ts'
import { FRAME_RUNTIME } from './frame-runtime.ts'
import { clampPanelHeight, type HistoryPoint } from './pad-client.ts'
import type { ThemeSnapshot } from './theme.ts'

const CSP = "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:"
const BASE_CSS = `*,*::before,*::after{box-sizing:border-box}
html,body{margin:0;padding:0;background:transparent;color:var(--pad-fg);font:13px/1.45 var(--pad-font);-webkit-font-smoothing:antialiased}
html[data-height=auto]{overflow:hidden}
body{padding:2px 0 4px}
a{color:var(--pad-accent);text-decoration:none}
a:hover{text-decoration:underline dotted;text-underline-offset:3px}
::-webkit-scrollbar{width:6px;height:6px}::-webkit-scrollbar-thumb{background:var(--pad-border);border-radius:3px}`
export const MIN_AUTO_HEIGHT = 32
export const MAX_AUTO_HEIGHT = 640
const STATE_PREFIX = 'dsh-pad:state:'
const MAX_STATE_CHARS = 64 * 1024

function readState(panelId: string): Record<string, unknown> {
  try {
    return JSON.parse(localStorage.getItem(STATE_PREFIX + panelId) ?? '{}') as Record<string, unknown>
  } catch {
    return {}
  }
}

function writeState(panelId: string, key: string, value: unknown): void {
  const state = { ...readState(panelId), [key]: value }
  const text = JSON.stringify(state)
  if (text.length > MAX_STATE_CHARS) return
  try {
    localStorage.setItem(STATE_PREFIX + panelId, text)
  } catch {
    // Storage full or unavailable: state is best effort.
  }
}

function randomToken(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
}

interface FrameDocInput {
  readonly view: PanelView
  readonly token: string
  readonly theme: ThemeSnapshot
  readonly data: PanelData
  readonly histories: Record<string, readonly HistoryPoint[]>
  readonly lang: string
}

function frameDocument({ view, token, theme, data, histories, lang }: FrameDocInput): string {
  const { definition } = view
  const init = JSON.stringify({ data, histories, state: readState(view.id), lang }).replace(/</g, '\\u003c')
  const css = definition.css.replace(/<\/style/gi, '<\\/style')
  const script = definition.script.replace(/<\/script/gi, '<\\/script')
  return `<!doctype html>
<html data-token="${token}" data-mode="${theme.mode}" data-height="${definition.height === 'auto' ? 'auto' : 'fixed'}" lang="${lang}">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${CSP}">
<style id="pad-theme">${theme.css}</style>
<style>${BASE_CSS}</style>
<style>${css}</style>
<script type="application/json" id="pad-init">${init}</script>
</head>
<body>
${definition.html}
<script>${FRAME_RUNTIME}</script>
<script>${script}
//# sourceURL=dsh-pad/${view.id}.js</script>
</body>
</html>`
}

export interface PanelFrameProps {
  readonly view: PanelView
  readonly histories: () => Record<string, readonly HistoryPoint[]>
  readonly theme: ThemeSnapshot
  readonly lang: string
  readonly onRefresh: () => void
  readonly onAsk: (text: string) => void
  /** One model call requested by the panel's own code via `dsh.run`. */
  readonly onRun: (prompt: string, system?: string) => Promise<PanelRunResult>
  readonly onScriptError: (message: string | undefined) => void
  /** Height the user dragged this panel to; overrides the definition. */
  readonly height?: number
  /** Persist a dragged height, or clear it with `undefined` (back to auto). */
  readonly onHeightChange?: (height: number | undefined) => void
  readonly resizeLabel: string
  /** Hide the bottom drag handle (used by the zoomed view). */
  readonly resizable?: boolean
}

/** Messages a panel frame may send. */
type FrameMessage =
  | { kind: 'ready' }
  | { kind: 'resize', height: number }
  | { kind: 'refresh' }
  | { kind: 'open', url: string }
  | { kind: 'ask', text: string }
  | { kind: 'run', id: string, prompt: string, system?: string }
  | { kind: 'state', key: string, value: unknown }
  | { kind: 'error', message: string }

export function PanelFrame({ view, histories, theme, lang, onRefresh, onAsk, onRun, onScriptError, height, onHeightChange, resizeLabel, resizable = true }: PanelFrameProps) {
  const frameRef = useRef<HTMLIFrameElement>(null)
  const readyRef = useRef(false)
  const latest = useRef({ data: view.data, theme, onRefresh, onAsk, onRun, onScriptError, histories, height })
  const [dragHeight, setDragHeight] = useState<number>()
  const fixedHeight = view.definition.height === 'auto' ? undefined : view.definition.height
  latest.current = { data: view.data, theme, onRefresh, onAsk, onRun, onScriptError, histories, height }
  const [autoHeight, setAutoHeight] = useState(MIN_AUTO_HEIGHT * 2)
  const renderedHeight = dragHeight ?? height ?? fixedHeight ?? autoHeight
  const resizing = dragHeight !== undefined

  // A new document (and token) per definition version; data and theme updates are messages.
  const { token, doc } = useMemo(() => {
    const token = randomToken()
    readyRef.current = false
    const { data, theme: currentTheme, histories: readHistories } = latest.current
    return { token, doc: frameDocument({ view, token, theme: currentTheme, data, histories: readHistories(), lang }) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view.id, view.version, lang])

  const post = (message: Record<string, unknown>): void => {
    frameRef.current?.contentWindow?.postMessage({ ...message, token }, '*')
  }

  useEffect(() => {
    onScriptError(undefined)
    const onMessage = (event: MessageEvent): void => {
      const frame = frameRef.current
      if (frame === null || event.source !== frame.contentWindow) return
      const message = event.data as (FrameMessage & { token?: string }) | null
      if (message === null || typeof message !== 'object' || message.token !== token) return
      switch (message.kind) {
        case 'ready':
          readyRef.current = true
          post({ kind: 'theme', css: latest.current.theme.css, mode: latest.current.theme.mode })
          post({ kind: 'data', data: latest.current.data, histories: latest.current.histories() })
          post({ kind: 'height', auto: latest.current.height === undefined && view.definition.height === 'auto' })
          break
        case 'resize':
          if (typeof message.height === 'number' && Number.isFinite(message.height)) {
            setAutoHeight(Math.min(MAX_AUTO_HEIGHT, Math.max(MIN_AUTO_HEIGHT, Math.ceil(message.height))))
          }
          break
        case 'refresh':
          latest.current.onRefresh()
          break
        case 'open':
          if (typeof message.url === 'string' && /^https?:\/\//i.test(message.url)) {
            window.open(message.url, '_blank', 'noopener,noreferrer')
          }
          break
        case 'ask':
          if (typeof message.text === 'string' && message.text.trim() !== '') latest.current.onAsk(message.text.slice(0, 4000))
          break
        case 'run':
          if (typeof message.id === 'string' && typeof message.prompt === 'string' && message.prompt.trim() !== '') {
            const id = message.id
            const prompt = message.prompt.slice(0, 24_000)
            const system = typeof message.system === 'string' ? message.system.slice(0, 8_000) : undefined
            void latest.current.onRun(prompt, system)
              .then(result => post({ kind: 'run-result', id, ...result }))
              .catch((error: unknown) => post({
                kind: 'run-result',
                id,
                ok: false,
                error: error instanceof Error ? error.message : String(error),
              }))
          }
          break
        case 'state':
          if (typeof message.key === 'string') writeState(view.id, message.key, message.value)
          break
        case 'error':
          if (typeof message.message === 'string') latest.current.onScriptError(message.message)
          break
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, view.id])

  useEffect(() => {
    if (readyRef.current) post({ kind: 'data', data: view.data, histories: histories() })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view.data])

  useEffect(() => {
    if (readyRef.current) post({ kind: 'theme', css: theme.css, mode: theme.mode })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theme.css])

  useEffect(() => {
    if (readyRef.current) post({ kind: 'height', auto: height === undefined && fixedHeight === undefined })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [height, fixedHeight])

  const startResize = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return
    event.preventDefault()
    const startY = event.clientY
    const startHeight = frameRef.current?.getBoundingClientRect().height ?? renderedHeight
    const target = event.currentTarget
    target.setPointerCapture(event.pointerId)
    const heightAt = (y: number): number => clampPanelHeight(startHeight + (y - startY))
    const move = (e: PointerEvent): void => setDragHeight(heightAt(e.clientY))
    const up = (e: PointerEvent): void => {
      target.removeEventListener('pointermove', move)
      target.removeEventListener('pointerup', up)
      target.removeEventListener('pointercancel', up)
      setDragHeight(undefined)
      onHeightChange?.(heightAt(e.clientY))
    }
    target.addEventListener('pointermove', move)
    target.addEventListener('pointerup', up)
    target.addEventListener('pointercancel', up)
  }

  return (
    <div className="dshpad-frame-wrap">
      <iframe
        ref={frameRef}
        className={`dshpad-frame${resizing ? ' is-resizing' : ''}`}
        title={view.definition.title}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        srcDoc={doc}
        style={{ height: renderedHeight, colorScheme: theme.mode }}
      />
      {resizable
        ? (
          <div
            className="dshpad-frame-handle"
            role="separator"
            aria-orientation="horizontal"
            aria-label={resizeLabel}
            title={resizeLabel}
            onPointerDown={startResize}
            onDoubleClick={() => onHeightChange?.(undefined)}
          />
          )
        : null}
    </div>
  )
}
