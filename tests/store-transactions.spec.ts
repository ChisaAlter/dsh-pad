import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MAX_PANELS, PanelStore } from '../src/host/store.ts'
import type { PanelDefinition } from '../src/shared/types.ts'

const definition: PanelDefinition = {
  title: 'T', html: '', css: '', script: '', height: 'auto', sources: [],
}

const tempDirs: string[] = []
afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-pad-transactions-'))
  tempDirs.push(dir)
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

  it('does not leak a rejected update into a queued mutation or its undo definition and cleans up temp files', async () => {
    const { store, dir, file } = await fixture()
    const panel = await store.create(definition)
    // Replace the target file with a directory so atomic rename fails deterministically.
    await rm(file, { force: true })
    await mkdir(file)
    await expect(store.update(panel.id, { ...definition, title: 'Failed' })).rejects.toThrow()
    expect(store.get(panel.id)).toBe(panel)
    const leftoverTmp = (await readdir(dir)).filter(name => name.endsWith('.tmp'))
    expect(leftoverTmp).toEqual([])
    await rm(file, { recursive: true, force: true })
    await store.setCollapsed(panel.id, true)
    expect(store.get(panel.id)).toMatchObject({ collapsed: true, version: 1, definition: { title: 'T' } })
    expect(store.get(panel.id).previous).toBeUndefined()
  })

  it('caps panel count at MAX_PANELS while still allowing updates to existing titles', async () => {
    const { store } = await fixture()
    for (let i = 0; i < MAX_PANELS; i += 1) {
      await store.create({ ...definition, title: `Panel ${i}` })
    }
    await expect(store.create({ ...definition, title: 'One too many' })).rejects.toThrow(/最多只能创建/)
    const updated = await store.create({ ...definition, title: 'Panel 0', css: 'b{}' })
    expect(updated.version).toBe(2)
    expect(store.list()).toHaveLength(MAX_PANELS)
  })

  it('validates loaded records, clamps invalid intervalSec >= 1 and skips malformed entries', async () => {
    const { file } = await fixture()
    await writeFile(file, JSON.stringify({
      version: 1,
      panels: [
        {
          id: 'p_good',
          version: 1,
          position: 0,
          collapsed: false,
          span: 1,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          definition: {
            title: 'Good',
            html: '',
            css: '',
            script: '',
            height: 'auto',
            sources: [{ id: 'a', kind: 'command', command: 'echo 1', parse: 'text', intervalSec: 0 }],
          },
        },
        { id: 'p_bad', version: 1, position: 1, definition: { title: '', sources: 'not-an-array' } },
      ],
    }))
    const loaded = new PanelStore(file)
    await loaded.load()
    expect(loaded.list()).toHaveLength(1)
    expect(loaded.get('p_good').definition.sources[0]?.intervalSec).toBe(1)
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
