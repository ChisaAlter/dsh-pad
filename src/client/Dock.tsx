/**
 * The pad's floating layer: a draggable ball when closed, a freely placed
 * window with nested card splits when open.
 *
 * Panels are arranged as a tree (see `layout.ts`). A card dragged onto an edge
 * of another card splits that card's area; a card dropped in the middle swaps
 * places with it; a card dropped on empty dock space moves to the bottom.
 */
import {
  Fragment,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { composer } from './composer.ts'
import { clampBall, nearestBallEdge, positionAtBallEdge, type BallEdge } from './ball-position.ts'
import { attachedDock } from './dock-position.ts'
import { dockSafeTop, readViewport, watchViewport, type Viewport } from './window-controls.ts'
import {
  BALL_SIZE,
  BALL_MARGIN,
  MAX_WIDTH,
  MIN_DOCK_HEIGHT,
  MIN_WIDTH,
  awaitingFirstData,
  type PadClient,
  type Point,
} from './pad-client.ts'
import type { HistoryPoint } from './pad-client.ts'
import {
  type DropZone,
  type LayoutNode,
  type LayoutSplit,
  dropOnLeaf,
  dropZoneFor,
  moveToRoot,
  nodeAtPath,
  normalizeTree,
  totalWeight,
  withWeightsAtPath,
} from './layout.ts'
import type { PadUpdateInfo } from '../shared/types.ts'
import { PanelCard, type Translate, needsAttention } from './PanelCard.tsx'
import type { PadKey } from './locales.ts'
import { PanelFrame } from './PanelFrame.tsx'
import { type ThemeSnapshot, readTheme, watchTheme } from './theme.ts'

const DRAG_THRESHOLD = 4
/** Gap kept between the floating layer and the window edges. */
const EDGE_GAP = 8
const SPLITTER_W = 6
const MIN_PANE = 80
/** The dock's collapse button: its centre is the floating ball's anchor. */
const COLLAPSE_RIGHT = 9
const COLLAPSE_TOP = 2
const COLLAPSE_SIZE = 28
const COLLAPSE_CENTER_FROM_RIGHT = COLLAPSE_RIGHT + COLLAPSE_SIZE / 2
const COLLAPSE_CENTER_Y = COLLAPSE_TOP + COLLAPSE_SIZE / 2

const Icon = {
  plus: <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3v10M3 8h10" /></svg>,
  refresh: <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5v3h-3" /></svg>,
  download: <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.5v7.2M5 7l3 3 3-3M3 13.5h10" /></svg>,
  close: <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg>,
}

const STAR_PATH = 'M14 6.3C14.8 10.8 17.2 13.2 21.7 14C17.2 14.8 14.8 17.2 14 21.7C13.2 17.2 10.8 14.8 6.3 14C10.8 13.2 13.2 10.8 14 6.3Z'
const OPPOSITE_EDGE: Record<BallEdge, BallEdge> = { left: 'right', right: 'left', top: 'bottom', bottom: 'top' }

/** A round free ball or a tab flush against its attached edge. The symbol
 * stays in a separate overlay while the ball and dock cross-fade. */
function BallDisc({ edge }: { readonly edge?: BallEdge | null }) {
  const tab = edge === 'left' || edge === 'right' ? 'M0 0H14A14 14 0 0 1 14 28H0Z' : 'M0 0H28V14A14 14 0 0 1 0 14Z'
  const transform = edge === 'right' || edge === 'bottom' ? 'rotate(180 14 14)' : undefined
  return (
    <svg className="dshpad-ball-disc" viewBox="0 0 28 28" width="28" height="28" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id="dshpad-ball-surface" x1="3" y1="2" x2="25" y2="27" gradientUnits="userSpaceOnUse">
          <stop offset="0" className="dshpad-ball-stop-a" />
          <stop offset="1" className="dshpad-ball-stop-b" />
        </linearGradient>
      </defs>
      {edge == null
        ? <circle className="dshpad-ball-fill" cx="14" cy="14" r="13.5" />
        : <path className="dshpad-ball-fill" d={tab} transform={transform} />}
    </svg>
  )
}

function usePageVisible(): boolean {
  const [visible, setVisible] = useState(() => document.visibilityState !== 'hidden')
  useEffect(() => {
    const update = (): void => setVisible(document.visibilityState !== 'hidden')
    document.addEventListener('visibilitychange', update)
    return () => document.removeEventListener('visibilitychange', update)
  }, [])
  return visible
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

/** Where the window opens when it has not been dragged yet: its collapse
 * button centred on the ball, so the ball and the button are the same spot. */
function defaultDockPoint(ball: Point, width: number, viewport: Viewport, heightHint: number): Point {
  const x = ball.x + BALL_SIZE / 2 - (width - COLLAPSE_CENTER_FROM_RIGHT)
  const y = ball.y + BALL_SIZE / 2 - COLLAPSE_CENTER_Y
  return clampDock({ x, y }, width, viewport, heightHint)
}

function clampDock(point: Point, width: number, viewport: Viewport, heightHint: number, margin = EDGE_GAP): Point {
  const x = Math.round(clamp(point.x, margin, Math.max(margin, viewport.width - width - margin)))
  const top = dockSafeTop(x, width, viewport, margin)
  const height = Math.min(Math.max(BALL_SIZE, heightHint), Math.max(BALL_SIZE, viewport.height - top - margin))
  return { x, y: Math.round(clamp(point.y, top, Math.max(top, viewport.height - height - margin))) }
}

function rowTemplate(split: LayoutSplit): string {
  const parts: string[] = []
  split.children.forEach((_, index) => {
    if (index > 0) parts.push(`${SPLITTER_W}px`)
    parts.push(`${split.weights[index] ?? 1}fr`)
  })
  return parts.join(' ')
}

const DROP_LABEL: Record<DropZone | 'root' | 'hint', PadKey> = {
  left: 'drop.left',
  right: 'drop.right',
  top: 'drop.top',
  bottom: 'drop.bottom',
  center: 'drop.center',
  root: 'drop.root',
  hint: 'drop.hint',
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
    const shieldRef = useRef<HTMLDivElement>(null)
    const [theme, setTheme] = useState<ThemeSnapshot>({ mode: 'light', css: ':root{}' })
    const [notice, setNotice] = useState<string>()
    const [viewport, setViewport] = useState<Viewport>(readViewport)
    const initialBallEdge = useRef(snap.layout.ballEdge === undefined
      ? nearestBallEdge(snap.layout.ball, viewport.width, viewport.height, viewport.controls)
      : snap.layout.ballEdge)
    useEffect(() => {
      if (snap.layout.ballEdge === undefined) client.setLayout({ ballEdge: initialBallEdge.current })
    }, [snap.layout.ballEdge])
    const [ballDrag, setBallDrag] = useState<Point>()
    const [dockDrag, setDockDrag] = useState<Point>()
    const [dragHeight, setDragHeight] = useState<number>()
    const [dragWidth, setDragWidth] = useState<number>()
    const [drag, setDrag] = useState<{ id: string, x: number, y: number, target?: string, zone?: DropZone, blank: boolean }>()
    const [focusedId, setFocusedId] = useState<string>()
    const [closing, setClosing] = useState(false)
    const [ballTransition, setBallTransition] = useState<{ point: Point, mode: 'opening' | 'closing' }>()
    const [update, setUpdate] = useState<PadUpdateInfo>()
    const [updateOpen, setUpdateOpen] = useState(false)
    const [updateBusy, setUpdateBusy] = useState(false)
    const [updateError, setUpdateError] = useState<string>()
    const closeTimer = useRef<ReturnType<typeof setTimeout>>()
    const transitionTimer = useRef<ReturnType<typeof setTimeout>>()
    const holdTimer = useRef<ReturnType<typeof setTimeout>>()
    const suppressCollapseClick = useRef(false)
    const collapsePressToken = useRef(0)
    const panelsById = useMemo(() => new Map(snap.panels.map(panel => [panel.id, panel])), [snap.panels])
    const focusedView = focusedId === undefined ? undefined : panelsById.get(focusedId)
    const pageVisible = usePageVisible()
    const lang = t('dock.title') === '面板' ? 'zh-CN' : 'en'

    const panelIdsKey = useMemo(() => snap.panels.map(panel => panel.id).join('\u0000'), [snap.panels])
    const snapshotTree = useMemo(
      () => normalizeTree(snap.layout.tree, snap.panels.map(panel => panel.id)),
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [snap.layout.tree, panelIdsKey],
    )
    const treeSignature = useMemo(() => JSON.stringify(snapshotTree), [snapshotTree])
    const [tree, setTree] = useState<LayoutNode | null>(snapshotTree)

    useEffect(() => {
      setTree(snapshotTree)
      // The signature changes only when the tree or panel set really changes,
      // not on every SSE data tick.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [treeSignature])

    useEffect(() => watchViewport(() => {
      const next = readViewport()
      setViewport(previous => previous.width === next.width && previous.height === next.height
        && previous.controls?.left === next.controls?.left && previous.controls?.right === next.controls?.right
        && previous.controls?.top === next.controls?.top && previous.controls?.bottom === next.controls?.bottom
        ? previous : next)
    }), [])

    useEffect(() => () => {
      if (closeTimer.current !== undefined) clearTimeout(closeTimer.current)
      if (transitionTimer.current !== undefined) clearTimeout(transitionTimer.current)
      if (holdTimer.current !== undefined) clearTimeout(holdTimer.current)
    }, [])

    // The star button disappears when the dock collapses; never let a pending
    // long-press fire against the now-hidden window.
    useEffect(() => {
      if (snap.layout.expanded) return
      // Invalidate any pointer press that belonged to the hidden star button.
      collapsePressToken.current += 1
      if (holdTimer.current !== undefined) {
        clearTimeout(holdTimer.current)
        holdTimer.current = undefined
      }
      suppressCollapseClick.current = false
    }, [snap.layout.expanded])

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
      const updateTheme = (): void => {
        if (rootRef.current === null) return
        const next = readTheme(rootRef.current)
        setTheme(prev => (prev.css === next.css ? prev : next))
      }
      updateTheme()
      return watchTheme(updateTheme)
    }, [])

    useEffect(() => {
      if (notice === undefined) return
      const timer = setTimeout(() => setNotice(undefined), 4000)
      return () => clearTimeout(timer)
    }, [notice])

    useEffect(() => {
      let alive = true
      const load = async (force: boolean): Promise<void> => {
        try {
          const info = await client.checkUpdate(force)
          if (alive) setUpdate(info)
        } catch {
          // An older Host without the update route simply has no update info.
        }
      }
      void load(false)
      const timer = setInterval(() => void load(false), 30 * 60 * 1000)
      return () => {
        alive = false
        clearInterval(timer)
      }
    }, [client])

    const checkUpdate = async (force: boolean): Promise<void> => {
      setUpdateBusy(true)
      setUpdateError(undefined)
      try {
        setUpdate(await client.checkUpdate(force))
      } catch (error) {
        setUpdateError(error instanceof Error ? error.message : String(error))
      } finally {
        setUpdateBusy(false)
      }
    }

    const applyUpdate = async (): Promise<void> => {
      setUpdateBusy(true)
      setUpdateError(undefined)
      const result = await client.applyUpdate()
      if (result.update !== undefined) setUpdate(result.update)
      if (!result.ok) setUpdateError(t('update.applyFailed', { error: result.error ?? 'unknown' }))
      setUpdateBusy(false)
    }

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
    const ballEdge = ballDrag === undefined
      ? snap.layout.ballEdge === undefined ? initialBallEdge.current : snap.layout.ballEdge
      : nearestBallEdge(ballDrag, viewport.width, viewport.height, viewport.controls)
    const ballPoint = positionAtBallEdge(ballDrag ?? snap.layout.ball, ballEdge, viewport.width, viewport.height, viewport.controls)
    const widthLimit = Math.max(120, viewport.width - EDGE_GAP * 2)
    const requestedDockWidth = Math.min(dragWidth ?? snap.layout.width, widthLimit)
    const openHeight = snap.layout.dockHeight ?? Math.min(560, Math.max(MIN_DOCK_HEIGHT, viewport.height - EDGE_GAP * 2))
    const ballAnchorTop = ballPoint.y + BALL_SIZE / 2 - COLLAPSE_CENTER_Y
    const belowBall = viewport.height - EDGE_GAP - ballAnchorTop
    // A window opened from a ball keeps the button under it by shortening the
    // window when at least a minimum-height dock fits. Near the bottom edge
    // that is impossible, so it opens above the edge as before.
    const defaultOpenHeight = belowBall >= MIN_DOCK_HEIGHT
      ? Math.max(MIN_DOCK_HEIGHT, Math.min(openHeight, belowBall))
      : openHeight
    const savedHeight = dragHeight ?? snap.layout.dockHeight
    const edgeAnchor = ballEdge !== null && snap.layout.dock === null && dockDrag === undefined
    const attached = edgeAnchor ? attachedDock(ballPoint, ballEdge, viewport, requestedDockWidth, savedHeight ?? openHeight) : undefined
    const dockWidth = attached?.width ?? requestedDockWidth
    const retainedControl = snap.layout.dockControl
    const dockMargin = attached !== undefined || retainedControl != null ? BALL_MARGIN : EDGE_GAP
    const controlEdge = attached === undefined ? retainedControl?.edge : ballEdge
    const baseDock = snap.layout.dock ?? defaultDockPoint(ballPoint, dockWidth, viewport, defaultOpenHeight)
    const dockPoint = attached?.point ?? clampDock(
      dockDrag ?? baseDock,
      dockWidth,
      viewport,
      dockDrag === undefined && snap.layout.dock === null ? defaultOpenHeight : savedHeight ?? MIN_DOCK_HEIGHT,
      dockMargin,
    )
    const availableHeight = Math.max(BALL_SIZE, viewport.height - dockPoint.y - dockMargin)
    const renderedHeight = attached?.height ?? (savedHeight === undefined ? undefined : Math.min(savedHeight, availableHeight))
    const maxHeight = renderedHeight ?? availableHeight
    const control = attached?.control ?? (retainedControl == null ? undefined : {
      x: clamp(retainedControl.point.x, 0, dockWidth - BALL_SIZE),
      y: clamp(retainedControl.point.y, 0, maxHeight - BALL_SIZE),
    })
    // Rewrite inaccessible persisted positions after load/resize, without
    // interfering with a pointer gesture that is still choosing its position.
    useEffect(() => {
      if (ballDrag !== undefined || dockDrag !== undefined || closing) return
      const patch: { ball?: Point, dock?: Point } = {}
      if (snap.layout.ball.x !== ballPoint.x || snap.layout.ball.y !== ballPoint.y) patch.ball = ballPoint
      if (snap.layout.expanded && snap.layout.dock !== null
        && (snap.layout.dock.x !== dockPoint.x || snap.layout.dock.y !== dockPoint.y)) patch.dock = dockPoint
      if (Object.keys(patch).length > 0) client.setLayout(patch)
    }, [ballDrag, dockDrag, closing, snap.layout.ball, snap.layout.dock, snap.layout.expanded, ballPoint.x, ballPoint.y, dockPoint.x, dockPoint.y])
    const starPoint = !snap.layout.expanded ? ballPoint
      : control === undefined ? {
          x: dockPoint.x + dockWidth - COLLAPSE_RIGHT - COLLAPSE_SIZE,
          y: dockPoint.y + COLLAPSE_TOP,
        } : { x: dockPoint.x + control.x, y: dockPoint.y + control.y }
    const arrowEdge = snap.layout.expanded
      ? controlEdge == null ? null : OPPOSITE_EDGE[controlEdge]
      : ballEdge
    const arrowRotation = arrowEdge === 'right' ? 180 : arrowEdge === 'top' ? 90 : arrowEdge === 'bottom' ? -90 : 0
    const starAnchor = (
      <div className={`dshpad-star-anchor${arrowEdge === null ? '' : ' is-arrow'}`} style={{ left: starPoint.x, top: starPoint.y }} aria-hidden="true">
        <svg viewBox="0 0 28 28" width="28" height="28" focusable="false">
          {arrowEdge === null
            ? <path d={STAR_PATH} />
            : <path d="M10.5 8.5L16 14L10.5 19.5" transform={`rotate(${arrowRotation} 14 14)`} />}
        </svg>
      </div>
    )
    const dockStyle = {
      left: dockPoint.x,
      top: dockPoint.y,
      width: dockWidth,
      height: renderedHeight,
      maxHeight,
      ...(attached === undefined ? {} : { maxHeight: attached.height }),
      ...(control === undefined ? {} : {
        '--dshpad-control-x': `${control.x}px`,
        '--dshpad-control-y': `${control.y}px`,
        '--dshpad-head-left': control.y < 32 && control.x < 32 ? '36px' : '4px',
        '--dshpad-head-right': control.y < 32 && control.x + BALL_SIZE > dockWidth - 100 ? '36px' : '6px',
      }),
    } as CSSProperties
    const reserve = snap.layout.expanded
      && dockPoint.x + dockWidth >= viewport.width - EDGE_GAP - 2
      ? Math.round(dockWidth) + 12
      : 0
    useEffect(() => {
      const root = document.documentElement
      root.classList.toggle('dshpad-reserve', reserve > 0)
      root.style.setProperty('--dshpad-reserve', `${reserve}px`)
    }, [reserve])
    useEffect(() => () => {
      document.documentElement.classList.remove('dshpad-reserve')
      document.documentElement.style.removeProperty('--dshpad-reserve')
    }, [])

    /**
     * Persist a layout edit and normalize it against the current panels, so a
     * split can never lose or duplicate a card.
     */
    const commitTree = (next: LayoutNode): void => {
      const normalized = normalizeTree(next, snap.panels.map(panel => panel.id))
      if (normalized === null) return
      setTree(normalized)
      client.setTree(normalized)
    }

    /** The card under a client point, with its box for a drop-zone check. */
    const cardAt = (x: number, y: number): { id: string, rect: DOMRect } | undefined => {
      // The drag shield keeps pointer events out of panel iframes. Hide it for
      // this synchronous hit test, then put it straight back.
      const shield = shieldRef.current
      if (shield !== null) shield.style.pointerEvents = 'none'
      const node = document.elementFromPoint(x, y)
      if (shield !== null) shield.style.pointerEvents = ''
      const card = node instanceof Element ? node.closest('[data-panel-id]') : null
      if (card === null) return undefined
      const id = card.getAttribute('data-panel-id')
      if (id === null || id === '') return undefined
      return { id, rect: card.getBoundingClientRect() }
    }

    const startCardDrag = (sourceId: string, event: ReactPointerEvent<HTMLElement>): void => {
      if (event.button !== 0) return
      const startX = event.clientX
      const startY = event.clientY
      const pointerId = event.pointerId
      const capture = event.currentTarget
      let moved = false
      const move = (pointer: PointerEvent): void => {
        if (!moved && Math.hypot(pointer.clientX - startX, pointer.clientY - startY) <= DRAG_THRESHOLD) return
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
        const target = under !== undefined && under.id !== sourceId ? under.id : undefined
        const zone = target === undefined || under === undefined
          ? undefined
          : dropZoneFor(under.rect, pointer.clientX, pointer.clientY)
        setDrag({
          id: sourceId,
          x: pointer.clientX,
          y: pointer.clientY,
          target,
          ...(zone === undefined ? {} : { zone }),
          blank: under === undefined,
        })
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
        // A dragged pointer must not also fold or expand the card on the click.
        document.addEventListener('click', suppressClick, { capture: true, once: true })
        setTimeout(() => document.removeEventListener('click', suppressClick, true), 160)
        if (tree === null) return
        if (under === undefined) {
          commitTree(moveToRoot(tree, sourceId))
        } else if (under.id !== sourceId) {
          commitTree(dropOnLeaf(tree, sourceId, under.id, dropZoneFor(under.rect, pointer.clientX, pointer.clientY)))
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

    const startSplit = (path: readonly number[], boundary: number, event: ReactPointerEvent<HTMLDivElement>): void => {
      if (event.button !== 0) return
      event.preventDefault()
      event.stopPropagation()
      try {
        event.currentTarget.setPointerCapture(event.pointerId)
      } catch {
        // Synthetic pointers cannot be captured; document listeners still work.
      }
      if (tree === null) return
      const baseTree = tree
      const split = nodeAtPath(baseTree, path)
      const areaElement = event.currentTarget.parentElement
      if (split === null || split.kind !== 'split' || split.dir !== 'row' || areaElement === null) return
      if (boundary + 1 >= split.children.length) return
      const rect = areaElement.getBoundingClientRect()
      const gaps = SPLITTER_W * (split.children.length - 1)
      const cardArea = Math.max(1, rect.width - gaps)
      const total = totalWeight(split)
      const pairWeight = (split.weights[boundary] ?? 1) + (split.weights[boundary + 1] ?? 1)
      const startPx = ((split.weights[boundary] ?? 1) / total) * cardArea
      const pairPx = (pairWeight / total) * cardArea
      const minLeft = Math.min(MIN_PANE, pairPx / 2)
      const maxLeft = Math.max(minLeft, pairPx - MIN_PANE)
      const startX = event.clientX
      let final = baseTree
      const move = (pointer: PointerEvent): void => {
        const leftPx = clamp(startPx + pointer.clientX - startX, minLeft, maxLeft)
        const leftWeight = (leftPx / cardArea) * total
        const weights = split.weights.map((weight, index) => index === boundary
          ? leftWeight
          : index === boundary + 1
            ? pairWeight - leftWeight
            : weight)
        final = withWeightsAtPath(baseTree, path, weights)
        setTree(final)
      }
      const up = (): void => {
        cleanup()
        setTree(final)
        client.setTree(final)
      }
      const cleanup = (): void => {
        document.removeEventListener('pointermove', move)
        document.removeEventListener('pointerup', up)
        document.removeEventListener('pointercancel', up)
      }
      document.addEventListener('pointermove', move)
      document.addEventListener('pointerup', up)
      document.addEventListener('pointercancel', up)
    }

    // Replace the collapse control in place with the ball or edge tab.
    const collapse = (): void => {
      if (closing) return
      const buttonRect = rootRef.current?.querySelector<HTMLElement>('.dshpad-collapse')?.getBoundingClientRect()
      const center = buttonRect === undefined
        ? { x: dockPoint.x + dockWidth - COLLAPSE_CENTER_FROM_RIGHT, y: dockPoint.y + COLLAPSE_CENTER_Y }
        : { x: buttonRect.left + buttonRect.width / 2, y: buttonRect.top + buttonRect.height / 2 }
      const collapsePoint = edgeAnchor ? ballPoint : { x: center.x - BALL_SIZE / 2, y: center.y - BALL_SIZE / 2 }
      // Do not move a header control a second time on collapse. If it is merely
      // near an edge, keep its actual position until the next explicit drag.
      const nearbyEdge = nearestBallEdge(collapsePoint, viewport.width, viewport.height, viewport.controls)
      const attachedPoint = positionAtBallEdge(collapsePoint, nearbyEdge, viewport.width, viewport.height, viewport.controls)
      const nextEdge = edgeAnchor ? ballEdge
        : attachedPoint.x === collapsePoint.x && attachedPoint.y === collapsePoint.y ? nearbyEdge : null
      const nextBall = clampBall(collapsePoint, viewport.width, viewport.height, viewport.controls)
      if (transitionTimer.current !== undefined) {
        clearTimeout(transitionTimer.current)
        transitionTimer.current = undefined
      }
      setBallTransition({ point: nextBall, mode: 'closing' })
      setClosing(true)
      closeTimer.current = setTimeout(() => {
        setClosing(false)
        setBallTransition(undefined)
        client.setLayout({ expanded: false, ball: nextBall, ballEdge: nextEdge })
      }, 160)
    }

    /** Open from the ball, keeping its disc underneath while the window fades
     * in; the star is a separate persistent layer and never blinks. */
    const openFromBall = (point: Point): void => {
      if (transitionTimer.current !== undefined) clearTimeout(transitionTimer.current)
      setBallTransition({ point, mode: 'opening' })
      client.setLayout({ expanded: true, ...(ballEdge === null ? {} : { dock: null, dockControl: null }) })
      transitionTimer.current = setTimeout(() => {
        setBallTransition(undefined)
        transitionTimer.current = undefined
      }, 200)
    }

    // The ball is both the open button and its own draggable handle.
    const onBallPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
      if (event.button !== 0) return
      event.preventDefault()
      try {
        event.currentTarget.setPointerCapture(event.pointerId)
      } catch {
        // Synthetic pointers cannot be captured; document listeners still work.
      }
      const startX = event.clientX
      const startY = event.clientY
      const start = ballPoint
      let moved = false
      let final = start
      const move = (pointer: PointerEvent): void => {
        if (!moved && Math.hypot(pointer.clientX - startX, pointer.clientY - startY) < DRAG_THRESHOLD) return
        moved = true
        final = clampBall({ x: start.x + pointer.clientX - startX, y: start.y + pointer.clientY - startY }, viewport.width, viewport.height, viewport.controls)
        setBallDrag(final)
      }
      const up = (): void => {
        cleanup()
        if (!moved) {
          setBallDrag(undefined)
          openFromBall(start)
          return
        }
        const edge = nearestBallEdge(final, viewport.width, viewport.height, viewport.controls)
        const snapped = positionAtBallEdge(final, edge, viewport.width, viewport.height, viewport.controls)
        setBallDrag(undefined)
        // A moved ball is the new anchor for the window; drop any old window
        // position so the next open puts the collapse button under the ball.
        client.setLayout({ ball: snapped, ballEdge: edge, dock: null, dockControl: null })
      }
      const cancel = (): void => {
        cleanup()
        setBallDrag(undefined)
      }
      const cleanup = (): void => {
        document.removeEventListener('pointermove', move)
        document.removeEventListener('pointerup', up)
        document.removeEventListener('pointercancel', cancel)
      }
      document.addEventListener('pointermove', move)
      document.addEventListener('pointerup', up)
      document.addEventListener('pointercancel', cancel)
    }

    const onBallKey = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        openFromBall(ballPoint)
      }
    }

    // Move the whole window from a pointer that started at (startX, startY).
    // Shared by the header and the long-press gesture on the star button.
    const startDockMove = (startX: number, startY: number, onFirstMove?: () => void): void => {
      const start = dockPoint
      const width = dockWidth
      const boxHeight = asideRef.current?.getBoundingClientRect().height ?? MIN_DOCK_HEIGHT
      const height = clamp(Math.round(boxHeight), BALL_SIZE, Math.max(BALL_SIZE, viewport.height - dockMargin * 2))
      let moved = false
      let final = start
      const move = (pointer: PointerEvent): void => {
        if (!moved && Math.hypot(pointer.clientX - startX, pointer.clientY - startY) < DRAG_THRESHOLD) return
        if (!moved) {
          moved = true
          onFirstMove?.()
          if (control !== undefined && controlEdge != null) client.setLayout({ dockControl: { edge: controlEdge, point: control } })
          setDragHeight(height)
          // Detaching a top-edge dock must keep the width that fitted beside
          // the window buttons, rather than restoring the wider saved request.
          setDragWidth(width)
        }
        final = clampDock({ x: start.x + pointer.clientX - startX, y: start.y + pointer.clientY - startY }, width, viewport, height, dockMargin)
        setDockDrag(final)
      }
      const up = (): void => {
        cleanup()
        if (!moved) return
        setDockDrag(undefined)
        setDragHeight(undefined)
        setDragWidth(undefined)
        client.setLayout({ dock: final, dockHeight: height, width })
      }
      const cleanup = (): void => {
        document.removeEventListener('pointermove', move)
        document.removeEventListener('pointerup', up)
        document.removeEventListener('pointercancel', up)
      }
      document.addEventListener('pointermove', move)
      document.addEventListener('pointerup', up)
      document.addEventListener('pointercancel', up)
    }

    // Header drag: move the window anywhere in the viewport, and freeze its
    // current height so moving it down does not squeeze it against the floor.
    const onHeadPointerDown = (event: ReactPointerEvent<HTMLElement>): void => {
      if (event.button !== 0) return
      if ((event.target as HTMLElement).closest('button') !== null) return
      event.preventDefault()
      try {
        event.currentTarget.setPointerCapture(event.pointerId)
      } catch {
        // Synthetic pointers cannot be captured; document listeners still work.
      }
      startDockMove(event.clientX, event.clientY)
    }

    // A short press on the star collapses; holding it and moving drags the
    // window. Both gestures share the same 28px control.
    const onCollapsePointerDown = (event: ReactPointerEvent<HTMLButtonElement>): void => {
      if (event.button !== 0) return
      event.stopPropagation()
      suppressCollapseClick.current = false
      const token = collapsePressToken.current + 1
      collapsePressToken.current = token
      if (holdTimer.current !== undefined) {
        clearTimeout(holdTimer.current)
        holdTimer.current = undefined
      }
      try {
        event.currentTarget.setPointerCapture(event.pointerId)
      } catch {
        // Synthetic pointers cannot be captured; document listeners still work.
      }
      const startX = event.clientX
      const startY = event.clientY
      let moved = false
      let dragged = false
      let dragStarted = false
      const clearTimer = (): void => {
        if (holdTimer.current !== undefined) {
          clearTimeout(holdTimer.current)
          holdTimer.current = undefined
        }
      }
      const beginDrag = (): void => {
        if (dragStarted || token !== collapsePressToken.current) return
        dragStarted = true
        clearTimer()
        startDockMove(startX, startY, () => { dragged = true })
      }
      const onMove = (pointer: PointerEvent): void => {
        if (Math.hypot(pointer.clientX - startX, pointer.clientY - startY) > 8) {
          moved = true
          beginDrag()
        }
      }
      const onUp = (): void => {
        clearTimer()
        document.removeEventListener('pointermove', onMove)
        document.removeEventListener('pointerup', onUp)
        document.removeEventListener('pointercancel', onUp)
        if (!dragStarted && !moved) return
        // A long hold that never actually moved is still a click: let the
        // button's own onClick collapse instead of swallowing it.
        if (!dragged && !moved) return
        // The browser may still emit a click after a hold/drag; swallow it.
        suppressCollapseClick.current = true
        setTimeout(() => { suppressCollapseClick.current = false }, 500)
      }
      holdTimer.current = setTimeout(beginDrag, 260)
      document.addEventListener('pointermove', onMove)
      document.addEventListener('pointerup', onUp)
      document.addEventListener('pointercancel', onUp)
    }
    const onCollapseClick = (): void => {
      if (suppressCollapseClick.current) {
        suppressCollapseClick.current = false
        return
      }
      collapse()
    }

    // Left edge: width, with the right edge staying put.
    const onResizePointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
      if (event.button !== 0) return
      event.preventDefault()
      event.stopPropagation()
      try {
        event.currentTarget.setPointerCapture(event.pointerId)
      } catch {
        // Synthetic pointers cannot be captured; document listeners still work.
      }
      const startX = event.clientX
      const startWidth = dockWidth
      const right = dockPoint.x + startWidth
      const maxWidth = Math.max(BALL_SIZE, Math.min(MAX_WIDTH, right - dockMargin))
      const minWidth = Math.min(MIN_WIDTH, maxWidth)
      if (control !== undefined && controlEdge != null) client.setLayout({ dockControl: { edge: controlEdge, point: control } })
      let finalWidth = startWidth
      let finalPoint = dockPoint
      const move = (pointer: PointerEvent): void => {
        finalWidth = Math.round(clamp(startWidth + (startX - pointer.clientX), minWidth, maxWidth))
        finalPoint = clampDock({ x: Math.round(right - finalWidth), y: dockPoint.y }, finalWidth, viewport, savedHeight ?? maxHeight, dockMargin)
        setDragWidth(finalWidth)
        setDockDrag(finalPoint)
      }
      const up = (): void => {
        cleanup()
        setDragWidth(undefined)
        setDockDrag(undefined)
        client.setLayout({ width: finalWidth, dock: finalPoint })
      }
      const cleanup = (): void => {
        document.removeEventListener('pointermove', move)
        document.removeEventListener('pointerup', up)
        document.removeEventListener('pointercancel', up)
      }
      document.addEventListener('pointermove', move)
      document.addEventListener('pointerup', up)
      document.addEventListener('pointercancel', up)
    }

    // Top edge: change height from above while the bottom edge stays put.
    const onTopEdgePointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
      if (event.button !== 0) return
      event.preventDefault()
      try {
        event.currentTarget.setPointerCapture(event.pointerId)
      } catch {
        // Synthetic pointers cannot be captured; document listeners still work.
      }
      const startY = event.clientY
      const boxHeight = asideRef.current?.getBoundingClientRect().height ?? savedHeight ?? MIN_DOCK_HEIGHT
      const bottom = Math.min(dockPoint.y + boxHeight, viewport.height - dockMargin)
      const startTop = dockPoint.y
      const minTop = dockSafeTop(dockPoint.x, dockWidth, viewport, dockMargin)
      const maxTop = Math.max(minTop, bottom - Math.min(MIN_DOCK_HEIGHT, boxHeight))
      setDragWidth(dockWidth)
      if (control !== undefined && controlEdge != null) client.setLayout({ dockControl: { edge: controlEdge, point: control } })
      let finalHeight = bottom - startTop
      let finalPoint = dockPoint
      const move = (pointer: PointerEvent): void => {
        const nextTop = Math.round(clamp(startTop + pointer.clientY - startY, minTop, maxTop))
        finalHeight = Math.round(bottom - nextTop)
        finalPoint = { x: dockPoint.x, y: nextTop }
        setDragHeight(finalHeight)
        setDockDrag(finalPoint)
      }
      const up = (): void => {
        cleanup()
        setDragHeight(undefined)
        setDragWidth(undefined)
        setDockDrag(undefined)
        client.setLayout({ dockHeight: finalHeight, dock: finalPoint, width: dockWidth })
      }
      const cleanup = (): void => {
        document.removeEventListener('pointermove', move)
        document.removeEventListener('pointerup', up)
        document.removeEventListener('pointercancel', up)
      }
      document.addEventListener('pointermove', move)
      document.addEventListener('pointerup', up)
      document.addEventListener('pointercancel', up)
    }

    // Bottom edge: grow or shrink the window downwards from a fixed top.
    const onBottomEdgePointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
      if (event.button !== 0) return
      event.preventDefault()
      try {
        event.currentTarget.setPointerCapture(event.pointerId)
      } catch {
        // Synthetic pointers cannot be captured; document listeners still work.
      }
      const startY = event.clientY
      const startHeight = asideRef.current?.getBoundingClientRect().height ?? savedHeight ?? MIN_DOCK_HEIGHT
      const maxHeight = Math.max(BALL_SIZE, viewport.height - dockPoint.y - dockMargin)
      setDragWidth(dockWidth)
      if (control !== undefined && controlEdge != null) client.setLayout({ dockControl: { edge: controlEdge, point: control } })
      let finalHeight = startHeight
      let finalPoint = dockPoint
      const move = (pointer: PointerEvent): void => {
        finalHeight = Math.round(clamp(startHeight + pointer.clientY - startY, Math.min(MIN_DOCK_HEIGHT, maxHeight), maxHeight))
        finalPoint = clampDock(dockPoint, dockWidth, viewport, finalHeight, dockMargin)
        setDragHeight(finalHeight)
        setDockDrag(finalPoint)
      }
      const up = (): void => {
        cleanup()
        setDragHeight(undefined)
        setDragWidth(undefined)
        setDockDrag(undefined)
        client.setLayout({ dockHeight: finalHeight, dock: finalPoint, width: dockWidth })
      }
      const cleanup = (): void => {
        document.removeEventListener('pointermove', move)
        document.removeEventListener('pointerup', up)
        document.removeEventListener('pointercancel', up)
      }
      document.addEventListener('pointermove', move)
      document.addEventListener('pointerup', up)
      document.addEventListener('pointercancel', up)
    }

    const renderNode = (node: LayoutNode, path: readonly number[]): ReactNode => {
      if (node.kind === 'leaf') {
        const view = panelsById.get(node.id)
        if (view === undefined) return null
        return (
          <PanelCard
            key={node.id}
            view={view}
            client={client}
            theme={theme}
            lang={lang}
            t={t}
            clockActive={pageVisible}
            fresh={snap.fresh === view.id}
            dragging={drag?.id === view.id}
            dropTarget={drag?.target === view.id}
            dropZone={drag?.target === view.id ? drag.zone : undefined}
            onAsk={(text, submit) => { ask(text, submit) }}
            onExpand={() => setFocusedId(view.id)}
            onDragStart={event => startCardDrag(view.id, event)}
          />
        )
      }
      const pathKey = path.join('.') || 'root'
      if (node.dir === 'col') {
        return (
          <div className="dshpad-split is-col" key={pathKey}>
            {node.children.map((child, index) => (
              <div className="dshpad-pane" key={`${pathKey}.${index}`}>
                {renderNode(child, [...path, index])}
              </div>
            ))}
          </div>
        )
      }
      return (
        <div className="dshpad-split is-row" key={pathKey} style={{ gridTemplateColumns: rowTemplate(node) }}>
          {node.children.map((child, index) => (
            <Fragment key={`${pathKey}.${index}`}>
              {index > 0
                ? (
                  <div className="dshpad-splitter" role="separator" aria-orientation="vertical" title={t('dock.split')}
                    onPointerDown={event => startSplit(path, index - 1, event)} />
                  )
                : null}
              <div className="dshpad-pane">{renderNode(child, [...path, index])}</div>
            </Fragment>
          ))}
        </div>
      )
    }

    if (!snap.layout.expanded) {
      return (
        <div className="dshpad-root" ref={rootRef}>
          <div
            id="dshpad-ball"
            className={`dshpad-ball${ballDrag !== undefined ? ' is-dragging' : ''}${ballEdge === null ? '' : ` is-edge is-${ballEdge}`}`}
            data-edge={ballEdge ?? undefined}
            style={{ left: ballPoint.x, top: ballPoint.y }}
            role="button"
            tabIndex={0}
            title={attention ? t('capsule.attention') : `${t('dock.open')} · ${t('dock.ballHint')}`}
            aria-label={t('dock.open')}
            onPointerDown={onBallPointerDown}
            onKeyDown={onBallKey}
          >
            <BallDisc edge={ballEdge} />
          </div>
          {starAnchor}
          {ballDrag !== undefined ? <div className="dshpad-drag-shield" aria-hidden="true" /> : null}
        </div>
      )
    }

    const collapseControl = (
      <button type="button" className={`dshpad-collapse${control === undefined ? '' : ' is-attached'}`} title={`${t('dock.collapse')} · ${t('dock.holdDrag')}`} aria-label={t('dock.collapse')}
        disabled={closing}
        onClick={onCollapseClick}
        onPointerDown={onCollapsePointerDown}
        onContextMenu={event => event.preventDefault()}>
        <svg className="dshpad-collapse-star" viewBox="0 0 28 28" width="28" height="28" aria-hidden="true" focusable="false">
          <path d={STAR_PATH} />
        </svg>
      </button>
    )
    const examples: PadKey[] = ['empty.example1', 'empty.example2', 'empty.example3']
    const dragView = drag === undefined ? undefined : panelsById.get(drag.id)
    const dropHint = drag === undefined
      ? undefined
      : drag.target !== undefined && drag.zone !== undefined
        ? t(DROP_LABEL[drag.zone])
        : drag.blank
          ? t(DROP_LABEL.root)
          : t(DROP_LABEL.hint)
    return (
      <div className="dshpad-root" ref={rootRef}>
        <aside ref={asideRef} className={`dshpad-dock${control === undefined ? '' : ` is-attached is-attached-${controlEdge}`}${dockWidth < 160 ? ' is-narrow' : ''}${dockDrag !== undefined ? ' is-moving' : ''}${closing ? ' is-closing' : ''}`}
          style={dockStyle} aria-label={t('dock.title')}>
          <div className="dshpad-dock-edge is-top" role="separator" aria-orientation="horizontal" title={t('dock.resizeHeight')} onPointerDown={onTopEdgePointerDown}
            onDoubleClick={() => { setDragHeight(undefined); client.setDockHeight(undefined) }} />
          <div className="dshpad-resize" title={t('dock.resize')} onPointerDown={onResizePointerDown} />
          <header className="dshpad-dock-head" title={t('dock.move')} onPointerDown={onHeadPointerDown}>
            <span className="dshpad-grip" aria-hidden="true" />
            <span className="dshpad-spacer" />
            <button type="button" className="dshpad-icon-btn" title={t('dock.newPanel')} aria-label={t('dock.newPanel')}
              onClick={() => { ask(t('new.prefix'), false, true) }}>{Icon.plus}</button>
            <button type="button" className="dshpad-icon-btn" title={t('dock.refreshAll')} aria-label={t('dock.refreshAll')}
              disabled={snap.panels.length === 0}
              onClick={() => { for (const panel of snap.panels) void client.act({ op: 'refresh', panelId: panel.id }) }}>{Icon.refresh}</button>
            {update?.available === true
              ? (
                <button type="button" className="dshpad-icon-btn dshpad-update-btn"
                  title={t('update.tooltip')} aria-label={t('update.tooltip')}
                  onClick={() => setUpdateOpen(open => !open)}>
                  {Icon.download}
                </button>
                )
              : null}
            {collapseControl}
          </header>

          {updateOpen
            ? (
              <section className="dshpad-update" role="dialog" aria-label={t('update.title')}>
                <div className="dshpad-update-head">
                  <strong>{update?.available ? t('update.available') : t('update.title')}</strong>
                  <button type="button" className="dshpad-update-close" title={t('common.close')} aria-label={t('common.close')}
                    onClick={() => setUpdateOpen(false)}>{Icon.close}</button>
                </div>
                {update === undefined
                  ? <p className="dshpad-update-text">{t('update.unavailable')}</p>
                  : update.applied !== undefined
                    ? <p className="dshpad-update-text is-ok">{t('update.applied', { version: update.applied })}</p>
                    : update.reason === 'disabled'
                      ? <p className="dshpad-update-text">{t('update.disabled')}</p>
                      : update.reason === 'error'
                        ? <p className="dshpad-update-text is-error">{t('update.failed', { error: update.error ?? '' })}</p>
                        : update.available
                          ? (
                            <>
                              <p className="dshpad-update-text">
                                {t('update.current', { current: update.current })}
                                {update.latest === undefined ? '' : ` → ${t('update.latest', { latest: update.latest })}`}
                              </p>
                              {update.reason === 'source' ? <p className="dshpad-update-text">{t('update.source')}</p> : null}
                            </>
                            )
                          : <p className="dshpad-update-text">{t('update.upToDate', { version: update.current })}</p>}
                {updateError === undefined ? null : <p className="dshpad-update-text is-error">{updateError}</p>}
                <div className="dshpad-update-actions">
                  {update?.available === true && update.canApply
                    ? <button type="button" className="dshpad-update-primary" disabled={updateBusy} onClick={() => void applyUpdate()}>
                        {updateBusy ? t('update.applying') : t('update.apply')}
                      </button>
                    : (
                      <button type="button" className="dshpad-update-secondary" disabled={updateBusy} onClick={() => void checkUpdate(true)}>
                        {updateBusy ? t('update.checking') : t('update.check')}
                      </button>
                      )}
                  {update?.url === undefined
                    ? null
                    : <a className="dshpad-update-link" href={update.url} target="_blank" rel="noreferrer">{t('update.release')}</a>}
                  <button type="button" className="dshpad-update-secondary" onClick={() => setUpdateOpen(false)}>{t('update.later')}</button>
                </div>
              </section>
              )
            : null}

          {!snap.connected
            ? <p className="dshpad-banner" role="status">
                {snap.connectionError === undefined
                  ? t(snap.loaded ? 'dock.offline' : 'dock.connecting')
                  : t('dock.connectionFailed', { error: snap.connectionError })}
              </p>
            : null}
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
                  {tree === null ? null : renderNode(tree, [])}
                  {drag?.blank ? <div className="dshpad-root-drop">{t(DROP_LABEL.root)}</div> : null}
                </div>
                )}
          </div>

          <div className="dshpad-dock-foot" role="separator" aria-orientation="horizontal" title={t('dock.resizeHeight')} onPointerDown={onBottomEdgePointerDown}
            onDoubleClick={() => { setDragHeight(undefined); client.setDockHeight(undefined) }} />
        </aside>

        {ballTransition === undefined
          ? null
          : (
            <div
              className={`dshpad-ball-transition is-${ballTransition.mode}`}
              style={{ left: ballTransition.point.x, top: ballTransition.point.y }}
              aria-hidden="true"
            >
              <BallDisc />
            </div>
            )}
        {starAnchor}
        {dockDrag !== undefined ? <div className="dshpad-drag-shield" aria-hidden="true" /> : null}
        {dragHeight !== undefined && dockDrag === undefined ? <div className="dshpad-drag-shield" aria-hidden="true" /> : null}

        {drag !== undefined ? <div className="dshpad-drag-shield" ref={shieldRef} aria-hidden="true" /> : null}

        {drag !== undefined && dragView !== undefined
          ? (
            <div className="dshpad-drag-ghost" style={{ left: drag.x + 12, top: drag.y + 12 }}>
              {dragView.definition.icon ? <span>{dragView.definition.icon}</span> : null}
              <span className="dshpad-drag-name">{dragView.definition.title}</span>
              {dropHint === undefined ? null : <span className="dshpad-drag-hint">{dropHint}</span>}
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
                    {Icon.close}
                  </button>
                </header>
                {awaitingFirstData(focusedView.definition, focusedView.data)
                  ? <p className="dshpad-card-note">{t('card.firstData')}</p>
                  : (
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
                    )}
              </div>
            </div>
            )
          : null}
      </div>
    )
  }
}
