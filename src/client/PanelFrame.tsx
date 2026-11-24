/**
 * A panel's runtime: its HTML, CSS and script inside a sandboxed iframe.
 *
 * The frame gets `sandbox="allow-scripts"` without `allow-same-origin` (an
 * opaque origin: no cookies, no storage, no access to the dock's DOM) and a
 * CSP of `default-src 'none'` (no network). Its only way out is postMessage
 * to this component, which accepts a fixed set of requests from exactly this
 * frame carrying this frame's token.
 */
import { type PointerEvent as ReactPointerEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { PanelRunResult, PanelView } from '../shared/types.ts'
import { classifyFrameLoad, shouldRecoverFrame } from './frame-lifecycle.ts'
import { HistorySync } from './history-sync.ts'
import { clampPanelHeight, type HistoryPoint } from './pad-client.ts'
import { frameDocument } from './panel-document.ts'
import { encodePanelState, isSafeStateKey, parsePanelState, STATE_PREFIX } from './panel-state.ts'
import type { ThemeSnapshot } from './theme.ts'
import { PointerGestures } from './gesture.ts'

export const MIN_AUTO_HEIGHT = 32
export const MAX_AUTO_HEIGHT = 640
export const REFRESH_THROTTLE_MS = 1000
export const ACTION_THROTTLE_MS = 500

function readState(panelId: string): Record<string, unknown> {
  try {
    return parsePanelState(localStorage.getItem(STATE_PREFIX + panelId))
  } catch {
    return {}
  }
}

function writeState(panelId: string, key: string, value: unknown): void {
  if (!isSafeStateKey(key)) return
  const state = { ...readState(panelId), [key]: value }
  const text = encodePanelState(state)
  if (text === undefined) return
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

export interface PanelFrameProps {
  readonly view: PanelView
  readonly histories: () => Record<string, readonly HistoryPoint[]>
  readonly theme: ThemeSnapshot
  readonly lang: string
  readonly onRefresh: () => void
  readonly onAsk: (text: string) => void
  /** One model call requested by the panel's own code via `dsh.run`. */
  readonly onRun: (prompt: string, system?: string, signal?: AbortSignal) => Promise<PanelRunResult>
  readonly onScriptError: (message: string | undefined) => void
  /** Called when Escape is pressed inside the sandboxed frame. */
  readonly onEscape?: () => void
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
  | { kind: 'escape' }
  | { kind: 'run', id: string, prompt: string, system?: string }
  | { kind: 'state', key: string, value: unknown }
  | { kind: 'ok' }
  | { kind: 'error', message: string }

export function PanelFrame({ view, histories, theme, lang, onRefresh, onAsk, onRun, onScriptError, onEscape, height, onHeightChange, resizeLabel, resizable = true }: PanelFrameProps) {
  const frameRef = useRef<HTMLIFrameElement>(null)
  const readyRef = useRef(false)
  const loadsRef = useRef(0)
  const recoveredRef = useRef(false)
  const recoveriesRef = useRef(0)
  const stoppedRef = useRef(false)
  const [stopped, setStopped] = useState(false)
  const tokenRef = useRef('')
  const abortControllersRef = useRef<Set<AbortController>>(new Set())
  const lastRefreshRef = useRef(-Infinity)
  const lastAskRef = useRef(-Infinity)
  const lastOpenRef = useRef(-Infinity)
  const [epoch, setEpoch] = useState(0)
  const latest = useRef({ data: view.data, theme, onRefresh, onAsk, onRun, onScriptError, onEscape, histories, height })
  const [dragHeight, setDragHeight] = useState<number>()
  const gestures = useRef(new PointerGestures()).current
  useLayoutEffect(() => {
    if (!resizable || stopped) gestures.cancel()
    return () => gestures.cancel()
  }, [gestures, resizable, stopped, view.id, view.version])
  const fixedHeight = view.definition.height === 'auto' ? undefined : view.definition.height
  latest.current = { data: view.data, theme, onRefresh, onAsk, onRun, onScriptError, onEscape, histories, height }
  const [autoHeight, setAutoHeight] = useState(MIN_AUTO_HEIGHT * 2)
  const renderedHeight = dragHeight ?? height ?? fixedHeight ?? autoHeight
  const resizing = dragHeight !== undefined
  const stoppedMessage = lang.startsWith('zh')
    ? '面板页面被脚本导航离开了沙箱文档，已停止自动恢复；修改面板定义后会重新加载。'
    : 'The panel navigated away from its sandbox document; automatic recovery stopped. Editing the panel reloads it.'

  const abortPendingRuns = (): void => {
    for (const controller of abortControllersRef.current) controller.abort()
    abortControllersRef.current.clear()
  }

  // A new document (and token) per definition version; data and theme updates are messages.
  const { token, doc, initialData, historySync } = useMemo(() => {
    const token = randomToken()
    const { data, theme: currentTheme, histories: readHistories } = latest.current
    const histories = readHistories()
    const historySync = new HistorySync()
    historySync.reset(histories)
    return { token, initialData: data, historySync, doc: frameDocument({ view, token, theme: currentTheme, data, histories, state: readState(view.id), lang, viewHeight: latest.current.height }) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view.id, view.version, lang, epoch])

  useLayoutEffect(() => {
    readyRef.current = false
    loadsRef.current = 0
    recoveredRef.current = false
    tokenRef.current = token
    return () => {
      readyRef.current = false
      abortPendingRuns()
    }
  }, [token, epoch])

  // The recovery budget belongs to the definition: an edit is a fresh start,
  // a recovery of the same definition is not.
  useLayoutEffect(() => {
    recoveriesRef.current = 0
    stoppedRef.current = false
    setStopped(false)
  }, [view.id, view.version, lang])

  const post = (message: Record<string, unknown>): void => {
    if (recoveredRef.current || stoppedRef.current || tokenRef.current !== token) return
    frameRef.current?.contentWindow?.postMessage({ ...message, token }, '*')
  }

  useEffect(() => {
    latest.current.onScriptError(undefined)
  }, [token, view.id])

  useEffect(() => {
    if (stopped) return
    const onMessage = (event: MessageEvent): void => {
      if (recoveredRef.current || stoppedRef.current) return
      const frame = frameRef.current
      if (frame === null || event.source !== frame.contentWindow) return
      const message = event.data as (FrameMessage & { token?: string }) | null
      if (message === null || typeof message !== 'object' || message.token !== token) return
      switch (message.kind) {
        case 'ready':
          readyRef.current = true
          post({ kind: 'theme', css: latest.current.theme.css, mode: latest.current.theme.mode })
          // The initial data is embedded in srcDoc. Only send a catch-up when
          // readings changed while the frame was loading; avoid rendering twice.
          if (latest.current.data !== initialData) {
            post({ kind: 'data', data: latest.current.data, historyDelta: historySync.delta(latest.current.histories()) })
          }
          post({ kind: 'height', auto: latest.current.height === undefined && view.definition.height === 'auto' })
          break
        case 'resize':
          if (typeof message.height === 'number' && Number.isFinite(message.height)) {
            setAutoHeight(Math.min(MAX_AUTO_HEIGHT, Math.max(MIN_AUTO_HEIGHT, Math.ceil(message.height))))
          }
          break
        case 'refresh': {
          const now = Date.now()
          if (now - lastRefreshRef.current < REFRESH_THROTTLE_MS) break
          lastRefreshRef.current = now
          latest.current.onRefresh()
          break
        }
        case 'open':
          if (typeof message.url === 'string' && /^https?:\/\//i.test(message.url)) {
            const now = Date.now()
            if (now - lastOpenRef.current < ACTION_THROTTLE_MS) break
            lastOpenRef.current = now
            window.open(message.url, '_blank', 'noopener,noreferrer')
          }
          break
        case 'ask':
          if (typeof message.text === 'string' && message.text.trim() !== '') {
            const now = Date.now()
            if (now - lastAskRef.current < ACTION_THROTTLE_MS) break
            lastAskRef.current = now
            latest.current.onAsk(message.text.slice(0, 4000))
          }
          break
        case 'escape':
          latest.current.onEscape?.()
          break
        case 'run':
          if (typeof message.id === 'string' && typeof message.prompt === 'string' && message.prompt.trim() !== '') {
            const id = message.id
            const prompt = message.prompt
            const system = typeof message.system === 'string' ? message.system : undefined
            if (prompt.length > 24_000 || (system?.length ?? 0) > 8_000) {
              post({ kind: 'run-result', id, ok: false, error: 'Prompt must be at most 24000 characters and system text at most 8000 characters.' })
              break
            }
            const activeToken = token
            const controller = new AbortController()
            abortControllersRef.current.add(controller)
            void latest.current.onRun(prompt, system, controller.signal)
              .then(result => {
                abortControllersRef.current.delete(controller)
                if (controller.signal.aborted || !readyRef.current || recoveredRef.current || stoppedRef.current || tokenRef.current !== activeToken) return
                post({ kind: 'run-result', id, ...result })
              })
              .catch((error: unknown) => {
                abortControllersRef.current.delete(controller)
                if (controller.signal.aborted || !readyRef.current || recoveredRef.current || stoppedRef.current || tokenRef.current !== activeToken) return
                post({
                  kind: 'run-result',
                  id,
                  ok: false,
                  error: error instanceof Error ? error.message : String(error),
                })
              })
          }
          break
        case 'state':
          if (typeof message.key === 'string' && isSafeStateKey(message.key)) {
            writeState(view.id, message.key, message.value)
          }
          break
        case 'ok':
          // The panel just rendered a fresh data set without throwing; a stale
          // error from an earlier render must not stay on the card.
          latest.current.onScriptError(undefined)
          break
        case 'error':
          if (typeof message.message === 'string') latest.current.onScriptError(message.message)
          break
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, view.id, stopped])

  useEffect(() => {
    if (readyRef.current && !stopped) post({ kind: 'data', data: view.data, historyDelta: historySync.delta(histories()) })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view.data])

  useEffect(() => {
    if (readyRef.current && !stopped) post({ kind: 'theme', css: theme.css, mode: theme.mode })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theme.css])

  useEffect(() => {
    if (readyRef.current && !stopped) post({ kind: 'height', auto: height === undefined && fixedHeight === undefined })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [height, fixedHeight])

  // Sandbox + CSP cannot block subframe navigation; drop trust and remount with a fresh token.
  const handleLoad = (): void => {
    const loadsSoFar = loadsRef.current
    loadsRef.current = loadsSoFar + 1
    if (classifyFrameLoad(loadsSoFar) !== 'navigated') return
    // Stop talking to this window before deciding anything else: any message we
    // post from here on would hand the foreign page that replaced the panel the
    // token and the readings the panel is allowed to see.
    readyRef.current = false
    abortPendingRuns()
    if (recoveredRef.current) return
    if (!shouldRecoverFrame(recoveriesRef.current)) {
      if (!stoppedRef.current) {
        stoppedRef.current = true
        setStopped(true)
        latest.current.onScriptError(stoppedMessage)
      }
      return
    }
    recoveredRef.current = true
    recoveriesRef.current += 1
    setEpoch(current => current + 1)
  }

  const startResize = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return
    event.preventDefault()
    const startY = event.clientY
    const startHeight = frameRef.current?.getBoundingClientRect().height ?? renderedHeight
    const heightAt = (y: number): number => clampPanelHeight(startHeight + (y - startY))
    gestures.start(event, {
      move: pointer => setDragHeight(heightAt(pointer.clientY)),
      end: pointer => {
        setDragHeight(undefined)
        onHeightChange?.(heightAt(pointer.clientY))
      },
      cancel: () => setDragHeight(undefined),
    })
  }

  return (
    <div className="dshpad-frame-wrap">
      {stopped
        ? <div className="dshpad-frame-stopped" role="alert">{stoppedMessage}</div>
        : (
          <iframe
            key={`${view.id}:${view.version}:${lang}:${epoch}`}
            ref={frameRef}
            className={`dshpad-frame${resizing ? ' is-resizing' : ''}`}
            title={view.definition.title}
            sandbox="allow-scripts"
            referrerPolicy="no-referrer"
            srcDoc={doc}
            onLoad={handleLoad}
            // The element's own colour scheme keeps the frame's canvas opaque. A
            // fully transparent iframe inside the dock's composited layer can come
            // up completely blank in Electron, even though its document laid out.
            style={{ height: renderedHeight, colorScheme: theme.mode }}
          />
          )}
      {resizable && !stopped
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
