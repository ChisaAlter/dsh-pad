import { describe, expect, it } from 'vitest'
import { clampBall, nearestBallEdge, positionAtBallEdge, type BallEdge } from '../src/client/ball-position.ts'
import { overlapsWindowControls } from '../src/client/window-controls.ts'

const width = 1000
const height = 700

describe('the floating ball attaches to an edge', () => {
  it.each([
    ['left', { x: 20, y: 300 }, { x: 1, y: 300 }],
    ['right', { x: 952, y: 300 }, { x: 971, y: 300 }],
    ['top', { x: 500, y: 20 }, { x: 500, y: 1 }],
    ['bottom', { x: 500, y: 652 }, { x: 500, y: 671 }],
  ] as const)('snaps to the %s edge and keeps its other coordinate', (edge, point, expected) => {
    expect(nearestBallEdge(point, width, height)).toBe(edge)
    expect(positionAtBallEdge(point, edge, width, height)).toEqual(expected)
  })

  it('restores a free ball when dragged away from every edge', () => {
    const point = { x: 500, y: 300 }
    const edge = nearestBallEdge(point, width, height)
    expect(edge).toBeNull()
    expect(positionAtBallEdge(point, edge, width, height)).toEqual(point)
  })

  it('chooses just the nearest edge at a corner', () => {
    expect(nearestBallEdge({ x: 8, y: 20 }, width, height)).toBe('left')
    expect(nearestBallEdge({ x: 20, y: 8 }, width, height)).toBe('top')
  })

  it.each(['left', 'right', 'top', 'bottom'] as BallEdge[])('keeps the %s attachment after viewport resize', edge => {
    const attached = positionAtBallEdge({ x: 500, y: 300 }, edge, width, height)
    const resized = positionAtBallEdge(attached, edge, 1200, 900)
    expect(nearestBallEdge(resized, 1200, 900)).toBe(edge)
  })
})

const controls = { left: 888, top: 0, right: 1000, bottom: 48 }

describe('desktop window controls exclusion', () => {
  it('recovers a saved ball underneath the close button', () => {
    expect(clampBall({ x: 971, y: 1 }, width, height, controls)).toEqual({ x: 971, y: 56 })
    expect(clampBall({ x: 860, y: 10 }, width, height, controls)).toEqual({ x: 852, y: 10 })
  })

  it('preserves ordinary browser placement and the rest of the top edge', () => {
    expect(clampBall({ x: 971, y: 1 }, width, height)).toEqual({ x: 971, y: 1 })
    expect(clampBall({ x: 500, y: 1 }, width, height, controls)).toEqual({ x: 500, y: 1 })
  })

  it('applies exclusion after snapping while preserving the attached edge', () => {
    expect(positionAtBallEdge({ x: 971, y: 100 }, 'top', width, height, controls)).toEqual({ x: 852, y: 1 })
    expect(positionAtBallEdge({ x: 500, y: 1 }, 'right', width, height, controls)).toEqual({ x: 971, y: 56 })
  })

  it('recovers top and right attachments after the viewport shrinks', () => {
    const smallerControls = { left: 278, top: 0, right: 390, bottom: 48 }
    expect(positionAtBallEdge({ x: 852, y: 1 }, 'top', 390, 300, smallerControls)).toEqual({ x: 242, y: 1 })
    expect(positionAtBallEdge({ x: 971, y: 1 }, 'right', 390, 300, smallerControls)).toEqual({ x: 361, y: 56 })
  })

  it.each(['left', 'right', 'top', 'bottom', null] as const)('never overlaps controls while snapping to %s', edge => {
    for (let x = 800; x <= 1050; x += 10) {
      for (let y = -20; y <= 100; y += 10) {
        const ball = positionAtBallEdge({ x, y }, edge, width, height, controls)
        expect(overlapsWindowControls(ball, 28, 28, controls)).toBe(false)
      }
    }
  })
})
