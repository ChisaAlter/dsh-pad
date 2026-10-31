import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DataHub } from '../src/host/hub.ts'
import { HISTORY_POINTS, MAX_CACHED_VALUE_CHARS, ReadingCache } from '../src/host/readings.ts'
import { PanelStore, sourcesFingerprint } from '../src/host/store.ts'
import type { PanelDefinition, PanelRecord, PanelSource, SourceReading } from '../src/shared/types.ts'

const httpSource = (id: string, url = 'https://example.com/api'): PanelSource => ({ id, kind: 'http', url, parse: 'json', intervalSec: 30 })

const panel = (id: string, sources: PanelSource[]): PanelRecord => ({
  id,
  version: 1,
  position: 0,
  collapsed: false,
  span: 1,
  createdAt: '2026-10-23T00:00:00.000Z',
  updatedAt: '2026-10-23T00:00:00.000Z',
  definition: { title: 'T', html: '', css: '', script: '', height: 'auto', sources },
})

const reading = (value: unknown, at = '2026-10-23T08:00:00.000Z'): SourceReading => ({ ok: true, value: value as never, at })

async function cachePath(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), 'dsh-pad-cache-')), 'readings.json')
}

describe('ReadingCache', () => {
  it('restores the newest reading of an unchanged source', async () => {
    const file = await cachePath()
    const source = httpSource('balance')
    const cache = new ReadingCache(file)
    cache.remember('p_1', 'balance', sourcesFingerprint([source]), reading({ amount: 42 }))
    await cache.flush()

    const restored = await new ReadingCache(file).load([panel('p_1', [source])])
    expect(restored.get('p_1')?.get('balance')?.value).toEqual({ amount: 42 })
    expect(restored.get('p_1')?.get('balance')?.at).toBe('2026-10-23T08:00:00.000Z')
  })

  it('never caches a failed or oversized reading', async () => {
    const file = await cachePath()
    const source = httpSource('balance')
    const cache = new ReadingCache(file)
    cache.remember('p_1', 'balance', sourcesFingerprint([source]), { ok: false, error: 'HTTP 500', at: '2026-10-23T08:00:00.000Z' })
    cache.remember('p_1', 'big', sourcesFingerprint([source]), reading('x'.repeat(MAX_CACHED_VALUE_CHARS + 1)))
    await cache.flush()
    await expect(readFile(file, 'utf8')).rejects.toThrow()
  })

  it('drops a reading whose source definition changed', async () => {
    const file = await cachePath()
    const old = httpSource('balance', 'https://example.com/old')
    const cache = new ReadingCache(file)
    cache.remember('p_1', 'balance', sourcesFingerprint([old]), reading({ amount: 42 }))
    await cache.flush()

    // Same id, different URL: the value belongs to a query that no longer runs.
    const restored = await new ReadingCache(file).load([panel('p_1', [httpSource('balance', 'https://example.com/new')])])
    expect(restored.size).toBe(0)
  })

  it('prunes deleted panels, removed sources and changed sources', async () => {
    const file = await cachePath()
    const keep = httpSource('keep')
    const removed = httpSource('removed')
    const cache = new ReadingCache(file)
    cache.remember('p_keep', 'keep', sourcesFingerprint([keep]), reading(1))
    cache.remember('p_keep', 'removed', sourcesFingerprint([removed]), reading(2))
    cache.remember('p_gone', 'keep', sourcesFingerprint([keep]), reading(3))
    await cache.flush()

    const reloaded = new ReadingCache(file)
    const restored = await reloaded.load([panel('p_keep', [keep, removed]), panel('p_gone', [keep])])
    expect(restored.get('p_keep')?.size).toBe(2)
    expect(restored.get('p_gone')?.size).toBe(1)

    // The panel was deleted and one source was dropped from the survivor.
    reloaded.prune([panel('p_keep', [keep])])
    await reloaded.flush()
    const text = await readFile(file, 'utf8')
    expect(text).not.toContain('p_gone')
    expect(text).not.toContain('removed')
    expect(text).toContain('p_keep')
  })

  it('keeps the newest twenty points for a trend chart', async () => {
    const file = await cachePath()
    const source = httpSource('balance')
    const key = sourcesFingerprint([source])
    const cache = new ReadingCache(file)
    for (let i = 0; i < 25; i += 1) {
      cache.remember('p_1', 'balance', key, reading(i, new Date(Date.UTC(2026, 9, 23, 0, i)).toISOString()))
    }
    await cache.flush()

    const reloaded = new ReadingCache(file)
    const restored = await reloaded.load([panel('p_1', [source])])
    // The panel paints at once from the newest reading…
    expect(restored.get('p_1')?.get('balance')?.value).toBe(24)
    // …and the trend starts with the last twenty points, oldest first.
    const points = reloaded.history('p_1')['balance'] ?? []
    expect(points).toHaveLength(HISTORY_POINTS)
    expect(points[0]?.value).toBe(5)
    expect(points[points.length - 1]?.value).toBe(24)
  })

  it('does not repeat a reading with the same timestamp', async () => {
    const file = await cachePath()
    const source = httpSource('balance')
    const key = sourcesFingerprint([source])
    const cache = new ReadingCache(file)
    cache.remember('p_1', 'balance', key, reading(1, '2026-10-23T08:00:00.000Z'))
    cache.remember('p_1', 'balance', key, reading(2, '2026-10-23T08:00:00.000Z'))
    expect(cache.history('p_1')['balance']).toHaveLength(1)
    expect(cache.history('p_1')['balance']?.[0]?.value).toBe(2)
  })

  it('trims a ring of large readings to keep the file small', async () => {
    const file = await cachePath()
    const source = httpSource('usage')
    const key = sourcesFingerprint([source])
    const cache = new ReadingCache(file)
    for (let i = 0; i < HISTORY_POINTS; i += 1) {
      cache.remember('p_1', 'usage', key, reading(`${i}`.padStart(6, '0') + 'x'.repeat(9_000), new Date(Date.UTC(2026, 9, 23, 0, i)).toISOString()))
    }
    const points = cache.history('p_1')['usage'] ?? []
    expect(points.length).toBeGreaterThan(1)
    expect(points.length).toBeLessThan(HISTORY_POINTS)
    expect(String(points[points.length - 1]?.value).startsWith('000019')).toBe(true)
  })

  it('reads a cache file written before rings existed', async () => {
    const file = await cachePath()
    const source = httpSource('balance')
    // Version 1 stored one reading per source instead of a ring.
    await writeFile(file, JSON.stringify({
      version: 1,
      panels: {
        p_1: {
          balance: {
            key: sourcesFingerprint([source]),
            reading: { ok: true, value: { amount: 42 }, at: '2026-10-23T08:00:00.000Z' },
          },
        },
      },
    }))
    const cache = new ReadingCache(file)
    const restored = await cache.load([panel('p_1', [source])])
    expect(restored.get('p_1')?.get('balance')?.value).toEqual({ amount: 42 })
    expect(cache.history('p_1')['balance']).toHaveLength(1)
  })

  it('rejects deep legacy cache values even when their serialized size is small', async () => {
    const file = await cachePath()
    const source = httpSource('balance')
    const key = sourcesFingerprint([source])
    const deep = '['.repeat(1000) + '1' + ']'.repeat(1000)
    await writeFile(file, `{"version":1,"panels":{"p_1":{"balance":{"key":"${key}","reading":{"ok":true,"value":${deep},"at":"2026-10-23T08:00:00.000Z"}}}}}`)
    const cache = new ReadingCache(file)
    expect((await cache.load([panel('p_1', [source])])).size).toBe(0)
    cache.remember('p_1', 'balance', key, reading(JSON.parse(deep)))
    expect(cache.history('p_1')).toEqual({})
    cache.dispose()
  })

  it('ignores a corrupt cache file', async () => {
    const file = await cachePath()
    await writeFile(file, '{not json')
    const restored = await new ReadingCache(file).load([panel('p_1', [httpSource('a')])])
    expect(restored.size).toBe(0)
  })

  it('coalesces writes and keeps the newest value', async () => {
    const file = await cachePath()
    const source = httpSource('balance')
    const cache = new ReadingCache(file, 20)
    cache.remember('p_1', 'balance', sourcesFingerprint([source]), reading(1))
    cache.remember('p_1', 'balance', sourcesFingerprint([source]), reading(2))
    // Wait for the pending write itself rather than for a wall-clock window:
    // under a loaded suite the debounce timer can miss any fixed sleep.
    await cache.flush()
    const restored = await new ReadingCache(file).load([panel('p_1', [source])])
    expect(restored.get('p_1')?.get('balance')?.value).toBe(2)
    cache.dispose()
  })

  it('writes nothing when there is nothing to cache', async () => {
    const file = await cachePath()
    const cache = new ReadingCache(file)
    await cache.flush()
    await expect(readFile(file, 'utf8')).rejects.toThrow()
  })
})

describe('DataHub reading cache', () => {
  const definition = (command = 'echo 1', interval = 60): PanelDefinition => ({
    title: 'T', html: '', css: '', script: '', height: 'auto',
    sources: [{ id: 'a', kind: 'command', command, parse: 'text', intervalSec: interval }],
  })

  it('hands the last reading to the next run of the Host', async () => {
    const panelsFile = join(await mkdtemp(join(tmpdir(), 'dsh-pad-')), 'panels.json')
    const file = join(dirname(panelsFile), 'readings.json')
    const store = new PanelStore(panelsFile)
    const cache = new ReadingCache(file, 10)
    const hub = new DataHub(store, async () => undefined, () => {}, { cache })
    const panel = await store.create(definition('echo hi'))
    await hub.runAll(panel.id)
    await cache.flush()
    hub.dispose()
    cache.dispose()

    // A fresh Host process: same panels, restored readings.
    const nextStore = new PanelStore(panelsFile)
    await nextStore.load()
    const restored = await new ReadingCache(file).load(nextStore.list())
    const nextHub = new DataHub(nextStore, async () => undefined, () => {}, { restored })
    expect(nextHub.views()[0]?.data.sources['a']?.value).toBe('hi')
    nextHub.dispose()
  })

  it('forgets a reading when the panel is deleted', async () => {
    const panelsFile = join(await mkdtemp(join(tmpdir(), 'dsh-pad-')), 'panels.json')
    const file = join(dirname(panelsFile), 'readings.json')
    const store = new PanelStore(panelsFile)
    const cache = new ReadingCache(file, 10)
    const hub = new DataHub(store, async () => undefined, () => {}, { cache })
    store.onChange(() => hub.storeChanged())
    const panel = await store.create(definition('echo hi'))
    await hub.runAll(panel.id)
    await store.remove(panel.id)
    await cache.flush()
    expect(await readFile(file, 'utf8')).not.toContain(panel.id)
    hub.dispose()
    cache.dispose()
  })
})
