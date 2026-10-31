import { mkdir, mkdtemp, readFile, rename, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PanelStore } from '../src/host/store.ts'
import type { PanelDefinition } from '../src/shared/types.ts'

const definition: PanelDefinition = {
  title: 'T', html: '', css: '', script: '', height: 'auto', sources: [],
}

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-pad-transactions-'))
  const file = join(dir, 'panels.json')
  return { dir, file, store: new PanelStore(file) }
}

describe('PanelStore transactions', () => {
  it('never publishes a failed create or includes it in a later successful write', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-pad-failed-write-'))
    const parent = join(dir, 'blocked')
    await writeFile(parent, 'not a directory')
    const file = join(parent, 'panels.json')
    const store = new PanelStore(file)
    let changes = 0
    store.onChange(() => { changes += 1 })
    await expect(store.create(definition)).rejects.toThrow()
    expect(store.list()).toEqual([])
    expect(changes).toBe(0)
    await rename(parent, join(dir, 'original-blocker'))
    await mkdir(parent)
    await store.create({ ...definition, title: 'Succeeded' })
    const saved = JSON.parse(await readFile(file, 'utf8'))
    expect(saved.panels.map((panel: { definition: PanelDefinition }) => panel.definition.title)).toEqual(['Succeeded'])
    expect(changes).toBe(1)
  })

  it('serializes reads and mutations as well as writes without losing unrelated fields', async () => {
    const { store, file } = await fixture()
    const panel = await store.create(definition)
    const notifications: unknown[] = []
    store.onChange(() => notifications.push(store.get(panel.id)))
    const collapsing = store.setCollapsed(panel.id, true)
    // Pending writes are invisible even to synchronous readers.
    expect(store.get(panel.id).collapsed).toBe(false)
    await Promise.all([
      collapsing,
      store.setSpan(panel.id, 3),
      store.setModel(panel.id, { provider: 'mock', model: 'new' }),
      store.setAgentData(panel.id, { value: 42 }),
    ])
    expect(store.get(panel.id)).toMatchObject({
      collapsed: true, span: 3,
      definition: { model: { provider: 'mock', model: 'new' } },
      agentData: { value: { value: 42 } },
    })
    const saved = JSON.parse(await readFile(file, 'utf8'))
    expect(saved.panels[0]).toEqual(store.get(panel.id))
    expect(notifications).toHaveLength(4)
  })

  it('does not leak a rejected update into a queued mutation or its undo definition', async () => {
    const { store, dir } = await fixture()
    const panel = await store.create(definition)
    const temp = join(dir, `panels.json.${process.pid}.tmp`)
    await mkdir(temp)
    await expect(store.update(panel.id, { ...definition, title: 'Failed' })).rejects.toThrow()
    expect(store.get(panel.id)).toBe(panel)
    await rename(temp, join(dir, 'blocking-temp-directory'))
    await store.setCollapsed(panel.id, true)
    expect(store.get(panel.id)).toMatchObject({ collapsed: true, version: 1, definition: { title: 'T' } })
    expect(store.get(panel.id).previous).toBeUndefined()
  })

  it('deduplicates simultaneous creates using the latest committed titles', async () => {
    const { store } = await fixture()
    const [a, b] = await Promise.all([
      store.create(definition),
      store.create({ ...definition, css: 'b{}' }),
    ])
    expect(a.id).toBe(b.id)
    expect(store.list()).toHaveLength(1)
    expect(store.get(a.id)).toMatchObject({ version: 2, definition: { css: 'b{}' } })
  })

  it('runs definition transforms and agent ownership guards against the latest record', async () => {
    const { store } = await fixture()
    const panel = await store.create(definition)
    const oldState = { status: 'running' as const, lastRunAt: 'old' }
    const newState = { status: 'running' as const, lastRunAt: 'new' }
    await store.setAgentRun(panel.id, oldState)
    const changingModel = store.setModel(panel.id, { provider: 'mock', model: 'new' })
    const editing = store.updateDefinition(panel.id, current => ({ ...current.definition, title: 'Renamed' }))
    const claiming = store.setAgentRun(panel.id, newState)
    const staleData = store.setAgentData(panel.id, 'stale', current => current.agentRun === oldState)
    const staleState = store.setAgentRun(panel.id, { status: 'failed' }, current => current.agentRun === oldState)
    await Promise.all([changingModel, editing, claiming])
    expect(await staleData).toBe(false)
    expect(await staleState).toBe(false)
    expect(store.get(panel.id)).toMatchObject({ definition: { title: 'Renamed', model: { model: 'new' } } })
    expect(store.get(panel.id).agentRun).toBe(newState)
    expect(store.get(panel.id).agentData).toBeUndefined()
  })
})
