import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DataHub, type Subscriber } from '../src/host/hub.ts'
import { ReadingCache } from '../src/host/readings.ts'
import { runSource } from '../src/host/sources.ts'
import { PanelStore } from '../src/host/store.ts'
import type { PanelDefinition, PanelSource, SourceReading, StreamEvent } from '../src/shared/types.ts'

vi.mock('../src/host/sources.ts', () => ({ runSource: vi.fn() }))

const source = (id = 'a', command = 'echo old', intervalSec = 10): PanelSource => ({
  id, kind: 'command', command, parse: 'text', intervalSec,
})

const definition = (...sources: PanelSource[]): PanelDefinition => ({
  title: 'T', html: '', css: '', script: '', height: 'auto', sources,
})

const reading = (value: string, ok = true): SourceReading => ({
  ok, ...(ok ? { value } : { error: value }), at: new Date().toISOString(),
})

interface PendingRun {
  source: PanelSource
  signal: AbortSignal | undefined
  resolve: (reading: SourceReading) => void
}

let pending: PendingRun[]
let hubs: DataHub[]

beforeEach(() => {
  vi.useFakeTimers()
  pending = []
  hubs = []
  vi.mocked(runSource).mockReset().mockImplementation((source, _resolve, signal) => new Promise(resolve => {
    // Keep even aborted runs pending to exercise late completions.
    pending.push({ source, signal, resolve })
  }))
})

afterEach(async () => {
  for (const hub of hubs) hub.dispose()
  for (const run of pending) run.resolve(reading('cleanup'))
  await Promise.resolve()
  vi.useRealTimers()
})

async function setup(sources = [source()], withCache = false) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-pad-concurrency-'))
  const store = new PanelStore(join(directory, 'panels.json'))
  const panel = await store.create(definition(...sources))
  const cache = withCache ? new ReadingCache(join(directory, 'readings.json')) : undefined
  const hub = new DataHub(store, async () => undefined, () => {}, { cache })
  hubs.push(hub)
  store.onChange(() => hub.storeChanged())
  const events: StreamEvent[] = []
  const subscriber: Subscriber = { watch: new Set(), send: event => events.push(event) }
  hub.subscribe(subscriber)
  const dataEvents = () => events.filter(event => event.type === 'data')
  return { store, panel, cache, hub, subscriber, events, dataEvents }
}

describe('DataHub source concurrency', () => {
  it('isolates a failed subscriber without rejecting readings or blocking healthy pages', async () => {
    const { hub, panel, subscriber, dataEvents } = await setup()
    hub.rewatch(subscriber, new Set([panel.id]))
    const close = vi.fn()
    const send = vi.fn((event: StreamEvent) => { if (event.type === 'data') throw new Error('broken transport') })
    hub.subscribe({ watch: new Set([panel.id]), send, close })
    const first = hub.runAll(panel.id)
    pending[0]!.resolve(reading('first'))
    expect(await first).toEqual([expect.objectContaining({ value: 'first' })])
    expect(close).toHaveBeenCalledTimes(1)
    expect(dataEvents()).toHaveLength(1)
    const second = hub.runAll(panel.id)
    pending[1]!.resolve(reading('second'))
    await second
    expect(dataEvents()).toHaveLength(2)
    expect(send).toHaveBeenCalledTimes(2) // initial panels + one failing data
  })

  it('releases a subscriber that fails on its initial snapshot', async () => {
    const { hub, panel } = await setup()
    const close = vi.fn(() => { throw new Error('already closed') })
    expect(() => hub.subscribe({ watch: new Set([panel.id]), send: () => { throw new Error('snapshot') }, close })).not.toThrow()
    expect(close).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('rearms polling after a rejected source run and catches hidden refresh failures', async () => {
    const { hub, panel, subscriber, dataEvents } = await setup()
    vi.mocked(runSource).mockRejectedValueOnce(new Error('unexpected runner failure'))
    hub.rewatch(subscriber, new Set([panel.id]))
    await vi.advanceTimersByTimeAsync(0)
    expect(runSource).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(runSource).toHaveBeenCalledTimes(2)
    const retry = hub.runAll(panel.id)
    pending[0]!.resolve(reading('recovered'))
    await retry
    expect(dataEvents()).toHaveLength(1)
    hub.rewatch(subscriber, new Set())
    vi.mocked(runSource).mockRejectedValueOnce(new Error('manual failure'))
    hub.refresh(panel.id)
    await vi.advanceTimersByTimeAsync(0)
    const next = hub.runAll(panel.id)
    pending[1]!.resolve(reading('manual recovered'))
    expect(await next).toEqual([expect.objectContaining({ value: 'manual recovered' })])
  })

  it('runs a panel\'s sources through runAll with no approval step', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-pad-sources-'))
    const store = new PanelStore(join(directory, 'panels.json'))
    const panel = await store.create(definition(source()))
    const hub = new DataHub(store, async () => undefined, () => {})
    hubs.push(hub)
    const result = hub.runAll(panel.id)
    expect(runSource).toHaveBeenCalledTimes(1)
    pending[0]!.resolve(reading('ran'))
    expect(await result).toEqual([expect.objectContaining({ id: 'a', ok: true, value: 'ran' })])
  })

  it('keeps an unchanged source running when another source is edited', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-pad-sources-'))
    const store = new PanelStore(join(directory, 'panels.json'))
    const panel = await store.create(definition(source('a'), source('b')))
    const cache = new ReadingCache(join(directory, 'readings.json'))
    const hub = new DataHub(store, async () => undefined, () => {}, { cache })
    hubs.push(hub)
    store.onChange(() => hub.storeChanged())
    const active = hub.runAll(panel.id)
    await store.update(panel.id, definition(source('a'), source('b', 'echo changed')))
    // Only the edited source is invalidated; a run of an unchanged source lives on.
    expect(pending[0]!.signal?.aborted).toBe(false)
    expect(pending[1]!.signal?.aborted).toBe(true)
    pending[0]!.resolve(reading('kept a'))
    pending[1]!.resolve(reading('stale b'))
    await active
    expect(hub.views()[0]?.data.sources).toEqual({ a: expect.objectContaining({ value: 'kept a' }) })
    expect(cache.history(panel.id)['a']?.map(point => point.value)).toEqual(['kept a'])
    expect(cache.history(panel.id)['b']).toBeUndefined()
    cache.dispose()
  })

  it('shares overlapping hidden refreshes and runAll calls, then allows another run', async () => {
    const { hub, panel, subscriber, dataEvents } = await setup()
    hub.refresh(panel.id)
    hub.refresh(panel.id)
    const first = hub.runAll(panel.id)
    const second = hub.runAll(panel.id)
    expect(runSource).toHaveBeenCalledTimes(1)
    let settled = false
    void second.then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)

    const fresh = reading('fresh')
    pending[0]!.resolve(fresh)
    expect(await first).toEqual([{ id: 'a', ...fresh }])
    expect(await second).toEqual([{ id: 'a', ...fresh }])
    expect(hub.views()[0]?.data.sources['a']).toEqual(fresh)
    expect(dataEvents()).toHaveLength(0)

    hub.rewatch(subscriber, new Set([panel.id]))
    const next = hub.runAll(panel.id)
    expect(runSource).toHaveBeenCalledTimes(2)
    const updated = reading('updated')
    pending[1]!.resolve(updated)
    expect(await next).toEqual([{ id: 'a', ...updated }])
    expect(dataEvents()).toHaveLength(1)
  })

  it('deduplicates each source independently within each panel', async () => {
    const { hub, store, panel } = await setup([source('a'), source('b')])
    const other = await store.create({ ...definition(source('a')), title: 'other' })
    const first = hub.runAll(panel.id)
    const otherRun = hub.runAll(other.id)
    expect(runSource).toHaveBeenCalledTimes(3)
    pending[0]!.resolve(reading('a1'))
    await Promise.resolve()
    await Promise.resolve()

    const again = hub.runAll(panel.id)
    expect(runSource).toHaveBeenCalledTimes(4)
    pending[1]!.resolve(reading('b1'))
    pending[2]!.resolve(reading('other'))
    pending[3]!.resolve(reading('a2'))
    expect((await first).map(result => result.value)).toEqual(['a1', 'b1'])
    expect((await again).map(result => result.value)).toEqual(['a2', 'b1'])
    expect((await otherRun)[0]?.value).toBe('other')
  })

  it('keeps an active poll across collapse/reopen and rearms only the current timer', async () => {
    const { hub, panel, subscriber, dataEvents } = await setup()
    hub.rewatch(subscriber, new Set([panel.id]))
    await vi.advanceTimersByTimeAsync(0)
    expect(runSource).toHaveBeenCalledTimes(1)
    hub.rewatch(subscriber, new Set())
    hub.refresh(panel.id)
    hub.rewatch(subscriber, new Set([panel.id]))
    await vi.advanceTimersByTimeAsync(0)
    expect(runSource).toHaveBeenCalledTimes(1)

    const joined = hub.runAll(panel.id)
    pending[0]!.resolve(reading('first'))
    await joined
    await vi.advanceTimersByTimeAsync(0)
    expect(dataEvents()).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(9_999)
    expect(runSource).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(runSource).toHaveBeenCalledTimes(2)
    const next = hub.runAll(panel.id)
    pending[1]!.resolve(reading('next'))
    await next
  })

  it('lets a scheduled tick join a still-running manual refresh', async () => {
    const { hub, panel, subscriber, dataEvents } = await setup()
    const initial = hub.runAll(panel.id)
    pending[0]!.resolve(reading('initial'))
    await initial
    hub.rewatch(subscriber, new Set([panel.id]))
    await vi.advanceTimersByTimeAsync(9_000)
    const manual = hub.runAll(panel.id)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(runSource).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
    pending[1]!.resolve(reading('joined'))
    await manual
    await vi.advanceTimersByTimeAsync(0)
    expect(dataEvents()).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(runSource).toHaveBeenCalledTimes(3)
    const next = hub.runAll(panel.id)
    pending[2]!.resolve(reading('next'))
    await next
  })

  it('keeps a scheduled tick due after an earlier manual refresh completes', async () => {
    const { hub, panel, subscriber } = await setup()
    const initial = hub.runAll(panel.id)
    pending[0]!.resolve(reading('initial'))
    await initial
    hub.rewatch(subscriber, new Set([panel.id]))
    await vi.advanceTimersByTimeAsync(4_000)
    const manual = hub.runAll(panel.id)
    await vi.advanceTimersByTimeAsync(1_000)
    pending[1]!.resolve(reading('manual'))
    await manual
    await vi.advanceTimersByTimeAsync(4_999)
    expect(runSource).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(runSource).toHaveBeenCalledTimes(3)

    const joined = hub.runAll(panel.id)
    hub.refresh(panel.id)
    expect(runSource).toHaveBeenCalledTimes(3)
    pending[2]!.resolve(reading('scheduled'))
    await joined
    await vi.advanceTimersByTimeAsync(0)
    expect(vi.getTimerCount()).toBe(1)
  })

  it('shares failure readings and releases the run so a later retry can execute', async () => {
    const { hub, panel } = await setup()
    const first = hub.runAll(panel.id)
    const joined = hub.runAll(panel.id)
    const failure = reading('HTTP 500', false)
    pending[0]!.resolve(failure)
    expect(await first).toEqual([{ id: 'a', ...failure }])
    expect(await joined).toEqual([{ id: 'a', ...failure }])
    const retry = hub.runAll(panel.id)
    expect(runSource).toHaveBeenCalledTimes(2)
    pending[1]!.resolve(reading('recovered'))
    expect((await retry)[0]?.ok).toBe(true)
  })

  it('shares an active run across non-source edits and equivalent source objects', async () => {
    const { hub, store, panel } = await setup()
    const first = hub.runAll(panel.id)
    await store.update(panel.id, { ...definition(source()), title: 'Restyled', css: 'body{}' })
    const joined = hub.runAll(panel.id)
    expect(runSource).toHaveBeenCalledTimes(1)
    expect(pending[0]!.signal?.aborted).toBe(false)
    const fresh = reading('fresh')
    pending[0]!.resolve(fresh)
    expect(await first).toEqual([{ id: 'a', ...fresh }])
    expect(await joined).toEqual([{ id: 'a', ...fresh }])
    expect(hub.views()[0]?.data.sources['a']).toEqual(fresh)
  })

  it('starts a changed fingerprint independently and ignores its old completion', async () => {
    const { hub, store, panel, subscriber, dataEvents } = await setup()
    hub.rewatch(subscriber, new Set([panel.id]))
    const oldRun = hub.runAll(panel.id)
    await store.update(panel.id, definition(source('a', 'echo new')))
    expect(pending[0]!.signal?.aborted).toBe(true)
    const currentRun = hub.runAll(panel.id)
    expect(runSource).toHaveBeenCalledTimes(2)
    pending[0]!.resolve(reading('stale'))
    await oldRun
    expect(dataEvents()).toHaveLength(0)
    expect(hub.views()[0]?.data.sources).toEqual({})
    const joined = hub.runAll(panel.id)
    expect(runSource).toHaveBeenCalledTimes(2)
    const fresh = reading('new')
    pending[1]!.resolve(fresh)
    expect(await currentRun).toEqual([{ id: 'a', ...fresh }])
    expect(await joined).toEqual([{ id: 'a', ...fresh }])
    expect(dataEvents()).toHaveLength(1)
    expect(hub.views()[0]?.data.sources['a']).toEqual(fresh)
  })

  it('does not let an old completion erase the new source cache', async () => {
    const { hub, store, panel, cache } = await setup(undefined, true)
    const remember = vi.spyOn(cache!, 'remember')
    const oldRun = hub.runAll(panel.id)
    await store.update(panel.id, definition(source('a', 'echo new')))
    const currentRun = hub.runAll(panel.id)
    pending[1]!.resolve(reading('new'))
    await currentRun
    pending[0]!.resolve(reading('old'))
    await oldRun
    expect(remember).toHaveBeenCalledTimes(1)
    expect(cache!.history(panel.id)['a']?.map(point => point.value)).toEqual(['new'])
    expect(hub.views()[0]?.data.sources['a']?.value).toBe('new')
  })

  it('invalidates a source removed and re-added with the same fingerprint', async () => {
    const { hub, store, panel, subscriber, dataEvents } = await setup()
    hub.rewatch(subscriber, new Set([panel.id]))
    const oldRun = hub.runAll(panel.id)
    await store.update(panel.id, definition())
    await store.update(panel.id, definition(source()))
    const currentRun = hub.runAll(panel.id)
    expect(runSource).toHaveBeenCalledTimes(2)
    pending[0]!.resolve(reading('removed'))
    await oldRun
    expect(dataEvents()).toHaveLength(0)
    pending[1]!.resolve(reading('readded'))
    await currentRun
    expect(dataEvents()).toHaveLength(1)
    expect(hub.views()[0]?.data.sources['a']?.value).toBe('readded')
  })

  it('prunes removed source readings instead of retaining them behind the view', async () => {
    const { hub, store, panel } = await setup([source('a'), source('b')])
    const initial = hub.runAll(panel.id)
    pending[0]!.resolve(reading('x'.repeat(512 * 1024)))
    pending[1]!.resolve(reading('keep'))
    await initial
    await store.update(panel.id, definition(source('b')))
    expect(hub.views()[0]?.data.sources['b']?.value).toBe('keep')
    // Re-adding the same definition must not resurrect the retained payload.
    await store.update(panel.id, definition(source('a'), source('b')))
    expect(hub.views()[0]?.data.sources['a']).toBeUndefined()
    expect(hub.views()[0]?.data.sources['b']?.value).toBe('keep')
  })

  it('does not treat a changed hidden source reading as fresh on reopen', async () => {
    const { hub, store, panel, subscriber } = await setup()
    const initial = hub.runAll(panel.id)
    pending[0]!.resolve(reading('old'))
    await initial
    await store.update(panel.id, definition(source('a', 'echo changed')))
    expect(hub.views()[0]?.data.sources).toEqual({})
    hub.rewatch(subscriber, new Set([panel.id]))
    await vi.advanceTimersByTimeAsync(0)
    expect(runSource).toHaveBeenCalledTimes(2)
    expect(pending[1]!.source).toMatchObject({ command: 'echo changed' })
    const joined = hub.runAll(panel.id)
    pending[1]!.resolve(reading('changed'))
    await joined
  })

  it('drops a deleted panel run without broadcasting or caching its late result', async () => {
    const { hub, store, panel, cache, subscriber, dataEvents } = await setup(undefined, true)
    hub.rewatch(subscriber, new Set([panel.id]))
    const remember = vi.spyOn(cache!, 'remember')
    const active = hub.runAll(panel.id)
    await store.remove(panel.id)
    expect(pending[0]!.signal?.aborted).toBe(true)
    pending[0]!.resolve(reading('deleted'))
    await active
    expect(dataEvents()).toHaveLength(0)
    expect(remember).not.toHaveBeenCalled()
    expect(hub.views()).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('aborts all in-flight sources on dispose and ignores late completions', async () => {
    const { hub, panel, cache, subscriber, dataEvents } = await setup([source('a'), source('b')], true)
    hub.rewatch(subscriber, new Set([panel.id]))
    const remember = vi.spyOn(cache!, 'remember')
    const active = hub.runAll(panel.id)
    hub.dispose()
    expect(pending.every(run => run.signal?.aborted)).toBe(true)
    pending[0]!.resolve(reading('late a'))
    pending[1]!.resolve(reading('late b'))
    await active
    expect(hub.views()[0]?.data.sources).toEqual({})
    expect(remember).not.toHaveBeenCalled()
    expect(dataEvents()).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
    hub.refresh(panel.id)
    await hub.runAll(panel.id)
    expect(runSource).toHaveBeenCalledTimes(2)
  })
})
