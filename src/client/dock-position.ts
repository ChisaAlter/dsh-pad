/** Geometry for an edge-attached dock and its in-place toggle. */
import { BALL_MARGIN, BALL_SIZE, type DockControl, type Point } from './pad-client.ts'
import { positionAtBallEdge, type BallEdge } from './ball-position.ts'
import { dockSafeTop, WINDOW_CONTROL_GAP, type Viewport } from './window-controls.ts'

/** Resolve a saved toggle against the current size, including legacy positions
 * saved before the window was resized. Only the coordinate along its edge is
 * retained; the perpendicular coordinate always follows the edge itself. */
export function retainedDockControl(control: DockControl, width: number, height: number): Point {
  const maxX = Math.max(0, width - BALL_SIZE)
  const maxY = Math.max(0, height - BALL_SIZE)
  return {
    x: control.edge === 'left' ? 0 : control.edge === 'right' ? maxX : Math.max(0, Math.min(control.point.x, maxX)),
    y: control.edge === 'top' ? 0 : control.edge === 'bottom' ? maxY : Math.max(0, Math.min(control.point.y, maxY)),
  }
}

/** Preserve the toggle's viewport position along its edge when an edge resize
 * moves the dock origin. The edge perpendicular to that coordinate still wins. */
export function resizedDockControl(control: DockControl, before: Point, after: Point, width: number, height: number): DockControl {
  const point = { x: control.point.x + before.x - after.x, y: control.point.y + before.y - after.y }
  return { edge: control.edge, point: retainedDockControl({ edge: control.edge, point }, width, height) }
}

export interface AttachedDock {
  readonly point: Point
  readonly width: number
  readonly height: number
  /** Toggle coordinates relative to the dock, never a separate floating layer. */
  readonly control: Point
}

/**
 * Grow the panel into the viewport while keeping the complete 28px toggle
 * inside its attached edge. At a corner the other axis is clamped too.
 */
export function attachedDock(ball: Point, edge: BallEdge, viewport: Viewport, requestedWidth: number, requestedHeight: number): AttachedDock {
  ball = positionAtBallEdge(ball, edge, viewport.width, viewport.height, viewport.controls)
  // A top attachment grows only to the left of the titlebar buttons. Other
  // attachments can use the full width by opening below the reserved area.
  const besideControls = viewport.controls !== undefined && ball.y < viewport.controls.bottom + WINDOW_CONTROL_GAP
  const right = besideControls ? Math.floor(viewport.controls!.left - WINDOW_CONTROL_GAP) : viewport.width - BALL_MARGIN
  const width = Math.max(BALL_SIZE, Math.min(requestedWidth, right - BALL_MARGIN))
  const height = Math.max(BALL_SIZE, Math.min(requestedHeight, viewport.height - BALL_MARGIN * 2))
  const bound = (value: number, extent: number, size: number): number =>
    Math.round(Math.max(BALL_MARGIN, Math.min(value, Math.max(BALL_MARGIN, extent - size - BALL_MARGIN))))
  const desiredX = edge === 'left' ? ball.x
    : edge === 'right' ? ball.x + BALL_SIZE - width
      : ball.x + BALL_SIZE / 2 - width / 2
  const desiredY = edge === 'top' ? ball.y
    : edge === 'bottom' ? ball.y + BALL_SIZE - height
      : ball.y - 2
  const x = bound(desiredX, right + BALL_MARGIN, width)
  const top = dockSafeTop(x, width, viewport, BALL_MARGIN)
  const safeHeight = Math.max(BALL_SIZE, Math.min(height, viewport.height - top - BALL_MARGIN))
  const point = { x, y: Math.max(top, bound(desiredY, viewport.height, safeHeight)) }
  return { point, width, height: safeHeight, control: { x: ball.x - point.x, y: ball.y - point.y } }
}
