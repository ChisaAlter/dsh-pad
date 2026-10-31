import { mkdtemp } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DataHub, type Subscriber } from '../src/host/hub.ts'
import { MAX_SSE_QUEUED_BYTES, registerRoutes, SSE_STALL_MS } from '../src/host/routes.ts'
import { PanelStore } from '../src/host/store.ts'
import { ROUTES, type Json, type PanelView, type StreamEvent } from '../src/shared/types.ts'

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
  vi.useRealTimers()
})

async function setup() {
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
  const store = new PanelStore(join(await mkdtemp(join(tmpdir(), 'dsh-pad-routes-')), 'panels.json'))
  const hub = new DataHub(store, async () => undefined, () => {})
  cleanups.push(() => hub.dispose())
  registerRoutes({ ctx, store, hub, refresher: undefined })
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
    const { routes, hub, store } = await setup()
    const server = createServer((_req, res) => { res.end('['.repeat(10_000) + '1' + ']'.repeat(10_000)) })
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
    }
  })

  it('coalesces unread updates per panel and retains only the latest values', async () => {
    vi.useFakeTimers()
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
    expect(vi.getTimerCount()).toBe(0)
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
})
