import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DataHub, type Subscriber } from '../src/host/hub.ts'
import { ReadingCache } from '../src/host/readings.ts'
import { PanelStore, sourcesFingerprint } from '../src/host/store.ts'
import type { PanelDefinition, StreamEvent } from '../src/shared/types.ts'

const definition = (command = 'echo 1', interval = 1): PanelDefinition => ({
  title: 'T', html: '', css: '', script: '', height: 'auto',
  sources: [{ id: 'a', kind: 'command', command, parse: 'text', intervalSec: interval }],
})

async function tempFile(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), 'dsh-pad-')), 'panels.json')
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

describe('PanelStore', () => {
  it('persists, reloads and orders panels', async () => {
    const file = await tempFile()
    const store = new PanelStore(file, false)
    const a = await store.create(definition())
    const b = await store.create({ ...definition(), title: 'B' })
    await store.move(b.id, -1)
    const again = new PanelStore(file, false)
    await again.load()
    expect(again.list().map(p => p.definition.title)).toEqual(['B', 'T'])
    expect(again.get(a.id).version).toBe(1)
  })

  it('sets and clears a panel model without reloading the frame', async () => {
    const store = new PanelStore(await tempFile(), false)
    const panel = await store.create(definition())
    await store.setModel(panel.id, { provider: 'magpie', model: 'codex/gpt-6.1-sol' })
    const next = store.get(panel.id)
    expect(next.version).toBe(1)
    expect(next.definition.model).toEqual({ provider: 'magpie', model: 'codex/gpt-6.1-sol' })
    await store.setModel(panel.id, null)
    expect(store.get(panel.id).definition.model).toBeUndefined()
  })

  it('stores a card span for the grid', async () => {
    const store = new PanelStore(await tempFile(), false)
    const panel = await store.create(definition())
    expect(store.get(panel.id).span).toBe(1)
    await store.setSpan(panel.id, 3)
    expect(store.get(panel.id).span).toBe(3)
  })

  it('requires approval for sources, and keeps it across non-source edits', async () => {
    const store = new PanelStore(await tempFile(), false)
    const panel = await store.create(definition())
    expect(store.approved(panel)).toBe(false)
    expect(await store.approve(panel.id, 'stale')).toBe(false)
    expect(await store.approve(panel.id, sourcesFingerprint(panel.definition.sources))).toBe(true)
    const restyled = await store.update(panel.id, { ...panel.definition, css: 'b{}' })
    expect(store.approved(restyled)).toBe(true)
    const rerouted = await store.update(panel.id, definition('echo 2'))
    expect(store.approved(rerouted)).toBe(false)
  })

  it('treats a panel without sources as approved; autoApprove approves everything', async () => {
    const store = new PanelStore(await tempFile(), false)
    expect(store.approved(await store.create({ ...definition(), sources: [] }))).toBe(true)
    const auto = new PanelStore(await tempFile(), true)
    expect(auto.approved(await auto.create(definition()))).toBe(true)
  })

  it('undoes the last edit', async () => {
    const store = new PanelStore(await tempFile(), false)
    const panel = await store.create(definition())
    await store.update(panel.id, { ...panel.definition, title: 'New' })
    const undone = await store.undo(panel.id)
    expect(undone.definition.title).toBe('T')
    expect(undone.previous).toBeUndefined()
    await expect(store.undo(panel.id)).rejects.toThrow(/没有可以撤销/)
  })

  it('reconciles agent scheduling when undo crosses the agent boundary', async () => {
    const store = new PanelStore(await tempFile(), false)
    const agent = { instruction: 'x', everyMinutes: 60 }
    const plain = await store.create(definition())
    const withAgent = await store.update(plain.id, { ...plain.definition, agent })
    expect(withAgent.agentRun?.status).toBe('idle')
    const undonePlain = await store.undo(plain.id)
    expect(undonePlain.definition.agent).toBeUndefined()
    expect(undonePlain.agentRun).toBeUndefined()

    const agentPanel = await store.create({ ...definition(), agent })
    expect(agentPanel.agentRun?.status).toBe('idle')
    await store.update(agentPanel.id, { ...agentPanel.definition, agent: undefined })
    expect(store.get(agentPanel.id).agentRun).toBeUndefined()
    const restored = await store.undo(agentPanel.id)
    expect(restored.definition.agent).toEqual(agent)
    expect(restored.agentRun?.status).toBe('idle')
    expect(Date.parse(restored.agentRun!.nextRunAt!)).toBeGreaterThan(Date.now() + 59 * 60_000)
  })

  it('schedules the first agent refresh one interval out and keeps a corrupt file aside', async () => {
    const file = await tempFile()
    const store = new PanelStore(file, false)
    const panel = await store.create({ ...definition(), sources: [], agent: { instruction: 'x', everyMinutes: 60 } })
    const due = Date.parse(panel.agentRun!.nextRunAt!) - Date.now()
    expect(due).toBeGreaterThan(59 * 60_000)
    await writeFile(file, '{not json')
    const broken = new PanelStore(file, false)
    await broken.load()
    expect(broken.list()).toEqual([])
    await expect(readFile(file, 'utf8')).rejects.toThrow()
  })
})

describe('DataHub', () => {
  it('polls only watched, approved panels and streams readings', async () => {
    const store = new PanelStore(await tempFile(), false)
    const hub = new DataHub(store, async () => undefined, () => {})
    store.onChange(() => hub.storeChanged())
    const panel = await store.create(definition('node -e "console.log(Date.now())"', 1))
    const events: StreamEvent[] = []
    const subscriber: Subscriber = { watch: new Set([panel.id]), send: e => events.push(e) }
    const unsubscribe = hub.subscribe(subscriber)
    await sleep(300)
    expect(events.filter(e => e.type === 'data')).toHaveLength(0) // not approved yet

    await store.approve(panel.id, sourcesFingerprint(panel.definition.sources))
    await sleep(2300)
    const data = events.filter(e => e.type === 'data')
    expect(data.length).toBeGreaterThanOrEqual(2)
    const first = data[0]
    expect(first?.type === 'data' && first.data.sources['a']?.ok).toBe(true)

    hub.rewatch(subscriber, new Set())
    const count = events.length
    await sleep(1500)
    expect(events.length).toBe(count) // unwatched: no more polling
    unsubscribe()
    hub.dispose()
  })

  it('runAll records readings into the panel view', async () => {
    const store = new PanelStore(await tempFile(), true)
    const hub = new DataHub(store, async () => undefined, () => {})
    const panel = await store.create(definition('echo hi', 60))
    const readings = await hub.runAll(panel.id)
    expect(readings).toEqual([expect.objectContaining({ id: 'a', ok: true, value: 'hi' })])
    expect(hub.views()[0]?.data.sources['a']?.value).toBe('hi')
    hub.dispose()
  })

  it('serves the cached trend and readings to a fresh page', async () => {
    const panelsFile = join(await mkdtemp(join(tmpdir(), 'dsh-pad-')), 'panels.json')
    const cacheFile = join(dirname(panelsFile), 'readings.json')
    const store = new PanelStore(panelsFile, true)
    const cache = new ReadingCache(cacheFile, 5)
    const hub = new DataHub(store, async () => undefined, () => {}, { cache })
    const panel = await store.create(definition('echo hi', 60))
    await hub.runAll(panel.id)
    await sleep(20)
    await hub.runAll(panel.id)
    expect(hub.views(true)[0]?.history['a']?.length).toBe(2)
    expect(hub.views()[0]?.history).toEqual({})
    await cache.flush()
    hub.dispose()
    cache.dispose()

    // A restarted Host: no polling yet, but the page already has the trend.
    const nextStore = new PanelStore(panelsFile, true)
    await nextStore.load()
    const nextCache = new ReadingCache(cacheFile)
    const restored = await nextCache.load(nextStore.list())
    const nextHub = new DataHub(nextStore, async () => undefined, () => {}, { restored, cache: nextCache })
    const events: StreamEvent[] = []
    const subscriber: Subscriber = { watch: new Set([panel.id]), send: event => events.push(event) }
    const unsubscribe = nextHub.subscribe(subscriber)
    const first = events.find(event => event.type === 'panels')
    const view = first?.type === 'panels' ? first.panels[0] : undefined
    expect(view?.data.sources['a']?.value).toBe('hi')
    expect(view?.history['a']?.map(point => point.value)).toEqual(['hi', 'hi'])
    unsubscribe()
    nextHub.dispose()
    nextCache.dispose()
  })
})
