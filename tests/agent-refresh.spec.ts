import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { AgentRefresher } from '../src/host/agent-refresh.ts'
import { PanelStore } from '../src/host/store.ts'
import type { PanelDefinition } from '../src/shared/types.ts'

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

const definition: PanelDefinition = {
  title: 'Agent panel', html: '', css: '', script: '', height: 'auto', sources: [],
  agent: { instruction: 'take a reading', everyMinutes: 60 },
}

async function controlledRefresh(cancelSettles = true) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-pad-agent-'))
  const store = new PanelStore(join(dir, 'panels.json'), false)
  const panel = await store.create(definition, { initial: true })
  const tools = new Map<string, ToolDefinition>()
  let resolveIdle: () => void = () => {}
  const idle = new Promise<void>(resolve => { resolveIdle = resolve })
  const cancel = vi.fn(() => { if (cancelSettles) resolveIdle() })
  const dispose = vi.fn(async () => {})
  const agents = {
    create: async (options: { setup: (ctx: unknown) => Promise<void> }) => {
      await options.setup({ tools: { register: (tool: ToolDefinition) => { tools.set(tool.name, tool) } } })
      return { agent: { followup: () => {}, whenIdle: () => idle, cancel }, dispose }
    },
  }
  const ctx = { get: (name: string) => name === 'agents' ? agents : undefined } as unknown as Context
  const refresher = new AgentRefresher(ctx, store, {
    timeoutMs: 10_000, concurrency: 1, retryMinutes: 5, workDir: join(dir, 'work'),
  }, () => {})
  refresher.start()
  refresher.request(panel.id)
  await vi.waitFor(() => expect(tools.has('pad_submit_data')).toBe(true))
  const call = async (name: string, args: Record<string, unknown>) => {
    const tool = tools.get(name) as unknown as { execute(args: unknown): Promise<string> }
    return tool.execute(args)
  }
  const finish = async () => {
    resolveIdle()
    await vi.waitFor(() => expect(refresher.isBusy(panel.id)).toBe(false))
  }
  return { store, panel, refresher, call, finish, cancel, dispose }
}

describe('AgentRefresher', () => {
  it('rejects stale submissions after the refresh definition changes', async () => {
    const { store, panel, refresher, call, finish, cancel } = await controlledRefresh()
    try {
      await store.update(panel.id, { ...definition, agent: { instruction: 'read a different shape', everyMinutes: 30 } }, { current: true })
      const nextRun = store.get(panel.id).agentRun
      await expect(call('pad_submit_data', { data: { stale: true } })).rejects.toThrow(/变|停止/)
      expect(cancel).toHaveBeenCalledTimes(1)
      await finish()
      expect(store.get(panel.id).agentData?.value).toEqual({ current: true })
      expect(store.get(panel.id).agentRun).toEqual(nextRun)
    } finally {
      refresher.stop()
    }
  })

  it('reschedules a changed panel and disposes a cancelled turn that never becomes idle', async () => {
    const { store, panel, refresher, cancel, dispose, finish } = await controlledRefresh(false)
    try {
      await store.update(panel.id, { ...definition, css: 'b{}' })
      expect(cancel).toHaveBeenCalledTimes(1)
      await vi.waitFor(() => expect(dispose).toHaveBeenCalledTimes(1))
      await vi.waitFor(() => expect(refresher.isBusy(panel.id)).toBe(false))
      expect(store.get(panel.id).agentRun?.status).toBe('idle')
      expect(Date.parse(store.get(panel.id).agentRun!.nextRunAt!)).toBeGreaterThan(Date.now() + 59 * 60_000)
    } finally {
      refresher.stop()
      await finish()
    }
  })

  it('rejects retained tool calls after the turn has finished', async () => {
    const { store, panel, refresher, call, finish } = await controlledRefresh()
    try {
      await finish()
      await expect(call('pad_submit_data', { data: { late: true } })).rejects.toThrow(/结束|停止/)
      expect(store.get(panel.id).agentData?.value).toEqual({ initial: true })
    } finally {
      refresher.stop()
    }
  })

  it('accepts at most one terminal submission per turn', async () => {
    const { store, panel, refresher, call, finish } = await controlledRefresh()
    try {
      await call('pad_submit_data', { data: { first: true } })
      await expect(call('pad_submit_data', { data: { second: true } })).rejects.toThrow(/提交|结束/)
      await finish()
      expect(store.get(panel.id).agentData?.value).toEqual({ first: true })
    } finally {
      refresher.stop()
    }
  })

  it('cancels the running turn and disposes its handle on stop', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-pad-agent-'))
    const store = new PanelStore(join(dir, 'panels.json'), false)
    const panel = await store.create(definition)
    let created = 0
    let cancelled = 0
    let disposed = 0
    let resolveIdle: (() => void) | undefined

    const agents = {
      create: async () => {
        created += 1
        return {
          agent: {
            followup: () => {},
            whenIdle: () => new Promise<void>(resolve => { resolveIdle = resolve }),
            cancel: () => {
              cancelled += 1
              resolveIdle?.()
            },
          },
          dispose: async () => { disposed += 1 },
        }
      },
    }
    const ctx = {
      get: (name: string) => name === 'agents' ? agents : undefined,
    } as unknown as Context

    const refresher = new AgentRefresher(ctx, store, {
      timeoutMs: 10_000,
      concurrency: 1,
      retryMinutes: 5,
      workDir: join(dir, 'work'),
    }, () => {})
    refresher.start()
    refresher.request(panel.id)
    await vi.waitFor(() => expect(created).toBe(1), { timeout: 5000 })
    await vi.waitFor(() => expect(resolveIdle).toBeDefined(), { timeout: 5000 })
    expect(refresher.isBusy(panel.id)).toBe(true)

    refresher.stop()
    expect(cancelled).toBe(1)
    await vi.waitFor(() => expect(disposed).toBe(1), { timeout: 5000 })
    expect(refresher.isBusy(panel.id)).toBe(false)

    refresher.request(panel.id)
    await sleep(50)
    expect(created).toBe(1)
  })
})
