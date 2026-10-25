import { describe, expect, it } from 'vitest'
import { attachedDock } from '../src/client/dock-position.ts'
import { positionAtBallEdge, type BallEdge } from '../src/client/ball-position.ts'
import { overlapsWindowControls } from '../src/client/window-controls.ts'

const viewport = { width: 1000, height: 700 }

describe('an attached panel contains its toggle at the original ball position', () => {
  it.each(['left', 'right', 'top', 'bottom'] as BallEdge[])('keeps the %s control inside the panel, including near corners', edge => {
    for (const point of [{ x: 500, y: 300 }, { x: 1, y: 1 }, { x: 971, y: 671 }]) {
      const ball = positionAtBallEdge(point, edge, viewport.width, viewport.height)
      const dock = attachedDock(ball, edge, viewport, 352, 500)
      expect(dock.point.x + dock.control.x).toBe(ball.x)
      expect(dock.point.y + dock.control.y).toBe(ball.y)
      expect(dock.control.x).toBeGreaterThanOrEqual(0)
      expect(dock.control.y).toBeGreaterThanOrEqual(0)
      expect(dock.control.x + 28).toBeLessThanOrEqual(dock.width)
      expect(dock.control.y + 28).toBeLessThanOrEqual(dock.height)
      expect(dock.point.x).toBeGreaterThanOrEqual(1)
      expect(dock.point.y).toBeGreaterThanOrEqual(1)
      expect(dock.point.x + dock.width).toBeLessThanOrEqual(viewport.width - 1)
      expect(dock.point.y + dock.height).toBeLessThanOrEqual(viewport.height - 1)
    }
  })

  it('fits a small viewport without detaching the control', () => {
    const viewport = { width: 240, height: 160 }
    const ball = positionAtBallEdge({ x: 220, y: 80 }, 'right', viewport.width, viewport.height)
    const dock = attachedDock(ball, 'right', viewport, 352, 500)
    expect(dock.width).toBe(238)
    expect(dock.height).toBe(158)
    expect(dock.point.x + dock.control.x).toBe(ball.x)
    expect(dock.point.y + dock.control.y).toBe(ball.y)
  })

  it('keeps the toggle inside when window-control bounds use fractional CSS pixels', () => {
    for (const fraction of [0.25, 0.5, 0.75]) {
      const controls = { left: 888 + fraction, top: 0, right: 1000 + fraction, bottom: 48 }
      const desktop = { ...viewport, controls }
      const ball = positionAtBallEdge({ x: 950, y: 1 }, 'top', viewport.width, viewport.height, controls)
      const dock = attachedDock(ball, 'top', desktop, 352, 500)
      expect(dock.point.y).toBe(1)
      expect(dock.control.y).toBe(0)
      expect(dock.point.x + dock.width).toBeLessThanOrEqual(controls.left - 8)
      expect(dock.point.x + dock.control.x).toBe(ball.x)
    }
  })

  it.each(['left', 'right', 'top', 'bottom'] as BallEdge[])('keeps the %s dock and its toggle clear of desktop buttons', edge => {
    for (const [width, height] of [[1000, 700], [390, 300], [240, 160], [160, 100]]) {
      const controls = { left: width! - 112, top: 0, right: width!, bottom: 48 }
      const viewport = { width: width!, height: height!, controls }
      for (const point of [{ x: 500, y: 300 }, { x: 1, y: 1 }, { x: width! - 29, y: 1 }, { x: width! - 29, y: height! - 29 }]) {
        const ball = positionAtBallEdge(point, edge, viewport.width, viewport.height, controls)
        const dock = attachedDock(ball, edge, viewport, 640, 500)
        expect(overlapsWindowControls(dock.point, dock.width, dock.height, controls)).toBe(false)
        expect(dock.point.x + dock.control.x).toBe(ball.x)
        expect(dock.point.y + dock.control.y).toBe(ball.y)
        expect(dock.control.x).toBeGreaterThanOrEqual(0)
        expect(dock.control.y).toBeGreaterThanOrEqual(0)
        expect(dock.control.x + 28).toBeLessThanOrEqual(dock.width)
        expect(dock.control.y + 28).toBeLessThanOrEqual(dock.height)
        expect(dock.point.x + dock.width).toBeLessThanOrEqual(viewport.width - 1)
        expect(dock.point.y + dock.height).toBeLessThanOrEqual(viewport.height - 1)
      }
    }
  })
})
