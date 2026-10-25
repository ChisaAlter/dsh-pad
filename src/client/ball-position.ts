/** Floating-ball geometry shared by dragging, edge rendering and viewport resize. */
import { BALL_MARGIN, BALL_SIZE, type Point } from './pad-client.ts'
import { avoidWindowControls, type WindowControls } from './window-controls.ts'

export type BallEdge = 'left' | 'right' | 'top' | 'bottom'

/** Snap to the nearest edge within this many CSS pixels. */
const SNAP_DISTANCE = 26

/** Keep the entire control clickable, even on a very small viewport. */
export function clampBall(point: Point, width: number, height: number, controls?: WindowControls): Point {
  const ball = {
    x: Math.round(Math.max(BALL_MARGIN, Math.min(point.x, Math.max(BALL_MARGIN, width - BALL_SIZE - BALL_MARGIN)))),
    y: Math.round(Math.max(BALL_MARGIN, Math.min(point.y, Math.max(BALL_MARGIN, height - BALL_SIZE - BALL_MARGIN)))),
  }
  return avoidWindowControls(ball, BALL_SIZE, { width, height, controls }, BALL_MARGIN)
}

/** Corners choose one nearest edge, so the arrow always has one clear direction. */
export function nearestBallEdge(point: Point, width: number, height: number, controls?: WindowControls): BallEdge | null {
  const ball = clampBall(point, width, height, controls)
  const distances: readonly [BallEdge, number][] = [
    ['left', ball.x - BALL_MARGIN],
    ['right', Math.max(0, width - BALL_SIZE - BALL_MARGIN - ball.x)],
    ['top', ball.y - BALL_MARGIN],
    ['bottom', Math.max(0, height - BALL_SIZE - BALL_MARGIN - ball.y)],
  ]
  let edge: BallEdge | null = null
  let nearest = SNAP_DISTANCE
  for (const [candidate, distance] of distances) {
    if (distance < nearest) {
      edge = candidate
      nearest = distance
    }
  }
  return edge
}

/** Retain an attached edge when the viewport grows or shrinks. */
export function positionAtBallEdge(point: Point, edge: BallEdge | null, width: number, height: number, controls?: WindowControls): Point {
  let ball = clampBall(point, width, height)
  if (edge === 'left') ball = { ...ball, x: BALL_MARGIN }
  if (edge === 'right') ball = { ...ball, x: Math.max(BALL_MARGIN, width - BALL_SIZE - BALL_MARGIN) }
  if (edge === 'top') ball = { ...ball, y: BALL_MARGIN }
  if (edge === 'bottom') ball = { ...ball, y: Math.max(BALL_MARGIN, height - BALL_SIZE - BALL_MARGIN) }
  // Apply exclusion after snapping: snapping can put an otherwise safe ball
  // back under the titlebar. Move along the edge to retain its attachment.
  const along = edge === 'top' || edge === 'bottom' ? 'horizontal'
    : edge === 'left' || edge === 'right' ? 'vertical' : undefined
  return avoidWindowControls(ball, BALL_SIZE, { width, height, controls }, BALL_MARGIN, along)
}
