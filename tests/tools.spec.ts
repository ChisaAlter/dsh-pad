import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { describe, expect, it } from 'vitest'
import { DataHub } from '../src/host/hub.ts'
import { PanelStore } from '../src/host/store.ts'
import { registerTools } from '../src/host/tools.ts'

/** A Context stand-in carrying only what registerTools touches. */
async function setup(services: Record<string, unknown> = {}) {
  const tools = new Map<string, ToolDefinition>()
  const ctx = {
    effect: (fn: () => unknown) => fn(),
    tools: { register: (def: ToolDefinition) => { tools.set(def.name, def); return () => tools.delete(def.name) } },
    get: (name: string) => services[name],
  } as unknown as Context
  const store = new PanelStore(join(await mkdtemp(join(tmpdir(), 'dsh-pad-tools-')), 'panels.json'))
  const hub = new DataHub(store, async () => undefined, () => {})
  registerTools({ ctx, store, hub, refresher: undefined, limits: { minIntervalSec: 2, minAgentMinutes: 15 }, resolveSecret: async () => undefined })
  const exec = { signal: new AbortController().signal }
  const call = async (name: string, args: Record<string, unknown>): Promise<string> => {
    const tool = tools.get(name) as unknown as { execute(args: unknown, exec: unknown): Promise<string> }
    return await tool.execute(args, exec)
  }
  return { tools, store, hub, call }
}

const perf = {
  title: '负载',
  html: '<b></b>',
  script: 'dsh.onData(() => {})',
  sources: [{ id: 'load', kind: 'command', command: 'node -e "console.log(\'0.10 0.20 0.30\')"', parse: 'text', intervalSec: 3 }],
}

describe('pad_* tools', () => {
  it('registers the conversation tools', async () => {
    const { tools } = await setup()
    expect([...tools.keys()].sort()).toEqual(['pad_create', 'pad_delete', 'pad_get', 'pad_guide', 'pad_list', 'pad_models', 'pad_refresh', 'pad_test_source', 'pad_update'])
  })

  it('serves the authoring manual, whole or by section', async () => {
    const { call } = await setup()
    const all = await call('pad_guide', {})
    expect(all).toContain('# 版式')
    expect(all).toContain('# kit')
    expect(all).toContain('# 配方')
    expect(all).toContain('# 面板运行环境')
    const recipes = await call('pad_guide', { topic: 'recipes' })
    expect(recipes).toContain('# 配方')
    expect(recipes).not.toContain('# 版式')
  })

  it('refuses a wall of text instead of putting it on the card', async () => {
    const { call, store, hub } = await setup()
    const wall = `<p>${'这是一段本该放在对话里的说明文字，'.repeat(12)}</p>`
    await expect(call('pad_create', { title: '说明', html: wall, sources: [] }))
      .rejects.toThrow(/排版不合格[\s\S]*plain: true/)
    expect(store.list()).toHaveLength(0)
    hub.dispose()
  })

  it('lets an explicitly requested text card through', async () => {
    const { call, store, hub } = await setup()
    const wall = `<p>${'这是一段本该放在对话里的说明文字，'.repeat(12)}</p>`
    expect(await call('pad_create', { title: '说明', html: wall, sources: [], plain: true })).toMatch(/已创建面板/)
    expect(store.list()).toHaveLength(1)
    hub.dispose()
  })

  it('keeps the card but reports advisory findings', async () => {
    const { call, store, hub } = await setup()
    const text = await call('pad_create', {
      title: 'CPU',
      html: '<div class="pad-metric"><span class="pad-label">CPU</span><span class="pad-metric-value">42</span></div>',
      css: '.x{color:#fff}',
      sources: [],
    })
    expect(text).toMatch(/排版建议/)
    expect(text).toMatch(/\[warn\].*#fff/)
    expect(store.list()).toHaveLength(1)
    hub.dispose()
  })

  it('checks the layout on an edit but not on a rename', async () => {
    const { call, store, hub } = await setup()
    const wall = `<p>${'这是一段本该放在对话里的说明文字，'.repeat(12)}</p>`
    await call('pad_create', { title: '说明', html: wall, sources: [], plain: true })
    const id = store.list()[0]!.id
    // Renaming is not a layout change and must not be refused.
    expect(await call('pad_update', { id, title: '说明 2' })).toMatch(/已更新面板/)
    // Writing a new wall is a layout change and is refused.
    await expect(call('pad_update', { id, html: `${wall}<p>再补一句。</p>` })).rejects.toThrow(/排版不合格/)
    expect(store.get(id).definition.title).toBe('说明 2')
    hub.dispose()
  })

  it('creates a panel, runs its sources at once and reports the first readings', async () => {
    const { call, hub } = await setup()
    const text = await call('pad_create', perf)
    expect(text).toMatch(/已创建面板 p_\w+「负载」/)
    expect(text).toMatch(/- load: ✓/)
    expect(hub.views()[0]?.data.sources['load']?.ok).toBe(true)
    hub.dispose()
  })

  it('leaves a created panel with its sources already read, not waiting for a run', async () => {
    const { call, store, hub } = await setup()
    await call('pad_create', perf)
    expect(store.list()).toHaveLength(1)
    expect(hub.views()[0]?.data.sources['load']?.value).toBe('0.10 0.20 0.30')
    hub.dispose()
  })

  it('returns every validation problem to the model', async () => {
    const { call } = await setup()
    await expect(call('pad_create', { ...perf, title: '', sources: [{ id: 'x', kind: 'command', command: 'ls', parse: 'text', intervalSec: 1 }] }))
      .rejects.toThrow(/2 处问题[\s\S]*title[\s\S]*intervalSec/)
  })

  it('updates only the given fields and reruns the sources when they change', async () => {
    const { call, store, hub } = await setup()
    await call('pad_create', perf)
    const id = store.list()[0]!.id
    await call('pad_update', { id, css: 'b{color:red}' })
    expect(store.get(id).definition.css).toBe('b{color:red}')
    expect(store.get(id).definition.html).toBe('<b></b>')
    const text = await call('pad_update', { id, sources: [{ ...perf.sources[0], intervalSec: 10 }] })
    expect(text).toMatch(/- load: ✓/)
    expect(store.get(id).version).toBe(3)
    hub.dispose()
  })

  it('updates AI data without a new version', async () => {
    const { call, store, hub } = await setup()
    await call('pad_create', { title: '余额', html: '', sources: [], agent: { instruction: '查余额', everyMinutes: 60 }, data: { v: 1 } })
    const id = store.list()[0]!.id
    expect(await call('pad_update', { id, data: { v: 2 } })).toMatch(/已更新面板「余额」的数据/)
    expect(store.get(id)).toMatchObject({ version: 1, agentData: { value: { v: 2 } } })
    hub.dispose()
  })

  it('applies data on an identical pad_create instead of dropping it', async () => {
    const { call, store, hub } = await setup()
    await call('pad_create', { title: '余额', html: '', sources: [], agent: { instruction: '查余额', everyMinutes: 60 }, data: { v: 1 } })
    const id = store.list()[0]!.id
    const text = await call('pad_create', { title: '余额', html: '', sources: [], agent: { instruction: '查余额', everyMinutes: 60 }, data: { v: 2 } })
    expect(text).toMatch(/已存在，定义相同，没有新建/)
    expect(text).toMatch(/已把这次提交的 data 更新到面板上/)
    expect(store.list()).toHaveLength(1)
    expect(store.get(id)).toMatchObject({ version: 1, agentData: { value: { v: 2 } } })
    hub.dispose()
  })

  it('still skips data on an identical pad_create when data is absent', async () => {
    const { call, store, hub } = await setup()
    await call('pad_create', { title: '余额', html: '', sources: [], agent: { instruction: '查余额', everyMinutes: 60 }, data: { v: 1 } })
    const id = store.list()[0]!.id
    const text = await call('pad_create', { title: '余额', html: '', sources: [], agent: { instruction: '查余额', everyMinutes: 60 } })
    expect(text).toMatch(/已存在，定义相同，没有新建/)
    expect(text).not.toMatch(/已把这次提交的 data 更新到面板上/)
    expect(store.get(id)).toMatchObject({ version: 1, agentData: { value: { v: 1 } } })
    hub.dispose()
  })

  it('rejects data on pad_update for a panel without agent refresh', async () => {
    const { call, store, hub } = await setup()
    await call('pad_create', { title: '静态', html: '<b></b>', sources: [] })
    const id = store.list()[0]!.id
    await expect(call('pad_update', { id, data: { v: 1 } })).rejects.toThrow(/没有 AI 刷新/)
    expect(store.get(id).version).toBe(1)
    expect(store.get(id).agentData).toBeUndefined()
    hub.dispose()
  })

  it('preserves a menu model switch and concurrent edits while model validation is pending', async () => {
    let release: () => void = () => {}
    const blocked = new Promise<void>(resolve => { release = resolve })
    let lookingUp: () => void = () => {}
    const lookupStarted = new Promise<void>(resolve => { lookingUp = resolve })
    const llm = {
      listProviders: () => [{ id: 'mock', name: 'Mock' }],
      listModels: async () => {
        lookingUp()
        await blocked
        return [{ id: 'old', name: 'Old' }, { id: 'new', name: 'New' }]
      },
    }
    const { store, call, hub } = await setup({ llm })
    const panel = await store.create({
      title: 'T', html: '<b></b>', css: '', script: '', height: 'auto', sources: [],
      model: { provider: 'mock', model: 'old' },
    })
    try {
      const updating = call('pad_update', { id: panel.id, title: 'Renamed' })
      await lookupStarted
      await store.setModel(panel.id, { provider: 'mock', model: 'new' })
      await store.updateDefinition(panel.id, current => ({ ...current.definition, css: 'b{margin:0}' }))
      release()
      await expect(updating).resolves.toMatch(/已更新面板/)
      expect(store.get(panel.id).definition).toMatchObject({
        title: 'Renamed', css: 'b{margin:0}', model: { provider: 'mock', model: 'new' },
      })
    } finally {
      release()
      hub.dispose()
    }
  })

  it('test-runs a source with the minimum interval filled in', async () => {
    const { call } = await setup()
    expect(await call('pad_test_source', { source: { id: 'x', kind: 'command', command: 'echo ok', parse: 'text' } })).toMatch(/✓ .*\n"ok"/)
  })
})
