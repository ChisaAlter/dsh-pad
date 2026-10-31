import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DataHub } from '../src/host/hub.ts'
import { assertModel, modelCatalog } from '../src/host/models.ts'
import { registerRoutes } from '../src/host/routes.ts'
import { PanelStore } from '../src/host/store.ts'

const llm = {
  listProviders: () => [{ id: 'magpie', name: 'Magpie' }, { id: 'broken', name: 'Broken' }],
  listModels: async (provider: string) => {
    if (provider === 'broken') throw new Error('offline')
    return [
      { id: 'codex/gpt-6.1-sol', name: 'GPT-6.1 Sol', description: 'Strong' },
      { id: 'deepseek-v4.1-flash-1017', name: 'DeepSeek V4.1 Flash' },
    ]
  },
  resolveModelInfo: async () => ({
    reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'max', name: 'Max' }], defaultEffort: 'max' as const },
  }),
  stream: async function* () {
    yield { type: 'text-delta', text: 'hello ' }
    yield { type: 'text-delta', text: 'panel' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  },
}

const ctx = {
  get: (name: string) => {
    if (name === 'llm') return llm
    if (name === 'agentDefaultModel') {
      return { currentSelection: () => ({ provider: 'magpie', model: 'deepseek-v4.1-flash-1017', reasoningEffort: 'max' }) }
    }
    return undefined
  },
} as unknown as Context

describe('per-panel model catalog', () => {
  it('projects providers, models and the deployment default', async () => {
    const catalog = await modelCatalog(ctx)
    expect(catalog.default).toEqual({ provider: 'magpie', model: 'deepseek-v4.1-flash-1017', reasoningEffort: 'max' })
    expect(catalog.providers.map(provider => provider.id)).toEqual(['magpie'])
    expect(catalog.providers[0]?.models[0]).toMatchObject({
      id: 'codex/gpt-6.1-sol',
      name: 'GPT-6.1 Sol',
      defaultReasoningEffort: 'max',
    })
  })

  it('accepts a routable model and rejects unknown routes', async () => {
    await expect(assertModel(ctx, { provider: 'magpie', model: 'deepseek-v4.1-flash-1017' })).resolves.toBeUndefined()
    await expect(assertModel(ctx, { provider: 'magpie', model: 'nope' })).rejects.toThrow(/没有模型/)
    await expect(assertModel(ctx, { provider: 'nope', model: 'x' })).rejects.toThrow(/没有 provider/)
    await expect(assertModel(ctx, { provider: 'magpie', model: 'deepseek-v4.1-flash-1017', reasoningEffort: 'nope' }))
      .rejects.toThrow(/不支持推理强度/)
  })

  it('serves the catalog on the models route', async () => {
    const routes = new Map<string, (request: Request) => Promise<Response>>()
    const routeCtx = {
      effect: (fn: () => unknown) => fn(),
      get: ctx.get,
      connection: {
        fetch: {
          register: (entry: { path: string, fetch: (request: Request) => Promise<Response> }) => {
            routes.set(entry.path, entry.fetch)
            return () => {}
          },
        },
      },
    } as unknown as Context
    const store = new PanelStore(join(await mkdtemp(join(tmpdir(), 'dsh-pad-routes-')), 'panels.json'))
    const hub = new DataHub(store, async () => undefined, () => {})
    registerRoutes({ ctx: routeCtx, store, hub, refresher: undefined })
    const handler = routes.get('/api/dsh-pad.models')
    expect(handler).toBeDefined()
    const response = await handler!(new Request('http://local/api/dsh-pad.models'))
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ providers: [{ id: 'magpie' }] })
  })

  it('runs one panel prompt over the run route', async () => {
    const routes = new Map<string, (request: Request) => Promise<Response>>()
    const routeCtx = {
      effect: (fn: () => unknown) => fn(),
      get: ctx.get,
      connection: {
        fetch: {
          register: (entry: { path: string, fetch: (request: Request) => Promise<Response> }) => {
            routes.set(entry.path, entry.fetch)
            return () => {}
          },
        },
      },
    } as unknown as Context
    const store = new PanelStore(join(await mkdtemp(join(tmpdir(), 'dsh-pad-run-')), 'panels.json'))
    const panel = await store.create({ title: 'T', html: '', css: '', script: '', height: 'auto', sources: [] })
    const hub = new DataHub(store, async () => undefined, () => {})
    registerRoutes({ ctx: routeCtx, store, hub, refresher: undefined })
    const response = await routes.get('/api/dsh-pad.run')!(new Request('http://local/api/dsh-pad.run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ panelId: panel.id, prompt: 'hi' }),
    }))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, text: 'hello panel' })
  })
})
