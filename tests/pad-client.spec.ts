import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BALL_SIZE, BALL_MARGIN, BALL_SNAP_INSET, HISTORY_LIMIT, MAX_WIDTH, MIN_WIDTH, MIN_DOCK_HEIGHT,
  awaitingFirstData, normalizeDockLayout, seedPanelHistory,
} from '../src/client/pad-client.ts'
import { PadClient } from '../src/client/pad-client.ts'
import type { HistoryPoint } from '../src/client/pad-client.ts'
import type { HttpSource, PanelData, PanelDefinition, PanelSource, PanelView, StreamEvent } from '../src/shared/types.ts'
import { dropOnLeaf, leafIds, type LayoutNode } from '../src/client/layout.ts'

const source = (id: string): HttpSource => ({ id, kind: 'http', url: 'https://example.com', parse: 'json', intervalSec: 30 })

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

  it('waits for an own reading when the source is named constructor', () => {
    const own = definition([source('constructor')])
    expect(awaitingFirstData(own, data())).toBe(true)
    expect(awaitingFirstData(own, data(JSON.parse(JSON.stringify({ constructor: reading }))))).toBe(false)
    expect(awaitingFirstData(own, data(JSON.parse('{"constructor":{"ok":false,"error":"offline","at":"2026-10-26T00:00:00Z"}}')))).toBe(false)
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
  agentRun: null,
  data: data(),
  history,
})

class FakeEventSource {
  static instances: FakeEventSource[] = []
  readyState = 0
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  close = vi.fn(() => { this.readyState = 2 })

  constructor(readonly url: string) { FakeEventSource.instances.push(this) }

  emit(event: StreamEvent): void { this.onmessage?.({ data: JSON.stringify(event) }) }
}

function latestStream(): FakeEventSource {
  return FakeEventSource.instances.at(-1)!
}

function emitPanels(...panels: PanelView[]): void {
  latestStream().emit({ type: 'panels', panels })
}

function emitReading(value: number, at: string): void {
  latestStream().emit({ type: 'data', panelId: 'p_1', data: data({ metric: { ok: true, value, at } }) })
}

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

  it('merges readings missed during a disconnect, sorting and deduplicating timestamps', () => {
    const a = point(1, '2026-10-23T07:00:00.000Z')
    const b = point(2, '2026-10-23T07:05:00.000Z')
    const c = point(3, '2026-10-23T07:10:00.000Z')
    const store = new Map([['p_1', new Map([['metric', [a]]])]])
    const snapshot = view({ metric: [c, b, point(99, a.at), b] })
    seedPanelHistory(store, snapshot)
    seedPanelHistory(store, snapshot)
    expect(store.get('p_1')?.get('metric')).toEqual([a, b, c])
  })

  it('does not revive points older than the local window when a newer snapshot arrives', () => {
    const kept = point(2, '2026-10-23T07:05:00.000Z')
    const newer = point(3, '2026-10-23T07:10:00.000Z')
    const store = new Map([['p_1', new Map([['metric', [kept]]])]])
    seedPanelHistory(store, view({ metric: [point(1, '2026-10-23T07:00:00.000Z'), kept, newer] }))
    expect(store.get('p_1')?.get('metric')).toEqual([kept, newer])
  })

  it('sorts fresh snapshots by time and keeps the last value at duplicate instants', () => {
    const store = new Map<string, Map<string, HistoryPoint[]>>()
    seedPanelHistory(store, view({ metric: [
      point(3, '2026-10-23T07:10:00.000Z'),
      point(1, '2026-10-23T07:00:00.000Z'),
      point(2, '2026-10-23T07:00:00+00:00'),
    ] }))
    expect(store.get('p_1')?.get('metric')).toEqual([
      point(2, '2026-10-23T07:00:00+00:00'), point(3, '2026-10-23T07:10:00.000Z'),
    ])
  })

  it('limits merged history after filling missed readings', () => {
    const points = Array.from({ length: HISTORY_LIMIT + 1 }, (_, index) =>
      point(index, new Date(Date.UTC(2026, 9, 23, 0, index)).toISOString()))
    const store = new Map([['p_1', new Map([['metric', points.slice(0, 1)]])]])
    seedPanelHistory(store, view({ metric: points.slice().reverse() }))
    expect(store.get('p_1')?.get('metric')).toEqual(points.slice(1))
  })

  it('ignores cached points of sources the panel no longer declares', () => {
    const store = new Map<string, Map<string, HistoryPoint[]>>()
    seedPanelHistory(store, view({ removed: [point(1, '2026-10-23T07:00:00.000Z')] }))
    expect(store.get('p_1')?.get('removed')).toBeUndefined()
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

describe('history follows source definitions and live readings', () => {
  let client: PadClient
  const at = '2026-10-23T07:00:00.000Z'
  const http: PanelSource = {
    id: 'metric', kind: 'http', url: 'https://example.com', method: 'POST',
    headers: { authorization: 'token', accept: 'application/json' }, body: '{}',
    parse: 'json', intervalSec: 30, timeoutMs: 5000,
  }
  const command: PanelSource = { id: 'metric', kind: 'command', command: 'echo 1', parse: 'json', intervalSec: 30, timeoutMs: 5000 }

  beforeEach(() => {
    FakeEventSource.instances = []
    vi.stubGlobal('EventSource', FakeEventSource)
    client = new PadClient()
    client.start()
  })

  afterEach(() => { client.stop(); vi.unstubAllGlobals() })

  const edits: { label: string, before: PanelSource, after: PanelSource }[] = [
    { label: 'HTTP URL', before: http, after: { ...http, url: 'https://other.example.com' } },
    { label: 'HTTP method', before: http, after: { ...http, method: 'GET' } },
    { label: 'HTTP headers', before: http, after: { ...http, headers: { authorization: 'other' } } },
    { label: 'HTTP body', before: http, after: { ...http, body: 'changed' } },
    { label: 'HTTP parser', before: http, after: { ...http, parse: 'text' } },
    { label: 'HTTP interval', before: http, after: { ...http, intervalSec: 60 } },
    { label: 'HTTP timeout', before: http, after: { ...http, timeoutMs: 8000 } },
    { label: 'command text', before: command, after: { ...command, command: 'echo 2' } },
    { label: 'command parser', before: command, after: { ...command, parse: 'text' } },
    { label: 'command interval', before: command, after: { ...command, intervalSec: 60 } },
    { label: 'command timeout', before: command, after: { ...command, timeoutMs: 8000 } },
    { label: 'source kind', before: http, after: command },
  ]

  it.each(edits)('invalidates only the changed source after editing $label', ({ before, after }) => {
    const metric = point(1, at)
    const other = point(10, at)
    const oldPanel = { ...view({ metric: [metric], other: [other] }), definition: definition([before, source('other')]) }
    emitPanels(oldPanel)
    const replacement = point(2, '2026-10-23T07:05:00.000Z')
    emitPanels({ ...oldPanel, definition: definition([source('other'), after]), history: { metric: [replacement] } })
    expect(client.historyOf('p_1', 'metric')).toEqual([replacement])
    expect(client.historyOf('p_1', 'other')).toEqual([other])
  })

  it('preserves history across presentation edits, source order and canonical HTTP defaults', () => {
    const metric = point(1, at)
    const other = point(10, at)
    const initial: PanelSource = { id: 'metric', kind: 'http', url: 'https://example.com', headers: http.headers, parse: 'json', intervalSec: 30 }
    const panel = { ...view({ metric: [metric], other: [other] }), definition: definition([initial, source('other')]) }
    emitPanels(panel)
    emitPanels({
      ...panel, version: 2, history: {},
      definition: { ...panel.definition, title: 'renamed', css: 'p { color: red }', sources: [
        source('other'), { ...initial, method: 'GET', headers: { accept: 'application/json', authorization: 'token' } },
      ] },
    })
    expect(client.historiesOf('p_1')).toEqual({ metric: [metric], other: [other] })

    emitPanels(view({ metric: [metric] }))
    emitPanels({ ...view({}), definition: definition([{ ...source('metric'), method: 'GET', headers: {} }]) })
    expect(client.historyOf('p_1', 'metric')).toEqual([metric])
  })

  it('drops removed sources and ignores their stale history and readings until re-added', () => {
    const metric = point(1, at)
    const other = point(10, at)
    const panel = { ...view({ metric: [metric], other: [other] }), definition: definition([source('metric'), source('other')]) }
    emitPanels(panel)
    emitPanels({ ...panel, definition: definition([source('other')]), data: data({ metric: { ok: true, value: 2, at } }) })
    emitReading(3, '2026-10-23T07:05:00.000Z')
    expect(client.historiesOf('p_1')).toEqual({ other: [other] })
    emitPanels({ ...panel, history: {} })
    expect(client.historyOf('p_1', 'metric')).toEqual([])
    emitReading(4, '2026-10-23T07:10:00.000Z')
    expect(client.historyOf('p_1', 'metric').map(entry => entry.value)).toEqual([4])
  })

  it('forgets deleted panels and rejects late readings before the same id is re-added', () => {
    emitPanels(view({ metric: [point(1, at)] }))
    emitPanels()
    emitReading(2, at)
    expect(client.historiesOf('p_1')).toEqual({})
    emitPanels(view({}))
    expect(client.historiesOf('p_1')).toEqual({})
  })

  it('replaces values at an existing timestamp, including one behind the newest point', () => {
    const newer = point(3, '2026-10-23T07:10:00.000Z')
    emitPanels(view({ metric: [point(1, at), newer] }))
    emitReading(30, newer.at)
    emitReading(10, at)
    expect(client.historyOf('p_1', 'metric')).toEqual([point(10, at), point(30, newer.at)])
  })

  it('keeps snapshot merges and stale current readings ordered inside the retained window', () => {
    const a = point(1, at)
    const b = point(2, '2026-10-23T07:05:00.000Z')
    const c = point(3, '2026-10-23T07:10:00.000Z')
    emitPanels(view({ metric: [a] }))
    emitPanels({ ...view({ metric: [c, a, b] }), data: data({ metric: { ok: true, ...b } }) })
    expect(client.historyOf('p_1', 'metric')).toEqual([a, b, c])
    emitPanels({ ...view({ metric: [point(0, '2026-10-23T06:55:00.000Z')] }), data: data({ metric: { ok: true, value: 0, at: '2026-10-23T06:55:00.000Z' } }) })
    expect(client.historyOf('p_1', 'metric')).toEqual([a, b, c])
  })

  it('keeps only the latest 120 live points and does not revive evicted readings', () => {
    const points = Array.from({ length: HISTORY_LIMIT + 2 }, (_, index) =>
      point(index, new Date(Date.UTC(2026, 9, 23, 0, index)).toISOString()))
    emitPanels(view({}))
    for (const entry of points) emitReading(entry.value as number, entry.at)
    const old = points[0]!
    emitPanels({ ...view({ metric: [old] }), data: data({ metric: { ok: true, ...old } }) })
    expect(client.historyOf('p_1', 'metric')).toEqual(points.slice(2))
  })

  it('ignores failed, absent-value and invalid-timestamp readings', () => {
    emitPanels(view({ metric: [point(1, at)] }))
    const stream = latestStream()
    for (const reading of [
      { ok: false, value: 2, at },
      { ok: true, at },
      { ok: true, value: 2, at: 'not a date' },
    ]) stream.emit({ type: 'data', panelId: 'p_1', data: data({ metric: reading }) })
    expect(client.historyOf('p_1', 'metric')).toEqual([point(1, at)])
  })
})

describe('stream setup recovery', () => {
  it('shows the setup error and clears it when a retry opens', async () => {
    vi.useFakeTimers()
    let attempts = 0
    let stream: { onopen: (() => void) | null } | undefined
    vi.stubGlobal('EventSource', class {
      onopen: (() => void) | null = null
      constructor() { attempts++; if (attempts === 1) throw new Error('temporarily blocked'); stream = this }
      close(): void {}
    })
    const client = new PadClient()
    try {
      expect(() => client.start()).not.toThrow()
      expect(client.getSnapshot().connectionError).toBe('temporarily blocked')
      await vi.advanceTimersByTimeAsync(3000)
      expect(attempts).toBe(2)
      stream?.onopen?.()
      expect(client.getSnapshot().connectionError).toBeUndefined()
      expect(client.getSnapshot().connected).toBe(true)
    } finally { client.stop(); vi.unstubAllGlobals(); vi.useRealTimers() }
  })

  it('cancels a pending retry when the plugin stops', async () => {
    vi.useFakeTimers()
    const construct = vi.fn(() => { throw new Error('blocked') })
    vi.stubGlobal('EventSource', class { constructor() { construct() } })
    const client = new PadClient()
    try {
      client.start()
      client.stop()
      await vi.advanceTimersByTimeAsync(9000)
      expect(construct).toHaveBeenCalledOnce()
    } finally { client.stop(); vi.unstubAllGlobals(); vi.useRealTimers() }
  })
})

describe('stream terminal-error recovery', () => {
  let client: PadClient

  beforeEach(() => {
    vi.useFakeTimers()
    FakeEventSource.instances = []
    vi.stubGlobal('EventSource', FakeEventSource)
    client = new PadClient()
    client.start()
  })

  afterEach(() => { client.stop(); vi.unstubAllGlobals(); vi.useRealTimers() })

  it('replaces a CLOSED stream after one three-second retry even when the watch set is unchanged', async () => {
    emitPanels(view({}))
    client.setLayout({ expanded: true })
    const stream = latestStream()
    const count = FakeEventSource.instances.length
    stream.onopen?.()
    stream.readyState = 2
    stream.onerror?.()
    stream.onerror?.()
    expect(stream.close).toHaveBeenCalledOnce()
    expect(client.getSnapshot().connected).toBe(false)
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(2999)
    expect(FakeEventSource.instances).toHaveLength(count)
    await vi.advanceTimersByTimeAsync(1)
    expect(FakeEventSource.instances).toHaveLength(count + 1)
    expect(latestStream().url).toBe(stream.url)
    expect(latestStream().url).toContain('watch=p_1')
    latestStream().onopen?.()
    expect(client.getSnapshot().connected).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('leaves CONNECTING errors to native reconnection without an extra timer', async () => {
    const stream = latestStream()
    stream.onopen?.()
    stream.readyState = 0
    stream.onerror?.()
    stream.onerror?.()
    client.setLayout({ expanded: true })
    expect(client.getSnapshot().connected).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(9000)
    expect(FakeEventSource.instances).toHaveLength(1)
    expect(stream.close).not.toHaveBeenCalled()
    stream.onopen?.()
    expect(client.getSnapshot().connected).toBe(true)
  })

  it('cancels terminal-error retries on stop and ignores callbacks from the stopped stream', async () => {
    const stream = latestStream()
    stream.readyState = 2
    stream.onerror?.()
    client.stop()
    const stopped = client.getSnapshot()
    stream.onopen?.()
    stream.onerror?.()
    stream.emit({ type: 'panels', panels: [view({ metric: [point(99, '2026-10-23T07:00:00.000Z')] })] })
    await vi.advanceTimersByTimeAsync(9000)
    expect(FakeEventSource.instances).toHaveLength(1)
    expect(client.getSnapshot()).toBe(stopped)
    expect(client.historiesOf('p_1')).toEqual({})
    expect(vi.getTimerCount()).toBe(0)
  })

  it('ignores a retired stream after a watch change, including across stop and start', async () => {
    emitPanels(view({}))
    const retired = latestStream()
    client.setLayout({ expanded: true })
    const current = latestStream()
    const count = FakeEventSource.instances.length
    const snapshot = client.getSnapshot()
    retired.onerror?.()
    retired.onopen?.()
    retired.emit({ type: 'panels', panels: [] })
    expect(client.getSnapshot()).toBe(snapshot)
    expect(current.close).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    client.stop()
    client.start()
    current.onerror?.()
    current.onopen?.()
    await vi.advanceTimersByTimeAsync(9000)
    expect(FakeEventSource.instances).toHaveLength(count + 1)
    expect(client.getSnapshot()).toBe(snapshot)
  })

  it('retains the last valid snapshot when a malformed reading arrives, then accepts valid data', () => {
    emitPanels(view({}))
    const snapshot = client.getSnapshot()
    const bad = { sources: { unexpected: null }, agent: null }
    latestStream().onmessage?.({ data: JSON.stringify({ type: 'data', panelId: 'p_1', data: bad }) })
    expect(client.getSnapshot()).toBe(snapshot)
    latestStream().onmessage?.({ data: JSON.stringify({ type: 'panels', panels: [{ ...view({}), data: bad }] }) })
    expect(client.getSnapshot()).toBe(snapshot)
    emitReading(42, '2026-10-31T12:00:00.000Z')
    expect(client.getSnapshot().panels[0]?.data.sources['metric']?.value).toBe(42)
  })

  it('cancels a pending retry when a layout change already opens a replacement', async () => {
    const stream = latestStream()
    stream.readyState = 2
    stream.onerror?.()
    client.setLayout({ expanded: true })
    expect(FakeEventSource.instances).toHaveLength(2)
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(9000)
    expect(FakeEventSource.instances).toHaveLength(2)
  })
})

describe('visibility-aware source subscriptions', () => {
  it('pauses watched sources while hidden and resumes without losing panels', () => {
    const target = new EventTarget()
    const documentStub = { visibilityState: 'visible', addEventListener: target.addEventListener.bind(target), removeEventListener: target.removeEventListener.bind(target) }
    vi.stubGlobal('document', documentStub)
    const streams: { url: string, close: ReturnType<typeof vi.fn>, onmessage?: (event: { data: string }) => void }[] = []
    vi.stubGlobal('EventSource', class {
      close = vi.fn()
      constructor(readonly url: string) { streams.push(this) }
    })
    const client = new PadClient()
    try {
      client.setLayout({ expanded: true })
      client.start()
      streams.at(-1)!.onmessage?.({ data: JSON.stringify({ type: 'panels', panels: [view({})] }) })
      expect(streams.at(-1)!.url).toContain('watch=p_1')
      documentStub.visibilityState = 'hidden'
      target.dispatchEvent(new Event('visibilitychange'))
      expect(streams.at(-1)!.url).toContain('watch=')
      expect(streams.at(-1)!.url).not.toContain('p_1')
      expect(client.getSnapshot().panels).toHaveLength(1)
      documentStub.visibilityState = 'visible'
      target.dispatchEvent(new Event('visibilitychange'))
      expect(streams.at(-1)!.url).toContain('watch=p_1')
      client.stop()
      const count = streams.length
      target.dispatchEvent(new Event('visibilitychange'))
      expect(streams).toHaveLength(count)
    } finally { client.stop(); vi.unstubAllGlobals() }
  })
})

describe('focused frame source subscriptions', () => {
  let client: PadClient
  let documentStub: { visibilityState: string, addEventListener: EventTarget['addEventListener'], removeEventListener: EventTarget['removeEventListener'] }
  let visibility: EventTarget
  const watched = (): string[] => new URL(latestStream().url, 'https://test.invalid/').searchParams.get('watch')!.split(',').filter(Boolean)

  beforeEach(() => {
    FakeEventSource.instances = []
    vi.stubGlobal('EventSource', FakeEventSource)
    visibility = new EventTarget()
    documentStub = { visibilityState: 'visible', addEventListener: visibility.addEventListener.bind(visibility), removeEventListener: visibility.removeEventListener.bind(visibility) }
    vi.stubGlobal('document', documentStub)
    client = new PadClient()
    client.setLayout({ expanded: true })
    client.start()
    emitPanels({ ...view({}), collapsed: true })
  })
  afterEach(() => { client.stop(); vi.unstubAllGlobals() })

  it('polls a folded panel while focused and releases it without changing its fold preference', () => {
    expect(watched()).toEqual([])
    const release = client.watchPanel('p_1')
    expect(watched()).toEqual(['p_1'])
    expect(client.getSnapshot().panels[0]?.collapsed).toBe(true)
    release()
    expect(watched()).toEqual([])
    const count = FakeEventSource.instances.length
    release()
    expect(FakeEventSource.instances).toHaveLength(count)
  })

  it('retains another focus owner and never duplicates the same watched id', () => {
    const a = client.watchPanel('p_1'), b = client.watchPanel('p_1')
    expect(watched()).toEqual(['p_1'])
    a()
    expect(watched()).toEqual(['p_1'])
    b()
    expect(watched()).toEqual([])
  })

  it('pauses a focused panel when the page or dock hides and restores it only while still owned', () => {
    const release = client.watchPanel('p_1')
    documentStub.visibilityState = 'hidden'
    visibility.dispatchEvent(new Event('visibilitychange'))
    expect(watched()).toEqual([])
    documentStub.visibilityState = 'visible'
    visibility.dispatchEvent(new Event('visibilitychange'))
    expect(watched()).toEqual(['p_1'])
    client.setLayout({ expanded: false })
    expect(watched()).toEqual([])
    release()
    client.setLayout({ expanded: true })
    expect(watched()).toEqual([])
  })

  it('does not watch deleted or unknown panels and stops reconnecting after shutdown', () => {
    const releaseUnknown = client.watchPanel('p_missing')
    expect(watched()).toEqual([])
    const release = client.watchPanel('p_1')
    emitPanels()
    expect(watched()).toEqual([])
    client.stop()
    const count = FakeEventSource.instances.length
    release(); releaseUnknown()
    expect(FakeEventSource.instances).toHaveLength(count)
  })
})

describe('layout commits use the latest panel set', () => {
  let client: PadClient
  const panel = (id: string): PanelView => ({ ...view({}), id })
  const initial: LayoutNode = { kind: 'split', dir: 'row', children: [{ kind: 'leaf', id: 'a' }, { kind: 'leaf', id: 'b' }], weights: [1, 1] }
  beforeEach(() => {
    FakeEventSource.instances = []
    vi.stubGlobal('EventSource', FakeEventSource)
    client = new PadClient(); client.start()
    emitPanels(panel('a'), panel('b'))
    client.setTree(initial)
  })
  afterEach(() => { client.stop(); vi.unstubAllGlobals() })

  it('keeps a panel created after a splitter captured its base tree', () => {
    emitPanels(panel('a'), panel('b'), panel('c'))
    const result = client.setTree(initial)
    expect(leafIds(result)).toEqual(['a', 'b', 'c'])
    expect(client.getSnapshot().layout.tree).toBe(result)
  })

  it('drops panels removed during a gesture and appends new ones exactly once on a card drop', () => {
    const pending = dropOnLeaf(initial, 'b', 'a', 'right')
    emitPanels(panel('a'), panel('c'))
    const result = client.setTree(pending)
    expect(leafIds(result)).toEqual(['a', 'c'])
  })

  it('clears the tree when all panels disappear while a gesture is held', () => {
    emitPanels()
    expect(client.setTree(initial)).toBeNull()
    expect(client.getSnapshot().layout.tree).toBeNull()
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

  it('persists the attached edge and preserves a deliberately free ball', () => {
    expect(normalizeDockLayout({ ballEdge: 'right' }).ballEdge).toBe('right')
    expect(normalizeDockLayout({ ballEdge: null }).ballEdge).toBeNull()
    expect(normalizeDockLayout({ ballEdge: 'invalid' }).ballEdge).toBeUndefined()
    expect(normalizeDockLayout({}).ballEdge).toBeUndefined()
  })

  it('restores an edge control after its window is moved', () => {
    const dockControl = { edge: 'left', point: { x: 0, y: 80 } }
    expect(normalizeDockLayout({ dockControl }).dockControl).toEqual(dockControl)
    expect(normalizeDockLayout({ dockControl: null }).dockControl).toBeUndefined()
    expect(normalizeDockLayout({ dockControl: { edge: 'invalid', point: { x: 0, y: 80 } } }).dockControl).toBeUndefined()
    expect(normalizeDockLayout({ dockControl: { edge: 'left', point: { x: NaN, y: 80 } } }).dockControl).toBeUndefined()
  })

  it('retains the constrained width of a moved edge dock across persistence', () => {
    const dockControl = { edge: 'top', point: { x: 251, y: 0 } }
    const layout = normalizeDockLayout({ width: 279, dock: { x: 1, y: 10 }, dockControl })
    expect(layout.width).toBe(279)
    expect(normalizeDockLayout(JSON.parse(JSON.stringify(layout))).width).toBe(279)
    expect(normalizeDockLayout({ width: 1, dockControl }).width).toBe(BALL_SIZE)
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
