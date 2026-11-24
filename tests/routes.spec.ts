import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate as nextEventLoopTurn } from 'node:timers/promises'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DataHub, type Subscriber } from '../src/host/hub.ts'
import { MAX_SSE_QUEUED_BYTES, registerRoutes, SSE_STALL_MS } from '../src/host/routes.ts'
import { PanelStore } from '../src/host/store.ts'
import { ROUTES, type Json, type PanelView, type StreamEvent } from '../src/shared/types.ts'

const cleanups: (() => void)[] = []
const tempDirs: string[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
  vi.useRealTimers()
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function setup(options: { allowPrivateHttp?: boolean, maxSseStreams?: number } = {}) {
  const routes = new Map<string, (request: Request) => Promise<Response>>()
  const ctx = {
    effect: (fn: () => unknown) => {
      const cleanup = fn()
      if (typeof cleanup === 'function') cleanups.push(cleanup as () => void)
    },
    get: () => undefined,
    connection: { fetch: { register: (entry: { path: string, fetch: (request: Request) => Promise<Response> }) => {
      routes.set(entry.path, entry.fetch)
      return () => routes.delete(entry.path)
    } } },
  } as unknown as Context
  const dir = await mkdtemp(join(tmpdir(), 'dsh-pad-routes-'))
  tempDirs.push(dir)
  const store = new PanelStore(join(dir, 'panels.json'))
  const hub = new DataHub(store, async () => undefined, () => {}, { allowPrivateHttp: options.allowPrivateHttp })
  cleanups.push(() => hub.dispose())
  registerRoutes({ ctx, store, hub, refresher: undefined, maxSseStreams: options.maxSseStreams })
  return { routes, hub, store }
}

describe('SSE subscription lifetime', () => {
  it('does not subscribe or keep a heartbeat for an already aborted request', async () => {
    vi.useFakeTimers()
    const { routes, hub } = await setup()
    const subscribe = vi.spyOn(hub, 'subscribe')
    const controller = new AbortController()
    controller.abort()
    const response = await routes.get(ROUTES.stream)!(new Request('http://local' + ROUTES.stream, { signal: controller.signal }))
    expect(subscribe).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    await response.body!.cancel()
  })

  it('unsubscribes and clears the heartbeat on abort and on body cancellation', async () => {
    vi.useFakeTimers()
    const { routes, hub } = await setup()
    const unsubscribes: ReturnType<typeof vi.fn>[] = []
    const original = hub.subscribe.bind(hub)
    vi.spyOn(hub, 'subscribe').mockImplementation(subscriber => {
      const unsubscribe = vi.fn(original(subscriber))
      unsubscribes.push(unsubscribe)
      return unsubscribe
    })
    const controller = new AbortController()
    const response = await routes.get(ROUTES.stream)!(new Request('http://local' + ROUTES.stream, { signal: controller.signal }))
    expect(vi.getTimerCount()).toBe(2)
    controller.abort()
    expect(unsubscribes[0]).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
    await response.body!.cancel()
    expect(unsubscribes[0]).toHaveBeenCalledTimes(1)

    const second = await routes.get(ROUTES.stream)!(new Request('http://local' + ROUTES.stream))
    expect(vi.getTimerCount()).toBe(2)
    await second.body!.cancel()
    expect(unsubscribes[1]).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('turns a real deep HTTP source into a serializable failure and keeps polling', async () => {
    const { routes, hub, store } = await setup({ allowPrivateHttp: true })
    const server = createServer((_req, res) => {
      res.setHeader('connection', 'close')
      res.end('['.repeat(10_000) + '1' + ']'.repeat(10_000))
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const panel = await store.create({ title: 'Deep fixture', html: '', css: '', script: '', height: 'auto', sources: [{ id: 'fixture', kind: 'http', url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, parse: 'json', intervalSec: 60 }] })
    const response = await routes.get(ROUTES.stream)!(new Request('http://local' + ROUTES.stream + '?watch=' + panel.id))
    const reader = response.body!.getReader()
    try {
      await reader.read() // retry
      await reader.read() // initial snapshot
      const first = new TextDecoder().decode((await reader.read()).value)
      expect(first).toContain('JSON 嵌套超过')
      expect(first).toContain('"ok":false')
      const list = await routes.get(ROUTES.panels)!(new Request('http://local' + ROUTES.panels))
      expect((await list.json()).panels[0].data.sources.fixture.ok).toBe(false)
      const next = reader.read()
      hub.refresh(panel.id)
      expect(new TextDecoder().decode((await next).value)).toContain('JSON 嵌套超过')
    } finally {
      await reader.cancel()
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
      // Let the client-side socket/undici teardown finish before the next test
      // replaces global timers; otherwise it can schedule into that fake clock.
      await nextEventLoopTurn()
    }
  })

  it('coalesces unread updates per panel and retains only the latest values', async () => {
    vi.useFakeTimers()
    const timeouts = vi.spyOn(globalThis, 'setTimeout')
    const intervals = vi.spyOn(globalThis, 'setInterval')
    const clearTimeouts = vi.spyOn(globalThis, 'clearTimeout')
    const clearIntervals = vi.spyOn(globalThis, 'clearInterval')
    const { routes, hub } = await setup()
    let subscriber!: Subscriber
    const unsubscribe = vi.fn()
    vi.spyOn(hub, 'subscribe').mockImplementation(next => {
      subscriber = next
      next.send({ type: 'panels', panels: [] })
      return unsubscribe
    })
    const response = await routes.get(ROUTES.stream)!(new Request('http://local' + ROUTES.stream))
    const event = (panelId: string, value: Json): StreamEvent => ({ type: 'data', panelId, data: { sources: { fixture: { ok: true, value, at: '2026-10-31T00:00:00Z' } }, agent: null } })
    for (let index = 0; index < 64; index++) subscriber.send(event('p_a', { index, payload: 'x'.repeat(64 * 1024) }))
    subscriber.send(event('p_b', 'other panel'))
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    const text: string[] = []
    for (let index = 0; index < 4; index++) text.push(decoder.decode((await reader.read()).value))
    expect(text[0]).toContain('retry:')
    expect(text[1]).toContain('"panels"')
    expect(text[2]).toContain('"index":63')
    expect(text[2]).not.toContain('"index":62')
    expect(text[3]).toContain('other panel')
    expect(unsubscribe).not.toHaveBeenCalled()
    await reader.cancel()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
    const stalls = timeouts.mock.calls.flatMap((call, index) => call[1] === SSE_STALL_MS ? [timeouts.mock.results[index]!.value] : [])
    const heartbeats = intervals.mock.calls.flatMap((call, index) => call[1] === 20_000 ? [intervals.mock.results[index]!.value] : [])
    expect(stalls.length).toBeGreaterThan(0)
    expect(heartbeats).toHaveLength(1)
    for (const timer of stalls) expect(clearTimeouts).toHaveBeenCalledWith(timer)
    for (const timer of heartbeats) expect(clearIntervals).toHaveBeenCalledWith(timer)
    const remaining = vi.getTimerCount()
    if (remaining !== 0) {
      // Safe CI diagnostic: only duration and callback code, never event data.
      console.info('coalescing timer callbacks', {
        timeouts: timeouts.mock.calls.map(([callback, ms]) => ({ ms, callback: String(callback).slice(0, 80) })),
        intervals: intervals.mock.calls.map(([callback, ms]) => ({ ms, callback: String(callback).slice(0, 80) })),
      })
    }
    timeouts.mockRestore()
    intervals.mockRestore()
    clearTimeouts.mockRestore()
    clearIntervals.mockRestore()
    expect(remaining).toBe(0)
  })

  it('disconnects a stalled consumer even when repeated data can be coalesced', async () => {
    vi.useFakeTimers()
    const { routes, hub } = await setup()
    let subscriber!: Subscriber
    const unsubscribe = vi.fn()
    vi.spyOn(hub, 'subscribe').mockImplementation(next => { subscriber = next; return unsubscribe })
    const response = await routes.get(ROUTES.stream)!(new Request('http://local' + ROUTES.stream))
    const event: StreamEvent = { type: 'data', panelId: 'p_a', data: { sources: {}, agent: null } }
    subscriber.send(event)
    await vi.advanceTimersByTimeAsync(SSE_STALL_MS - 1)
    subscriber.send(event) // New producer activity must not extend the reader deadline.
    expect(unsubscribe).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(unsubscribe).toHaveBeenCalledTimes(1)
    const reader = response.body!.getReader()
    await expect(reader.read()).rejects.toThrow(/消费过慢/)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('releases a stream when distinct queued panel updates exceed its byte limit', async () => {
    vi.useFakeTimers()
    const { routes, hub } = await setup()
    let subscriber!: Subscriber
    const unsubscribe = vi.fn()
    vi.spyOn(hub, 'subscribe').mockImplementation(next => { subscriber = next; return unsubscribe })
    const response = await routes.get(ROUTES.stream)!(new Request('http://local' + ROUTES.stream))
    const value = 'x'.repeat(512 * 1024)
    for (let index = 0; index <= MAX_SSE_QUEUED_BYTES / value.length; index++) {
      subscriber.send({ type: 'data', panelId: `p_${index}`, data: { sources: { fixture: { ok: true, value, at: '2026-10-31T00:00:00Z' } }, agent: null } })
    }
    expect(unsubscribe).toHaveBeenCalledTimes(1)
    await expect(response.body!.getReader().read()).rejects.toThrow(/积压超过/)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('rejects a single oversized initial snapshot and permits a later healthy subscription', async () => {
    vi.useFakeTimers()
    const { routes, hub } = await setup()
    const unsubscribe = vi.fn()
    const subscribe = vi.spyOn(hub, 'subscribe').mockImplementation(next => {
      const panel: PanelView = { id: 'huge', version: 1, position: 0, collapsed: false, span: 1, updatedAt: '2026-10-31T00:00:00Z', definition: { title: 'Huge', html: '', css: '', script: '', height: 'auto', sources: [] }, canUndo: false, agentRun: null, data: { sources: { fixture: { ok: true, value: 'x'.repeat(MAX_SSE_QUEUED_BYTES), at: '2026-10-31T00:00:00Z' } }, agent: null }, history: {} }
      next.send({ type: 'panels', panels: [panel] })
      return unsubscribe
    })
    const response = await routes.get(ROUTES.stream)!(new Request('http://local' + ROUTES.stream))
    expect(unsubscribe).toHaveBeenCalledTimes(1)
    await expect(response.body!.getReader().read()).rejects.toThrow(/积压超过/)
    expect(vi.getTimerCount()).toBe(0)
    subscribe.mockRestore()
    const healthy = await routes.get(ROUTES.stream)!(new Request('http://local' + ROUTES.stream))
    const reader = healthy.body!.getReader()
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('retry:')
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('"panels"')
    await reader.cancel()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps a drained healthy stream open beyond the stall deadline', async () => {
    vi.useFakeTimers()
    const { routes } = await setup()
    const response = await routes.get(ROUTES.stream)!(new Request('http://local' + ROUTES.stream))
    const reader = response.body!.getReader()
    await reader.read()
    await reader.read()
    await Promise.resolve()
    expect(vi.getTimerCount()).toBe(1) // heartbeat only after the backlog is drained
    const ping = reader.read()
    await vi.advanceTimersByTimeAsync(20_000)
    expect(new TextDecoder().decode((await ping).value)).toContain(': ping')
    await vi.advanceTimersByTimeAsync(15_000)
    const next = reader.read()
    await vi.advanceTimersByTimeAsync(5_000)
    expect((await next).done).toBe(false)
    await reader.cancel()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('contains serialization failures within the offending stream', async () => {
    vi.useFakeTimers()
    const { routes, hub } = await setup()
    let subscriber!: Subscriber
    const unsubscribe = vi.fn()
    vi.spyOn(hub, 'subscribe').mockImplementation(next => { subscriber = next; return unsubscribe })
    const response = await routes.get(ROUTES.stream)!(new Request('http://local' + ROUTES.stream))
    const value = JSON.parse('['.repeat(10_000) + '1' + ']'.repeat(10_000)) as Json
    expect(() => subscriber.send({ type: 'data', panelId: 'p_a', data: { sources: { fixture: { ok: true, value, at: '2026-10-31T00:00:00Z' } }, agent: null } })).not.toThrow()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
    await expect(response.body!.getReader().read()).rejects.toThrow(/无法序列化/)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('closes open subscriptions when routes are unloaded', async () => {
    vi.useFakeTimers()
    const { routes } = await setup()
    const response = await routes.get(ROUTES.stream)!(new Request('http://local' + ROUTES.stream))
    expect(vi.getTimerCount()).toBe(2)
    for (const cleanup of cleanups.splice(0).reverse()) cleanup()
    expect(vi.getTimerCount()).toBe(0)
    await response.body!.cancel()
  })

  it('evicts the oldest SSE stream when concurrent connections exceed the cap', async () => {
    vi.useFakeTimers()
    const { routes } = await setup({ maxSseStreams: 2 })
    const first = await routes.get(ROUTES.stream)!(new Request('http://local' + ROUTES.stream))
    const second = await routes.get(ROUTES.stream)!(new Request('http://local' + ROUTES.stream))
    const third = await routes.get(ROUTES.stream)!(new Request('http://local' + ROUTES.stream))
    const firstReader = first.body!.getReader()
    // Drain whatever was enqueued before eviction, then expect stream closure.
    let closed = false
    for (let i = 0; i < 4; i += 1) {
      const next = await firstReader.read()
      if (next.done) { closed = true; break }
    }
    expect(closed).toBe(true)
    await second.body!.cancel()
    await third.body!.cancel()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('serializes a broadcast StreamEvent only once across multiple SSE subscribers', async () => {
    vi.useFakeTimers()
    const { routes, hub } = await setup()
    const subscribers: Subscriber[] = []
    vi.spyOn(hub, 'subscribe').mockImplementation(sub => {
      subscribers.push(sub)
      return () => {}
    })
    const a = await routes.get(ROUTES.stream)!(new Request('http://local' + ROUTES.stream))
    const b = await routes.get(ROUTES.stream)!(new Request('http://local' + ROUTES.stream))
    const stringify = vi.spyOn(JSON, 'stringify')
    const sharedEvent: StreamEvent = { type: 'data', panelId: 'p_1', data: { sources: {}, agent: null } }
    for (const sub of subscribers) sub.send(sharedEvent)
    expect(stringify).toHaveBeenCalledTimes(1)
    stringify.mockRestore()
    await a.body!.cancel()
    await b.body!.cancel()
  })

  it('trims oversized history from the initial SSE snapshot while preserving latest readings', async () => {
    vi.useFakeTimers()
    const { routes, hub } = await setup()
    const bigChunk = 'h'.repeat(1024 * 1024)
    const historyPoints = Array.from({ length: 10 }, (_, idx) => ({
      value: `${idx}:${bigChunk}`,
      at: `2026-10-31T00:0${idx}:00Z`,
    }))
    const panel: PanelView = {
      id: 'p_hist',
      version: 1,
      position: 0,
      collapsed: false,
      span: 1,
      updatedAt: '2026-10-31T00:10:00Z',
      definition: { title: 'Hist', html: '', css: '', script: '', height: 'auto', sources: [] },
      canUndo: false,
      agentRun: null,
      data: { sources: { s: { ok: true, value: 'latest-reading', at: '2026-10-31T00:10:00Z' } }, agent: null },
      history: { s: historyPoints },
    }
    vi.spyOn(hub, 'subscribe').mockImplementation(next => {
      next.send({ type: 'panels', panels: [panel] })
      return () => {}
    })
    const response = await routes.get(ROUTES.stream)!(new Request('http://local' + ROUTES.stream))
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    expect(decoder.decode((await reader.read()).value)).toContain('retry:')
    const snapshotChunk = (await reader.read()).value!
    expect(snapshotChunk.byteLength).toBeLessThanOrEqual(MAX_SSE_QUEUED_BYTES)
    const payload = JSON.parse(decoder.decode(snapshotChunk).replace(/^data: /, '').trim()) as {
      type: 'panels'
      panels: PanelView[]
    }
    expect(payload.panels[0]?.data.sources['s']?.value).toBe('latest-reading')
    const kept = payload.panels[0]?.history['s'] ?? []
    expect(kept.length).toBeGreaterThan(0)
    expect(kept.length).toBeLessThan(historyPoints.length)
    expect(String(kept.at(-1)?.value).startsWith('9:')).toBe(true)
    await reader.cancel()
  })
})
