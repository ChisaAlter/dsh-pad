/**
 * The floating dock on the right edge: a draggable capsule when collapsed,
 * a resizable column of panel cards when expanded.
 */
import { Fragment, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { composer } from './composer.ts'
import type { PadKey } from './locales.ts'
import { MAX_CAPSULE_Y, MAX_WIDTH, MIN_CAPSULE_Y, MIN_DOCK_HEIGHT, MIN_WIDTH, type PadClient, type PanelRowLayout } from './pad-client.ts'
import type { HistoryPoint } from './pad-client.ts'
import type { PanelView } from '../shared/types.ts'
import { PanelCard, type Translate, needsAttention } from './PanelCard.tsx'
import { PanelFrame } from './PanelFrame.tsx'
import { type ThemeSnapshot, readTheme, watchTheme } from './theme.ts'

const DRAG_THRESHOLD = 4
/** The expanded dock keeps this much of the window below it, and this much above. */
const MIN_DOCK_TOP = 52
const DOCK_BOTTOM_ROOM = 240
/** Gap kept between the dock and the window's bottom edge. */
const EDGE_GAP = 6
/** Compact dock header; its centre lines up with the capsule centre. */
const HEADER_H = 32
const HEADER_HALF = HEADER_H / 2

/**
 * Vertical band the expanded dock may occupy. It is tied to the capsule band,
 * since the capsule is where the dock collapses back to.
 * @param viewportH - current window height.
 * @returns the lowest and highest allowed `top` in px.
 */
function dockLimits(viewportH: number): { min: number, max: number } {
  const min = Math.max(MIN_DOCK_TOP, Math.ceil(MIN_CAPSULE_Y * viewportH) - HEADER_HALF)
  const max = Math.max(min, Math.min(viewportH - DOCK_BOTTOM_ROOM, Math.floor(MAX_CAPSULE_Y * viewportH) - HEADER_HALF))
  return { min, max }
}

const Icon = {
  grid: <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="2" width="5" height="5" rx="1.2" /><rect x="9" y="2" width="5" height="5" rx="1.2" /><rect x="2" y="9" width="5" height="5" rx="1.2" /><rect x="9" y="9" width="5" height="5" rx="1.2" /></svg>,
  plus: <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3v10M3 8h10" /></svg>,
  refresh: <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5v3h-3" /></svg>,
  collapse: <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3.5L10.5 8 6 12.5" /></svg>,
  expand: <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10 3.5L5.5 8 10 12.5" /></svg>,
}

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(timer)
  }, [intervalMs])
  return now
}

/** Keep every panel in exactly one row of at most three, appending new panels. */
function sanitizeRows(raw: readonly PanelRowLayout[] | undefined, panels: readonly PanelView[]): PanelRowLayout[] {
  const known = new Set(panels.map(panel => panel.id))
  const seen = new Set<string>()
  const rows: PanelRowLayout[] = []
  const pushRow = (ids: string[], weights: number[]): void => {
    for (let start = 0; start < ids.length; start += 3) {
      const sliceIds = ids.slice(start, start + 3)
      if (sliceIds.length > 0) rows.push({ ids: sliceIds, weights: weights.slice(start, start + 3) })
    }
  }
  for (const row of raw ?? []) {
    const ids: string[] = []
    const weights: number[] = []
    row.ids.forEach((id, index) => {
      if (!known.has(id) || seen.has(id)) return
      seen.add(id)
      ids.push(id)
      const weight = row.weights[index]
      weights.push(typeof weight === 'number' && Number.isFinite(weight) && weight > 0 ? weight : 1)
    })
    pushRow(ids, weights)
  }
  for (const panel of panels) {
    if (seen.has(panel.id)) continue
    seen.add(panel.id)
    rows.push({ ids: [panel.id], weights: [1] })
  }
  return rows
}

function rowTemplate(row: PanelRowLayout): string {
  const parts: string[] = []
  row.ids.forEach((_, index) => {
    if (index > 0) parts.push('6px')
    parts.push(`${row.weights[index] ?? 1}fr`)
  })
  return parts.join(' ')
}

export interface DockProps {
  readonly t: Translate
}

/**
 * Build the dock component over one client instance (kept in the plugin's
 * apply closure; components never receive ctx).
 * @param client - the browser-side panel state.
 * @returns the shell.overlay component.
 */
export function createDock(client: PadClient) {
  return function Dock({ t }: DockProps) {
    const snap = useSyncExternalStore(client.subscribe, client.getSnapshot)
    const rootRef = useRef<HTMLDivElement>(null)
    const asideRef = useRef<HTMLElement>(null)
    const [theme, setTheme] = useState<ThemeSnapshot>({ mode: 'light', css: ':root{}' })
    const [notice, setNotice] = useState<string>()
    const [dragY, setDragY] = useState<number>()
    const [dragTop, setDragTop] = useState<number>()
    const [dragWidth, setDragWidth] = useState<number>()
    /** Height cap frozen while the dock stays expanded, so moving it never resizes it. */
    const [dockCap, setDockCap] = useState<number>()
    /** Height chosen with the top/bottom edge handles; `undefined` means auto. */
    const [dockHeight, setDockHeight] = useState<number>()
    const [viewportH, setViewportH] = useState(() => window.innerHeight)
    const [drag, setDrag] = useState<{ id: string, x: number, y: number, target?: string }>()
    const snapshotRows = sanitizeRows(snap.layout.rows, snap.panels)
    const rowsSignature = JSON.stringify(snapshotRows)
    const [rows, setRows] = useState<PanelRowLayout[]>(snapshotRows)
    const [focusedId, setFocusedId] = useState<string>()
    const [closing, setClosing] = useState(false)
    const closeTimer = useRef<ReturnType<typeof setTimeout>>()
    const focusedView = focusedId === undefined ? undefined : snap.panels.find(panel => panel.id === focusedId)
    const now = useNow(10_000)
    const lang = t('dock.title') === '面板' ? 'zh-CN' : 'en'

    useEffect(() => {
      const onResize = (): void => setViewportH(window.innerHeight)
      window.addEventListener('resize', onResize)
      return () => window.removeEventListener('resize', onResize)
    }, [])

    useEffect(() => {
      setRows(sanitizeRows(snap.layout.rows, snap.panels))
      // The signature changes only when rows or panels really change, not on
      // every SSE data tick.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [rowsSignature])

    useEffect(() => () => {
      if (closeTimer.current !== undefined) clearTimeout(closeTimer.current)
    }, [])

    // Freeze the height cap when the dock opens: the dock keeps that height
    // while it is dragged, so the gesture translates the box instead of
    // squeezing it against the bottom of the window.
    useEffect(() => {
      if (!snap.layout.expanded) {
        setDockCap(undefined)
        setDockHeight(undefined)
        return
      }
      const { min, max } = dockLimits(viewportH)
      const opening = Math.min(max, Math.max(min, Math.round(snap.layout.capsuleY * viewportH) - HEADER_HALF))
      setDockCap(Math.max(200, viewportH - opening - EDGE_GAP))
      const saved = snap.layout.dockHeight
      setDockHeight(saved === undefined ? undefined : Math.min(saved, Math.max(MIN_DOCK_HEIGHT, viewportH - opening - EDGE_GAP)))
      // capsuleY changes on drop; the cap must stay put for that drag.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [snap.layout.expanded, viewportH])

    useEffect(() => {
      if (focusedId === undefined) return
      const onKey = (event: KeyboardEvent): void => {
        if (event.key === 'Escape') setFocusedId(undefined)
      }
      document.addEventListener('keydown', onKey)
      return () => document.removeEventListener('keydown', onKey)
    }, [focusedId])

    useEffect(() => {
      // The panel was deleted (or the list reloaded) while zoomed.
      if (focusedId !== undefined && focusedView === undefined) setFocusedId(undefined)
    }, [focusedId, focusedView])

    useEffect(() => {
      const update = (): void => {
        if (rootRef.current === null) return
        const next = readTheme(rootRef.current)
        setTheme(prev => (prev.css === next.css ? prev : next))
      }
      update()
      return watchTheme(update)
    }, [snap.layout.expanded])

    // Reserve the dock's column on wide windows (see styles.ts).
    const reserve = snap.layout.expanded ? (dragWidth ?? snap.layout.width) + 12 : 0
    useEffect(() => {
      const root = document.documentElement
      root.classList.toggle('dshpad-reserve', reserve > 0)
      root.style.setProperty('--dshpad-reserve', `${reserve}px`)
    }, [reserve])
    useEffect(() => () => {
      document.documentElement.classList.remove('dshpad-reserve')
      document.documentElement.style.removeProperty('--dshpad-reserve')
    }, [])

    useEffect(() => {
      if (notice === undefined) return
      const timer = setTimeout(() => setNotice(undefined), 4000)
      return () => clearTimeout(timer)
    }, [notice])

    const ask = (text: string, submit: boolean, insert = false): boolean => {
      const result = insert ? composer.insert(text) : composer.fill(text, submit)
      if (result === 'unavailable') {
        void navigator.clipboard?.writeText(text).catch(() => {})
        setNotice(t('new.unavailable'))
        return false
      }
      if (result === 'filled' && submit) setNotice(t('new.filled'))
      return true
    }

    const attention = snap.panels.some(needsAttention)

    const tile = (sourceId: string, targetId: string): void => {
      if (sourceId === targetId) return
      const next = rows.map(row => ({ ids: [...row.ids], weights: [...row.weights] }))
      const sourceIndex = next.findIndex(row => row.ids.includes(sourceId))
      if (sourceIndex < 0) return
      const sourcePosition = next[sourceIndex]!.ids.indexOf(sourceId)
      next[sourceIndex]!.ids.splice(sourcePosition, 1)
      next[sourceIndex]!.weights.splice(sourcePosition, 1)
      if (next[sourceIndex]!.ids.length === 0) next.splice(sourceIndex, 1)
      const targetRow = next.find(row => row.ids.includes(targetId))
      if (targetRow === undefined) return
      if (targetRow.ids.length >= 3) {
        next.splice(next.indexOf(targetRow) + 1, 0, { ids: [sourceId], weights: [1] })
      } else {
        targetRow.ids.push(sourceId)
        targetRow.weights.push(1)
      }
      const updated = sanitizeRows(next, snap.panels)
      setRows(updated)
      client.setRows(updated)
    }

    const detach = (sourceId: string): void => {
      const next = rows.map(row => ({ ids: [...row.ids], weights: [...row.weights] }))
      const sourceIndex = next.findIndex(row => row.ids.includes(sourceId))
      if (sourceIndex < 0) return
      const sourceRow = next[sourceIndex]!
      if (sourceRow.ids.length <= 1) return
      const sourcePosition = sourceRow.ids.indexOf(sourceId)
      sourceRow.ids.splice(sourcePosition, 1)
      sourceRow.weights.splice(sourcePosition, 1)
      next.splice(Math.min(next.length, sourceIndex + 1), 0, { ids: [sourceId], weights: [1] })
      const updated = sanitizeRows(next, snap.panels)
      setRows(updated)
      client.setRows(updated)
    }

    const startCardDrag = (sourceId: string, event: ReactPointerEvent<HTMLElement>): void => {
      if (event.button !== 0) return
      const cardAt = (x: number, y: number): string | undefined => {
        const node = document.elementFromPoint(x, y)
        const card = node instanceof Element ? node.closest('[data-panel-id]') : null
        return card?.getAttribute('data-panel-id') ?? undefined
      }
      const startX = event.clientX
      const startY = event.clientY
      const pointerId = event.pointerId
      const capture = event.currentTarget
      let moved = false
      const move = (pointer: PointerEvent): void => {
        if (!moved && Math.hypot(pointer.clientX - startX, pointer.clientY - startY) <= 4) return
        if (!moved) {
          // Keep receiving pointer events when the cursor crosses a panel iframe.
          try {
            capture.setPointerCapture(pointerId)
          } catch {
            // A synthetic or already-released pointer cannot be captured.
          }
          pointer.preventDefault()
        }
        moved = true
        const under = cardAt(pointer.clientX, pointer.clientY)
        setDrag({ id: sourceId, x: pointer.clientX, y: pointer.clientY, target: under !== sourceId ? under : undefined })
      }
      const suppressClick = (click: MouseEvent): void => {
        click.preventDefault()
        click.stopPropagation()
        click.stopImmediatePropagation()
      }
      const finish = (pointer: PointerEvent): void => {
        const under = cardAt(pointer.clientX, pointer.clientY)
        cleanup()
        setDrag(undefined)
        if (!moved) return
        // A dragged pointer must not also collapse the card on the ensuing click.
        document.addEventListener('click', suppressClick, { capture: true, once: true })
        setTimeout(() => document.removeEventListener('click', suppressClick, true), 160)
        if (under !== undefined && under !== sourceId) {
          tile(sourceId, under)
        } else if (under !== sourceId) {
          detach(sourceId)
        }
      }
      const cancel = (): void => {
        cleanup()
        setDrag(undefined)
      }
      const cleanup = (): void => {
        document.removeEventListener('pointermove', move)
        document.removeEventListener('pointerup', finish)
        document.removeEventListener('pointercancel', cancel)
      }
      document.addEventListener('pointermove', move)
      document.addEventListener('pointerup', finish)
      document.addEventListener('pointercancel', cancel)
    }

    const startSplit = (rowIndex: number, boundary: number, event: ReactPointerEvent<HTMLDivElement>): void => {
      if (event.button !== 0) return
      event.preventDefault()
      event.stopPropagation()
      const rowElement = event.currentTarget.parentElement
      const row = rows[rowIndex]
      if (rowElement === null || row === undefined || boundary + 1 >= row.ids.length) return
      const rect = rowElement.getBoundingClientRect()
      const splitterWidth = 6 * (row.ids.length - 1)
      const cardArea = Math.max(1, rect.width - splitterWidth)
      const totalWeight = row.weights.reduce((sum, weight) => sum + weight, 0)
      const pairWeight = (row.weights[boundary] ?? 1) + (row.weights[boundary + 1] ?? 1)
      const startWidth = ((row.weights[boundary] ?? 1) / totalWeight) * cardArea
      const pairWidth = (pairWeight / totalWeight) * cardArea
      const startX = event.clientX
      const target = event.currentTarget
      target.setPointerCapture(event.pointerId)
      let final = rows
      const move = (pointer: PointerEvent): void => {
        const width = Math.max(80, Math.min(Math.max(80, pairWidth - 80), startWidth + pointer.clientX - startX))
        const weight = totalWeight * width / cardArea
        const rightWeight = pairWeight - weight
        final = rows.map((current, index) => index === rowIndex
          ? { ids: [...current.ids], weights: current.weights.map((value, position) => position === boundary ? weight : position === boundary + 1 ? rightWeight : value) }
          : current)
        setRows(final)
      }
      const up = (): void => {
        target.removeEventListener('pointermove', move)
        target.removeEventListener('pointerup', up)
        target.removeEventListener('pointercancel', up)
        client.setRows(final)
      }
      target.addEventListener('pointermove', move)
      target.addEventListener('pointerup', up)
      target.addEventListener('pointercancel', up)
    }

    // Let the dock play its exit before the capsule takes its place.
    const collapse = (): void => {
      if (closing) return
      setClosing(true)
      closeTimer.current = setTimeout(() => {
        setClosing(false)
        client.setLayout({ expanded: false })
      }, 180)
    }

    // Capsule: a pointer gesture that moves less than the threshold is a click.
    const onCapsulePointerDown = (event: ReactPointerEvent<HTMLButtonElement>): void => {
      if (event.button !== 0) return
      const startY = event.clientY
      const startFraction = snap.layout.capsuleY
      let moved = false
      const target = event.currentTarget
      target.setPointerCapture(event.pointerId)
      const move = (e: PointerEvent): void => {
        if (!moved && Math.abs(e.clientY - startY) < DRAG_THRESHOLD) return
        moved = true
        setDragY(Math.min(MAX_CAPSULE_Y, Math.max(MIN_CAPSULE_Y, startFraction + (e.clientY - startY) / window.innerHeight)))
      }
      const up = (e: PointerEvent): void => {
        target.removeEventListener('pointermove', move)
        target.removeEventListener('pointerup', up)
        target.removeEventListener('pointercancel', up)
        if (moved) {
          const y = Math.min(MAX_CAPSULE_Y, Math.max(MIN_CAPSULE_Y, startFraction + (e.clientY - startY) / window.innerHeight))
          setDragY(undefined)
          client.setLayout({ capsuleY: y })
        } else if (e.type === 'pointerup') {
          client.setLayout({ expanded: true })
        }
      }
      target.addEventListener('pointermove', move)
      target.addEventListener('pointerup', up)
      target.addEventListener('pointercancel', up)
    }

    const onCapsuleKey = (event: ReactKeyboardEvent<HTMLButtonElement>): void => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        client.setLayout({ expanded: true })
      }
    }

    // Header drag: move the whole dock up and down. The saved capsuleY is the
    // single anchor, so the capsule reappears at the height the dock was left.
    const onHeadPointerDown = (event: ReactPointerEvent<HTMLElement>): void => {
      if (event.button !== 0) return
      if ((event.target as HTMLElement).closest('button') !== null) return
      const startY = event.clientY
      const startTop = dragTop ?? dockTop
      const target = event.currentTarget
      const { min } = dockLimits(viewportH)
      // The dock's current height is locked by `dockCap`; keep its bottom in
      // view instead of letting the height collapse against the window floor.
      const boxHeight = asideRef.current?.getBoundingClientRect().height ?? viewportH - startTop - EDGE_GAP
      const maxTop = Math.max(min, viewportH - boxHeight - EDGE_GAP)
      let moved = false
      const topAt = (y: number): number => Math.max(min, Math.min(startTop + (y - startY), maxTop))
      target.setPointerCapture(event.pointerId)
      const move = (e: PointerEvent): void => {
        if (!moved && Math.abs(e.clientY - startY) < DRAG_THRESHOLD) return
        moved = true
        setDragTop(topAt(e.clientY))
      }
      const up = (e: PointerEvent): void => {
        target.removeEventListener('pointermove', move)
        target.removeEventListener('pointerup', up)
        target.removeEventListener('pointercancel', up)
        if (!moved) return
        const nextTop = topAt(e.clientY)
        setDragTop(undefined)
        client.setLayout({ capsuleY: Math.min(MAX_CAPSULE_Y, Math.max(MIN_CAPSULE_Y, (nextTop + HEADER_HALF) / viewportH)) })
      }
      target.addEventListener('pointermove', move)
      target.addEventListener('pointerup', up)
      target.addEventListener('pointercancel', up)
    }

    // Top edge: change the height from above, keeping the bottom edge in place.
    const onTopEdgePointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
      if (event.button !== 0) return
      event.preventDefault()
      const startY = event.clientY
      const startTop = dragTop ?? dockTop
      const startHeight = dockHeight ?? asideRef.current?.getBoundingClientRect().height ?? Math.max(MIN_DOCK_HEIGHT, viewportH - startTop - EDGE_GAP)
      const bottom = Math.min(startTop + startHeight, viewportH - EDGE_GAP)
      const { min } = dockLimits(viewportH)
      const topAt = (y: number): number => Math.max(min, Math.min(startTop + (y - startY), bottom - MIN_DOCK_HEIGHT))
      const target = event.currentTarget
      target.setPointerCapture(event.pointerId)
      const move = (e: PointerEvent): void => {
        const nextTop = topAt(e.clientY)
        setDragTop(nextTop)
        setDockHeight(bottom - nextTop)
      }
      const up = (e: PointerEvent): void => {
        target.removeEventListener('pointermove', move)
        target.removeEventListener('pointerup', up)
        target.removeEventListener('pointercancel', up)
        const nextTop = topAt(e.clientY)
        const nextHeight = bottom - nextTop
        setDragTop(undefined)
        setDockHeight(nextHeight)
        client.setDockHeight(nextHeight)
        client.setLayout({ capsuleY: Math.min(MAX_CAPSULE_Y, Math.max(MIN_CAPSULE_Y, (nextTop + HEADER_HALF) / viewportH)) })
      }
      target.addEventListener('pointermove', move)
      target.addEventListener('pointerup', up)
      target.addEventListener('pointercancel', up)
    }

    // Bottom edge: grow or shrink the dock downwards from a fixed top.
    const onBottomEdgePointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
      if (event.button !== 0) return
      event.preventDefault()
      const startY = event.clientY
      const top = dragTop ?? dockTop
      const startHeight = dockHeight ?? asideRef.current?.getBoundingClientRect().height ?? Math.max(MIN_DOCK_HEIGHT, viewportH - top - EDGE_GAP)
      const maxHeight = Math.max(MIN_DOCK_HEIGHT, viewportH - top - EDGE_GAP)
      const heightAt = (y: number): number => Math.max(MIN_DOCK_HEIGHT, Math.min(startHeight + (y - startY), maxHeight))
      const target = event.currentTarget
      target.setPointerCapture(event.pointerId)
      setDockHeight(startHeight)
      const move = (e: PointerEvent): void => setDockHeight(heightAt(e.clientY))
      const up = (e: PointerEvent): void => {
        target.removeEventListener('pointermove', move)
        target.removeEventListener('pointerup', up)
        target.removeEventListener('pointercancel', up)
        const nextHeight = heightAt(e.clientY)
        setDockHeight(nextHeight)
        client.setDockHeight(nextHeight)
      }
      target.addEventListener('pointermove', move)
      target.addEventListener('pointerup', up)
      target.addEventListener('pointercancel', up)
    }

    const onResizePointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
      if (event.button !== 0) return
      event.preventDefault()
      const startX = event.clientX
      const startWidth = snap.layout.width
      const target = event.currentTarget
      target.setPointerCapture(event.pointerId)
      const widthAt = (x: number): number => Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startWidth + (startX - x)))
      const move = (e: PointerEvent): void => setDragWidth(widthAt(e.clientX))
      const up = (e: PointerEvent): void => {
        target.removeEventListener('pointermove', move)
        target.removeEventListener('pointerup', up)
        target.removeEventListener('pointercancel', up)
        setDragWidth(undefined)
        client.setLayout({ width: widthAt(e.clientX) })
      }
      target.addEventListener('pointermove', move)
      target.addEventListener('pointerup', up)
      target.addEventListener('pointercancel', up)
    }

    if (!snap.layout.expanded) {
      const y = dragY ?? snap.layout.capsuleY
      return (
        <div className="dshpad-root" ref={rootRef}>
          <button
            type="button"
            className={`dshpad-toggle${dragY !== undefined ? ' is-dragging' : ''}`}
            style={{ top: `${(y * 100).toFixed(2)}%` }}
            title={attention ? t('capsule.attention') : t('dock.open')}
            aria-label={t('dock.open')}
            onPointerDown={onCapsulePointerDown}
            onKeyDown={onCapsuleKey}
          >
            {Icon.expand}
            {attention ? <i className="dshpad-dot" aria-hidden="true" /> : null}
          </button>
        </div>
      )
    }

    const examples: PadKey[] = ['empty.example1', 'empty.example2', 'empty.example3']
    const dragView = drag === undefined ? undefined : snap.panels.find(panel => panel.id === drag.id)
    // Open where the toggle sits: its centre becomes the header's grab area.
    const toggleCenter = Math.round(snap.layout.capsuleY * viewportH)
    const limits = dockLimits(viewportH)
    const dockTop = Math.min(limits.max, Math.max(limits.min, toggleCenter - HEADER_HALF))
    const top = dragTop ?? dockTop
    const available = Math.max(MIN_DOCK_HEIGHT, viewportH - top - EDGE_GAP)
    const renderedHeight = dockHeight === undefined ? undefined : Math.min(dockHeight, available)
    const dockMaxHeight = dockCap ?? Math.max(200, available)
    return (
      <div className="dshpad-root" ref={rootRef}>
        <aside ref={asideRef} className={`dshpad-dock${dragTop !== undefined ? ' is-moving' : ''}${closing ? ' is-closing' : ''}`} style={{ width: dragWidth ?? snap.layout.width, top, height: renderedHeight, maxHeight: renderedHeight ?? dockMaxHeight }} aria-label={t('dock.title')}>
          <div className="dshpad-dock-edge is-top" role="separator" aria-orientation="horizontal" title={t('dock.resizeHeight')} onPointerDown={onTopEdgePointerDown}
            onDoubleClick={() => { setDockHeight(undefined); client.setDockHeight(undefined) }} />
          <div className="dshpad-resize" title={t('dock.resize')} onPointerDown={onResizePointerDown} />
          <header className="dshpad-dock-head" title={t('dock.move')} onPointerDown={onHeadPointerDown}>
            <span className="dshpad-grip" aria-hidden="true" />
            <span className="dshpad-spacer" />
            <button type="button" className="dshpad-icon-btn" title={t('dock.newPanel')} aria-label={t('dock.newPanel')}
              onClick={() => { ask(t('new.prefix'), false, true) }}>{Icon.plus}</button>
            <button type="button" className="dshpad-icon-btn" title={t('dock.refreshAll')} aria-label={t('dock.refreshAll')}
              disabled={snap.panels.length === 0}
              onClick={() => { for (const panel of snap.panels) void client.act({ op: 'refresh', panelId: panel.id }) }}>{Icon.refresh}</button>
            <button type="button" className="dshpad-collapse" title={t('dock.collapse')} aria-label={t('dock.collapse')}
              onClick={collapse}>{Icon.collapse}</button>
          </header>

          {snap.loaded && !snap.connected ? <p className="dshpad-banner">{t('dock.offline')}</p> : null}
          {notice ? <p className="dshpad-banner">{notice}</p> : null}

          <div className="dshpad-list">
            {snap.loaded && snap.panels.length === 0
              ? (
                <div className="dshpad-empty">
                  <p className="dshpad-empty-title">{t('empty.title')}</p>
                  <p>{t('empty.body')}</p>
                  {examples.map(key => (
                    <button type="button" key={key} className="dshpad-example" onClick={() => ask(t(key), false)}>{t(key)}</button>
                  ))}
                </div>
                )
              : (
                <div className="dshpad-rows">
                  {rows.map((row, rowIndex) => (
                    <div className="dshpad-row" key={row.ids.join('|')} style={{ gridTemplateColumns: rowTemplate(row) }}>
                      {row.ids.map((id, index) => {
                        const view = snap.panels.find(panel => panel.id === id)
                        if (view === undefined) return null
                        return (
                          <Fragment key={id}>
                            {index > 0
                              ? <div className="dshpad-splitter" role="separator" aria-orientation="vertical" title={t('dock.split')}
                                  onPointerDown={event => startSplit(rowIndex, index - 1, event)} />
                              : null}
                            <PanelCard
                              view={view}
                              client={client}
                              theme={theme}
                              lang={lang}
                              t={t}
                              now={now}
                              fresh={snap.fresh === view.id}
                              dragging={drag?.id === id}
                              dropTarget={drag?.target === id}
                              onAsk={(text, submit) => { ask(text, submit) }}
                              onExpand={() => setFocusedId(view.id)}
                              onDragStart={event => startCardDrag(id, event)}
                            />
                          </Fragment>
                        )
                      })}
                    </div>
                  ))}
                </div>
                )}
          </div>

          <div className="dshpad-dock-foot" role="separator" aria-orientation="horizontal" title={t('dock.resizeHeight')} onPointerDown={onBottomEdgePointerDown}
            onDoubleClick={() => { setDockHeight(undefined); client.setDockHeight(undefined) }} />
        </aside>

        {drag !== undefined && dragView !== undefined
          ? (
            <div className="dshpad-drag-ghost" style={{ left: drag.x + 12, top: drag.y + 12 }}>
              {dragView.definition.icon ? <span>{dragView.definition.icon}</span> : null}
              <span>{dragView.definition.title}</span>
            </div>
            )
          : null}

        {focusedView
          ? (
            <div className="dshpad-focus" role="dialog" aria-modal="true" aria-label={focusedView.definition.title}
              onClick={event => { if (event.target === event.currentTarget) setFocusedId(undefined) }}>
              <div className="dshpad-focus-panel">
                <header className="dshpad-focus-head">
                  {focusedView.definition.icon ? <span className="dshpad-card-icon">{focusedView.definition.icon}</span> : null}
                  <span className="dshpad-focus-title">{focusedView.definition.title}</span>
                  <button type="button" className="dshpad-icon-btn" aria-label={t('card.close')} title={t('card.close')}
                    onClick={() => setFocusedId(undefined)}>
                    <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg>
                  </button>
                </header>
                <PanelFrame
                  view={focusedView}
                  histories={() => client.historiesOf(focusedView.id) as Record<string, readonly HistoryPoint[]>}
                  theme={theme}
                  lang={lang}
                  onRefresh={() => void client.act({ op: 'refresh', panelId: focusedView.id })}
                  onAsk={text => { ask(text, false) }}
                  onRun={(prompt, system) => client.run(focusedView.id, prompt, system)}
                  onScriptError={() => {}}
                  resizeLabel={t('card.resize')}
                  resizable={false}
                />
              </div>
            </div>
            )
          : null}
      </div>
    )
  }
}
