import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DataHub } from '../src/host/hub.ts'
import { registerRoutes } from '../src/host/routes.ts'
import { PanelStore } from '../src/host/store.ts'
import { ROUTES } from '../src/shared/types.ts'

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
  const store = new PanelStore(join(await mkdtemp(join(tmpdir(), 'dsh-pad-routes-')), 'panels.json'), false)
  const hub = new DataHub(store, async () => undefined, () => {})
  cleanups.push(() => hub.dispose())
  registerRoutes({ ctx, store, hub, refresher: undefined })
  return { routes, hub }
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
    expect(vi.getTimerCount()).toBe(1)
    controller.abort()
    expect(unsubscribes[0]).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
    await response.body!.cancel()
    expect(unsubscribes[0]).toHaveBeenCalledTimes(1)

    const second = await routes.get(ROUTES.stream)!(new Request('http://local' + ROUTES.stream))
    expect(vi.getTimerCount()).toBe(1)
    await second.body!.cancel()
    expect(unsubscribes[1]).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('closes open subscriptions when routes are unloaded', async () => {
    vi.useFakeTimers()
    const { routes } = await setup()
    const response = await routes.get(ROUTES.stream)!(new Request('http://local' + ROUTES.stream))
    expect(vi.getTimerCount()).toBe(1)
    for (const cleanup of cleanups.splice(0).reverse()) cleanup()
    expect(vi.getTimerCount()).toBe(0)
    await response.body!.cancel()
  })
})
