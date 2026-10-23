import { describe, expect, it, vi } from 'vitest'
import {
  BALL_SIZE, BALL_MARGIN, BALL_SNAP_INSET, HISTORY_LIMIT, MAX_WIDTH, MIN_WIDTH, MIN_DOCK_HEIGHT,
  awaitingFirstData, normalizeDockLayout, seedPanelHistory,
} from '../src/client/pad-client.ts'
import { PadClient } from '../src/client/pad-client.ts'
import type { HistoryPoint } from '../src/client/pad-client.ts'
import type { PanelData, PanelDefinition, PanelSource, PanelView } from '../src/shared/types.ts'

const source = (id: string): PanelSource => ({ id, kind: 'http', url: 'https://example.com', parse: 'json', intervalSec: 30 })

const definition = (sources: PanelSource[]): PanelDefinition => ({
  title: 'panel',
  html: '',
  css: '',
  script: '',
  height: 'auto',
  sources,
})

const reading = { ok: true, value: { total: 1 }, at: new Date().toISOString() }

const data = (sources: PanelData['sources'] = {}): PanelData => ({ sources, agent: null })

describe('a panel waits for its first readings', () => {
  it('holds a panel back while a declared source has no reading', () => {
    // After a restart the Hub has no readings: a script that reads
    // `sources.metric.value` on that first render would throw.
    expect(awaitingFirstData(definition([source('metric')]), data())).toBe(true)
  })

  it('holds a panel back until every declared source has been read', () => {
    expect(awaitingFirstData(definition([source('a'), source('b')]), data({ a: reading }))).toBe(true)
    expect(awaitingFirstData(definition([source('a'), source('b')]), data({ a: reading, b: reading }))).toBe(false)
  })

  it('counts a failed reading as read', () => {
    // The panel renders the failure itself; waiting would show nothing forever.
    const failed = { ok: false, error: 'HTTP 500', at: new Date().toISOString() }
    expect(awaitingFirstData(definition([source('metric')]), data({ metric: failed }))).toBe(false)
  })

  it('lets panels without sources render straight away', () => {
    expect(awaitingFirstData(definition([]), data())).toBe(false)
    expect(awaitingFirstData(definition([]), data({ stale: reading }))).toBe(false)
  })

  it('ignores readings of sources the panel no longer declares', () => {
    expect(awaitingFirstData(definition([source('metric')]), data({ removed: reading }))).toBe(true)
  })
})

const point = (value: number, at: string): HistoryPoint => ({ value, at })

const view = (history: PanelView['history']): PanelView => ({
  id: 'p_1',
  version: 1,
  position: 0,
  collapsed: false,
  span: 1,
  updatedAt: '2026-10-23T00:00:00.000Z',
  definition: definition([source('metric')]),
  canUndo: false,
  needsApproval: false,
  fingerprint: '',
  agentRun: null,
  data: data(),
  history,
})

describe('history cached on the Host', () => {
  it('seeds a fresh page with the points kept from the last session', () => {
    const store = new Map<string, Map<string, HistoryPoint[]>>()
    const points = [point(1, '2026-10-23T07:00:00.000Z'), point(2, '2026-10-23T07:05:00.000Z')]
    seedPanelHistory(store, view({ metric: points }))
    expect(store.get('p_1')?.get('metric')).toEqual(points)
  })

  it('never replaces live points that are already newer', () => {
    const live = [point(9, '2026-10-23T08:00:00.000Z')]
    const store = new Map([['p_1', new Map([['metric', live]])]])
    seedPanelHistory(store, view({ metric: [point(1, '2026-10-23T07:00:00.000Z')] }))
    expect(store.get('p_1')?.get('metric')).toEqual(live)
  })

  it('drops points without a usable timestamp', () => {
    const store = new Map<string, Map<string, HistoryPoint[]>>()
    seedPanelHistory(store, view({ metric: [point(1, 'not a date'), point(2, '2026-10-23T07:05:00.000Z')] }))
    expect(store.get('p_1')?.get('metric')).toEqual([point(2, '2026-10-23T07:05:00.000Z')])
  })

  it('keeps the newest points when the Host sends more than the page holds', () => {
    const store = new Map<string, Map<string, HistoryPoint[]>>()
    const many = Array.from({ length: HISTORY_LIMIT + 30 }, (_, index) =>
      point(index, new Date(Date.UTC(2026, 9, 23, 0, index)).toISOString()))
    seedPanelHistory(store, view({ metric: many }))
    const points = store.get('p_1')?.get('metric') ?? []
    expect(points).toHaveLength(HISTORY_LIMIT)
    expect(points[0]?.value).toBe(30)
    expect(points[points.length - 1]?.value).toBe(HISTORY_LIMIT + 29)
  })

  it('hands the seeded points to the panel frame', () => {
    class FakeEventSource {
      static last: FakeEventSource | undefined
      onopen: (() => void) | null = null
      onerror: (() => void) | null = null
      onmessage: ((event: { data: string }) => void) | null = null
      constructor(readonly url: string) { FakeEventSource.last = this }
      close(): void {}
    }
    vi.stubGlobal('EventSource', FakeEventSource)
    try {
      const points = [point(1, '2026-10-23T07:00:00.000Z'), point(2, '2026-10-23T07:05:00.000Z')]
      const client = new PadClient()
      client.start()
      const stream = FakeEventSource.last
      expect(stream).toBeDefined()
      stream?.onmessage?.({ data: JSON.stringify({ type: 'panels', panels: [view({ metric: points })] }) })
      expect(client.historiesOf('p_1')['metric']?.map(entry => entry.value)).toEqual([1, 2])
      client.stop()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

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
