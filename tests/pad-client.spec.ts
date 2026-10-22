import { describe, expect, it } from 'vitest'
import { BALL_SIZE, BALL_MARGIN, BALL_SNAP_INSET, MAX_WIDTH, MIN_WIDTH, MIN_DOCK_HEIGHT, normalizeDockLayout } from '../src/client/pad-client.ts'

describe('persisted dock layout', () => {
  it('migrates old rows and the capsule position', () => {
    const layout = normalizeDockLayout({
      expanded: true,
      width: 400,
      rows: [
        { ids: ['a', 'b'], weights: [2, 1] },
        { ids: ['c'], weights: [1] },
      ],
      capsuleY: 0.5,
      heights: { a: 300 },
      dockHeight: 500,
    })
    expect(layout.expanded).toBe(true)
    expect(layout.width).toBe(400)
    expect(layout.tree).toEqual({
      kind: 'split', dir: 'col', weights: [1, 1],
      children: [
        { kind: 'split', dir: 'row', weights: [2, 1], children: [{ kind: 'leaf', id: 'a' }, { kind: 'leaf', id: 'b' }] },
        { kind: 'leaf', id: 'c' },
      ],
    })
    // The old capsule lived on the right edge; the ball takes that corner.
    expect(layout.ball).toEqual({ x: 1440 - BALL_SIZE - BALL_SNAP_INSET, y: 900 * 0.5 - BALL_SIZE / 2 })
    expect(layout.dock).toBeNull()
    expect(layout.heights).toEqual({ a: 300 })
    expect(layout.dockHeight).toBe(500)
  })

  it('keeps a stored ball and window position', () => {
    const tree = { kind: 'leaf', id: 'a' }
    const layout = normalizeDockLayout({
      expanded: false,
      width: 360,
      tree,
      ball: { x: 30, y: 40 },
      dock: { x: 120, y: 90 },
      heights: {},
    })
    expect(layout.tree).toEqual(tree)
    expect(layout.ball).toEqual({ x: 30, y: 40 })
    expect(layout.dock).toEqual({ x: 120, y: 90 })
  })

  it('clamps sizes and falls back to sane defaults', () => {
    const wide = normalizeDockLayout({ width: 99_999, heights: {}, expanded: 'yes' })
    expect(wide.width).toBe(MAX_WIDTH)
    expect(wide.expanded).toBe(false)
    expect(wide.tree).toBeNull()
    expect(wide.ball).toEqual({ x: 1440 - BALL_SIZE - BALL_SNAP_INSET, y: Math.round(900 * 0.42 - BALL_SIZE / 2) })
    const narrow = normalizeDockLayout({ width: 1, heights: {} })
    expect(narrow.width).toBe(MIN_WIDTH)
    expect(normalizeDockLayout(null).dockHeight).toBeUndefined()
    expect(normalizeDockLayout({ dockHeight: 1 }).dockHeight).toBe(MIN_DOCK_HEIGHT)
  })

  it('pulls a stale ball back inside the viewport', () => {
    const layout = normalizeDockLayout({ ball: { x: -500, y: 9999 }, heights: {} })
    expect(layout.ball.x).toBe(BALL_MARGIN)
    expect(layout.ball.y).toBe(900 - BALL_SIZE - BALL_MARGIN)
  })
})
