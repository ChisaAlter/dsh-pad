import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { describe, expect, it } from 'vitest'
import { DataHub } from '../src/host/hub.ts'
import { PanelStore } from '../src/host/store.ts'
import { registerTools } from '../src/host/tools.ts'

type Outcome = 'allowed-once' | 'rejected'

/** A Context stand-in carrying only what registerTools touches. */
async function setup(outcome: Outcome | undefined) {
  const tools = new Map<string, ToolDefinition>()
  const asked: string[] = []
  const services: Record<string, unknown> = {
    approval: outcome === undefined ? undefined : {
      request: async (req: { reason: string }) => { asked.push(req.reason); return outcome },
    },
  }
  const ctx = {
    effect: (fn: () => unknown) => fn(),
    tools: { register: (def: ToolDefinition) => { tools.set(def.name, def); return () => tools.delete(def.name) } },
    get: (name: string) => services[name],
  } as unknown as Context
  const store = new PanelStore(join(await mkdtemp(join(tmpdir(), 'dsh-pad-tools-')), 'panels.json'), false)
  const hub = new DataHub(store, async () => undefined, () => {})
  registerTools({ ctx, store, hub, refresher: undefined, limits: { minIntervalSec: 2, minAgentMinutes: 15 }, autoApprove: false, resolveSecret: async () => undefined })
  const exec = { agent: {}, callId: 'c1', signal: new AbortController().signal }
  const call = async (name: string, args: Record<string, unknown>): Promise<string> => {
    const tool = tools.get(name) as unknown as { execute(args: unknown, exec: unknown): Promise<string> }
    return await tool.execute(args, exec)
  }
  return { tools, asked, store, hub, call }
}

const perf = {
  title: '负载',
  html: '<b></b>',
  script: 'dsh.onData(() => {})',
  sources: [{ id: 'load', kind: 'command', command: 'node -e "console.log(\'0.10 0.20 0.30\')"', parse: 'text', intervalSec: 3 }],
}

describe('pad_* tools', () => {
  it('registers the conversation tools', async () => {
    const { tools } = await setup(undefined)
    expect([...tools.keys()].sort()).toEqual(['pad_create', 'pad_delete', 'pad_get', 'pad_list', 'pad_models', 'pad_refresh', 'pad_test_source', 'pad_update'])
  })

  it('creates a panel, asks once through dsh approval, and reports first readings', async () => {
    const { call, asked, store, hub } = await setup('allowed-once')
    const text = await call('pad_create', perf)
    expect(asked).toHaveLength(1)
    expect(asked[0]).toContain('node -e "console.log(\'0.10 0.20 0.30\')"')
    expect(text).toMatch(/已创建面板 p_\w+「负载」/)
    expect(text).toMatch(/- load: ✓/)
    expect(store.approved(store.list()[0]!)).toBe(true)
    hub.dispose()
  })

  it('leaves a declined panel waiting for approval in the dock', async () => {
    const { call, store, hub } = await setup('rejected')
    const text = await call('pad_create', perf)
    expect(text).toMatch(/还没被允许运行/)
    expect(store.approved(store.list()[0]!)).toBe(false)
    hub.dispose()
  })

  it('returns every validation problem to the model', async () => {
    const { call } = await setup('allowed-once')
    await expect(call('pad_create', { ...perf, title: '', sources: [{ id: 'x', kind: 'command', command: 'ls', parse: 'text', intervalSec: 1 }] }))
      .rejects.toThrow(/2 处问题[\s\S]*title[\s\S]*intervalSec/)
  })

  it('updates only the given fields, and asks again only when sources change', async () => {
    const { call, asked, store, hub } = await setup('allowed-once')
    await call('pad_create', perf)
    const id = store.list()[0]!.id
    await call('pad_update', { id, css: 'b{color:red}' })
    expect(asked).toHaveLength(1)
    expect(store.get(id).definition.css).toBe('b{color:red}')
    expect(store.get(id).definition.html).toBe('<b></b>')
    await call('pad_update', { id, sources: [{ ...perf.sources[0], intervalSec: 10 }] })
    expect(asked).toHaveLength(2)
    expect(store.get(id).version).toBe(3)
    hub.dispose()
  })

  it('updates AI data without a new version', async () => {
    const { call, store, hub } = await setup(undefined)
    await call('pad_create', { title: '余额', html: '', sources: [], agent: { instruction: '查余额', everyMinutes: 60 }, data: { v: 1 } })
    const id = store.list()[0]!.id
    expect(await call('pad_update', { id, data: { v: 2 } })).toMatch(/已更新面板「余额」的数据/)
    expect(store.get(id)).toMatchObject({ version: 1, agentData: { value: { v: 2 } } })
    hub.dispose()
  })

  it('refuses pad_test_source when the user declines', async () => {
    const { call } = await setup('rejected')
    await expect(call('pad_test_source', { source: { id: 'x', kind: 'command', command: 'id', parse: 'text' } })).rejects.toThrow(/没有允许/)
  })

  it('test-runs an allowed source with the minimum interval filled in', async () => {
    const { call } = await setup('allowed-once')
    expect(await call('pad_test_source', { source: { id: 'x', kind: 'command', command: 'echo ok', parse: 'text' } })).toMatch(/✓ .*\n"ok"/)
  })
})
