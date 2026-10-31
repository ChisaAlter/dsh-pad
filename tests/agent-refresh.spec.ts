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
  const store = new PanelStore(join(dir, 'panels.json'))
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

  it('reconciles a model change during the first store write without creating a stale agent', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-pad-agent-start-'))
    const store = new PanelStore(join(dir, 'panels.json'))
    const panel = await store.create(definition)
    const create = vi.fn(async () => { throw new Error('stale agent must not start') })
    const ctx = { get: (name: string) => name === 'agents' ? { create } : undefined } as unknown as Context
    let wroteInitial: () => void = () => {}
    const initialWritten = new Promise<void>(resolve => { wroteInitial = resolve })
    let returnInitial: () => void = () => {}
    const initialReturn = new Promise<void>(resolve => { returnInitial = resolve })
    const setAgentRun = store.setAgentRun.bind(store)
    vi.spyOn(store, 'setAgentRun').mockImplementation(async (id, run, matches) => {
      const result = await setAgentRun(id, run, matches)
      if (typeof run !== 'function' && run.status === 'running') {
        wroteInitial()
        await initialReturn
      }
      return result
    })
    const refresher = new AgentRefresher(ctx, store, {
      timeoutMs: 1000, concurrency: 1, retryMinutes: 5, workDir: join(dir, 'work'),
    }, () => {})
    try {
      refresher.start()
      refresher.request(panel.id)
      await initialWritten
      await store.setModel(panel.id, { provider: 'mock', model: 'new' })
      returnInitial()
      await vi.waitFor(() => expect(refresher.isBusy(panel.id)).toBe(false))
      expect(create).not.toHaveBeenCalled()
      expect(store.get(panel.id).agentRun?.status).toBe('idle')
      expect(Date.parse(store.get(panel.id).agentRun!.nextRunAt!)).toBeGreaterThan(Date.now() + 59 * 60_000)
    } finally {
      returnInitial()
      refresher.stop()
    }
  })

  it('times out creation, aborts its signal and permits another panel with default concurrency', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-pad-agent-create-'))
    const store = new PanelStore(join(dir, 'panels.json'))
    const first = await store.create(definition)
    const second = await store.create({ ...definition, title: 'Second' })
    const tools = new Map<string, ToolDefinition>()
    let created = 0
    let firstSignal: AbortSignal | undefined
    let entered: () => void = () => {}
    const creationEntered = new Promise<void>(resolve => { entered = resolve })
    let secondFinished: () => void = () => {}
    const secondDisposed = new Promise<void>(resolve => { secondFinished = resolve })
    let resolveCreate: (value: unknown) => void = () => {}
    const pending = new Promise(resolve => { resolveCreate = resolve })
    let lateFinished: () => void = () => {}
    const lateDisposed = new Promise<void>(resolve => { lateFinished = resolve })
    const lateFollowup = vi.fn()
    const lateCancel = vi.fn()
    const lateDispose = vi.fn(async () => { lateFinished() })
    const agents = {
      create: async (options: { signal: AbortSignal, setup: (ctx: unknown) => Promise<void> }) => {
        created += 1
        if (created === 1) { firstSignal = options.signal; entered(); return pending }
        await options.setup({ tools: { register: (tool: ToolDefinition) => { tools.set(tool.name, tool) } } })
        return {
          agent: {
            followup: () => {}, cancel: () => {},
            whenIdle: async () => {
              await (tools.get('pad_submit_data') as unknown as { execute(args: unknown): Promise<string> }).execute({ data: { second: true } })
            },
          },
          dispose: async () => { secondFinished() },
        }
      },
    }
    const ctx = { get: (name: string) => name === 'agents' ? agents : undefined } as unknown as Context
    const refresher = new AgentRefresher(ctx, store, {
      timeoutMs: 150, concurrency: 1, retryMinutes: 5, workDir: join(dir, 'work'),
    }, () => {})
    vi.useFakeTimers()
    try {
      refresher.start()
      refresher.request(first.id)
      await creationEntered
      refresher.request(second.id)
      await vi.advanceTimersByTimeAsync(150)
      await secondDisposed
      expect(firstSignal?.aborted).toBe(true)
      expect(store.get(second.id).agentData?.value).toEqual({ second: true })
      expect(store.get(first.id).agentRun?.error).toMatch(/超时/)
      resolveCreate({ agent: { followup: lateFollowup, cancel: lateCancel }, dispose: lateDispose })
      await lateDisposed
      expect(lateDispose).toHaveBeenCalledTimes(1)
      expect(lateFollowup).not.toHaveBeenCalled()
      expect(lateCancel).toHaveBeenCalledTimes(1)
    } finally {
      refresher.stop()
      resolveCreate({ agent: { cancel: lateCancel }, dispose: lateDispose })
      vi.useRealTimers()
    }
  })

  it('includes preset resolution in the deadline without later creating a timed-out agent', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-pad-agent-preset-'))
    const store = new PanelStore(join(dir, 'panels.json'))
    const panel = await store.create(definition)
    let release: (value: { id: string }) => void = () => {}
    const preset = new Promise<{ id: string }>(resolve => { release = resolve })
    let entered: () => void = () => {}
    const presetEntered = new Promise<void>(resolve => { entered = resolve })
    const resolvePreset = vi.fn(() => { entered(); return preset })
    let failed: () => void = () => {}
    const failureWritten = new Promise<void>(resolve => { failed = resolve })
    const unsubscribe = store.onChange(() => {
      if (store.get(panel.id).agentRun?.status === 'failed') failed()
    })
    const create = vi.fn(async () => { throw new Error('timed-out preset must not start an agent') })
    const ctx = { get: (name: string) => name === 'agents' ? { create }
      : name === 'agentPresets' ? { resolve: resolvePreset } : undefined } as unknown as Context
    const refresher = new AgentRefresher(ctx, store, {
      timeoutMs: 100, concurrency: 1, retryMinutes: 5, workDir: join(dir, 'work'),
    }, () => {})
    vi.useFakeTimers()
    try {
      refresher.start()
      refresher.request(panel.id)
      // Real filesystem work may be slow under the full suite. Advance the
      // deadline only after the run has reached the phase this test exercises.
      await presetEntered
      expect(resolvePreset).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(100)
      await failureWritten
      await vi.advanceTimersByTimeAsync(0)
      expect(store.get(panel.id).agentRun?.error).toMatch(/超时/)
      expect(refresher.isBusy(panel.id)).toBe(false)
      release({ id: 'late' })
      await vi.advanceTimersByTimeAsync(0)
      expect(create).not.toHaveBeenCalled()
    } finally {
      refresher.stop()
      unsubscribe()
      release({ id: 'late' })
      vi.useRealTimers()
    }
  })

  it('bounds lingering disposal across retries and stop/restart and reports exhausted capacity', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-pad-agent-cleanup-'))
    const store = new PanelStore(join(dir, 'panels.json'))
    const panels = await Promise.all(['A', 'B', 'C'].map(title => store.create({ ...definition, title })))
    const release: (() => void)[] = []
    const cancels = [vi.fn(), vi.fn()]
    const entered: (() => void)[] = []
    const disposing = [0, 1].map(() => new Promise<void>(resolve => { entered.push(resolve) }))
    let exhausted: () => void = () => {}
    const capacityReported = new Promise<void>(resolve => { exhausted = resolve })
    const unsubscribe = store.onChange(() => {
      if (store.get(panels[2]!.id).agentRun?.error?.includes('资源尚未退出')) exhausted()
    })
    let created = 0
    const agents = {
      create: async () => {
        const index = created++
        const blocked = new Promise<void>(resolve => { release.push(resolve) })
        return { agent: { followup: () => {}, whenIdle: async () => {}, cancel: cancels[index] }, dispose: () => { entered[index]!(); return blocked } }
      },
    }
    const ctx = { get: (name: string) => name === 'agents' ? agents : undefined } as unknown as Context
    const refresher = new AgentRefresher(ctx, store, {
      timeoutMs: 100, concurrency: 1, retryMinutes: 5, workDir: join(dir, 'work'),
    }, () => {})
    vi.useFakeTimers()
    try {
      refresher.start()
      refresher.request(panels[0]!.id)
      refresher.request(panels[1]!.id)
      refresher.request(panels[2]!.id)
      await disposing[0]
      await vi.advanceTimersByTimeAsync(100)
      await disposing[1]
      await vi.advanceTimersByTimeAsync(100)
      await capacityReported
      await vi.advanceTimersByTimeAsync(0)
      expect(created).toBe(2)
      expect(refresher.isBusy(panels[2]!.id)).toBe(false)
      expect(store.get(panels[0]!.id).agentRun?.error).toMatch(/超时/)
      expect(store.get(panels[1]!.id).agentRun?.error).toMatch(/超时/)
      refresher.stop()
      refresher.start()
      refresher.request(panels[2]!.id)
      // Wait for the rejection's real persistence without advancing its deadline.
      await store.setCollapsed(panels[2]!.id, true)
      expect(refresher.isBusy(panels[2]!.id)).toBe(false)
      expect(created).toBe(2)
      expect(store.get(panels[2]!.id).agentRun?.status).toBe('failed')
    } finally {
      refresher.stop()
      unsubscribe()
      for (const resolve of release) resolve()
      vi.useRealTimers()
    }
  })

  it('can stop and restart before its initial transaction publishes any running status', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-pad-agent-early-stop-'))
    const store = new PanelStore(join(dir, 'panels.json'))
    const panel = await store.create(definition)
    const create = vi.fn(async () => ({
      agent: { followup: () => {}, whenIdle: async () => {}, cancel: () => {} }, dispose: async () => {},
    }))
    const ctx = { get: (name: string) => name === 'agents' ? { create } : undefined } as unknown as Context
    const refresher = new AgentRefresher(ctx, store, {
      timeoutMs: 1000, concurrency: 1, retryMinutes: 5, workDir: join(dir, 'work'),
    }, () => {})
    try {
      refresher.start()
      refresher.request(panel.id)
      refresher.stop()
      // A barrier on the same store queue lets the cancelled claim drain.
      await store.setCollapsed(panel.id, true)
      expect(store.get(panel.id).agentRun?.status).toBe('idle')
      expect(create).not.toHaveBeenCalled()
      refresher.start()
      refresher.request(panel.id)
      await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1))
      await vi.waitFor(() => expect(refresher.isBusy(panel.id)).toBe(false))
      expect(store.get(panel.id).agentRun?.status).toBe('failed')
    } finally {
      refresher.stop()
    }
  })

  it('stops creation immediately and does not let its late completion overwrite restarted work', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-pad-agent-restart-'))
    const store = new PanelStore(join(dir, 'panels.json'))
    const first = await store.create(definition)
    const second = await store.create({ ...definition, title: 'Second' })
    let created = 0
    let firstSignal: AbortSignal | undefined
    let resolveCreate: (value: unknown) => void = () => {}
    const pending = new Promise(resolve => { resolveCreate = resolve })
    const lateDispose = vi.fn(async () => {})
    const agents = {
      create: async (options: { signal: AbortSignal }) => {
        created += 1
        if (created === 1) { firstSignal = options.signal; return pending }
        return { agent: { followup: () => {}, whenIdle: async () => {}, cancel: () => {} }, dispose: async () => {} }
      },
    }
    const ctx = { get: (name: string) => name === 'agents' ? agents : undefined } as unknown as Context
    const refresher = new AgentRefresher(ctx, store, {
      timeoutMs: 1000, concurrency: 1, retryMinutes: 5, workDir: join(dir, 'work'),
    }, () => {})
    try {
      refresher.start()
      refresher.request(first.id)
      await vi.waitFor(() => expect(created).toBe(1))
      refresher.stop()
      expect(firstSignal?.aborted).toBe(true)
      refresher.start()
      refresher.request(second.id)
      await vi.waitFor(() => expect(created).toBe(2))
      await vi.waitFor(() => expect(refresher.isBusy(second.id)).toBe(false))
      const secondState = store.get(second.id).agentRun
      resolveCreate({ agent: { cancel: () => {}, followup: () => { throw new Error('old generation must not start') } }, dispose: lateDispose })
      await vi.waitFor(() => expect(lateDispose).toHaveBeenCalledTimes(1))
      expect(store.get(second.id).agentRun).toBe(secondState)
      expect(store.get(first.id).agentRun?.status).toBe('failed')
    } finally {
      refresher.stop()
      resolveCreate({ agent: { cancel: () => {} }, dispose: lateDispose })
    }
  })

  it('retries a transient final state write without retaining busy work or starting another agent', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-pad-agent-state-retry-'))
    const store = new PanelStore(join(dir, 'panels.json'))
    const panel = await store.create(definition)
    const tools = new Map<string, ToolDefinition>()
    let rejected: () => void = () => {}
    const finalRejected = new Promise<void>(resolve => { rejected = resolve })
    let settled: () => void = () => {}
    const finalWritten = new Promise<void>(resolve => { settled = resolve })
    let failOnce = true
    const setAgentRun = store.setAgentRun.bind(store)
    vi.spyOn(store, 'setAgentRun').mockImplementation(async (id, run, matches) => {
      if (typeof run === 'function' && failOnce) {
        failOnce = false
        rejected()
        throw Object.assign(new Error('one final rename failed'), { code: 'EIO' })
      }
      return setAgentRun(id, run, matches)
    })
    const unsubscribe = store.onChange(() => {
      if (store.get(panel.id).agentRun?.status === 'idle') settled()
    })
    const create = vi.fn(async (options: { setup: (ctx: unknown) => Promise<void> }) => {
      await options.setup({ tools: { register: (tool: ToolDefinition) => tools.set(tool.name, tool) } })
      return { agent: {
        followup: () => {}, cancel: () => {},
        whenIdle: async () => {
          await (tools.get('pad_submit_data') as unknown as { execute(args: unknown): Promise<string> }).execute({ data: { fresh: true } })
        },
      }, dispose: async () => {} }
    })
    const changed = vi.fn()
    const ctx = { get: (name: string) => name === 'agents' ? { create } : undefined } as unknown as Context
    const refresher = new AgentRefresher(ctx, store, {
      timeoutMs: 10_000, concurrency: 1, retryMinutes: 5, workDir: join(dir, 'work'),
    }, changed)
    vi.useFakeTimers()
    try {
      refresher.start()
      refresher.request(panel.id)
      await finalRejected
      await vi.advanceTimersByTimeAsync(0)
      expect(refresher.isBusy(panel.id)).toBe(false)
      expect(store.get(panel.id).agentRun?.status).toBe('running')
      await vi.advanceTimersByTimeAsync(250)
      await finalWritten
      await vi.advanceTimersByTimeAsync(0)
      expect(store.get(panel.id).agentRun?.status).toBe('idle')
      expect(create).toHaveBeenCalledTimes(1)
      expect(changed).toHaveBeenCalledTimes(1)
      expect(store.get(panel.id).agentData?.value).toEqual({ fresh: true })
    } finally {
      refresher.stop()
      unsubscribe()
      vi.useRealTimers()
    }
  })

  it('retries an interrupted startup state write after one transient persistence failure', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-pad-agent-startup-retry-'))
    const store = new PanelStore(join(dir, 'panels.json'))
    const panel = await store.create(definition)
    const nextRunAt = panel.agentRun!.nextRunAt
    await store.setAgentRun(panel.id, { ...panel.agentRun, status: 'running' })
    let failed: () => void = () => {}
    const recoveryFailed = new Promise<void>(resolve => { failed = resolve })
    let settled: () => void = () => {}
    const recoveryWritten = new Promise<void>(resolve => { settled = resolve })
    let failOnce = true
    const setAgentRun = store.setAgentRun.bind(store)
    vi.spyOn(store, 'setAgentRun').mockImplementation(async (id, run, matches) => {
      if (typeof run === 'function' && failOnce) {
        failOnce = false
        failed()
        throw Object.assign(new Error('startup recovery rename EIO'), { code: 'EIO' })
      }
      return setAgentRun(id, run, matches)
    })
    const unsubscribe = store.onChange(() => {
      if (store.get(panel.id).agentRun?.status === 'failed') settled()
    })
    const create = vi.fn(async () => { throw new Error('future startup panel must not run') })
    const ctx = { get: (name: string) => name === 'agents' ? { create } : undefined } as unknown as Context
    const refresher = new AgentRefresher(ctx, store, {
      timeoutMs: 10_000, concurrency: 1, retryMinutes: 5, workDir: join(dir, 'work'),
    }, () => {})
    vi.useFakeTimers()
    try {
      refresher.start()
      await recoveryFailed
      await vi.advanceTimersByTimeAsync(0)
      expect(store.get(panel.id).agentRun?.status).toBe('running')
      expect(refresher.isBusy(panel.id)).toBe(false)
      await vi.advanceTimersByTimeAsync(250)
      await recoveryWritten
      expect(store.get(panel.id).agentRun).toMatchObject({ status: 'failed', error: '上次刷新被中断', nextRunAt })
      expect(create).not.toHaveBeenCalled()
    } finally {
      refresher.stop()
      unsubscribe()
      vi.useRealTimers()
    }
  })

  it('retains an old pending final write when a requested replacement claim also fails', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-pad-agent-retry-claim-'))
    const store = new PanelStore(join(dir, 'panels.json'))
    const panel = await store.create(definition)
    let rejectedFinal: () => void = () => {}
    const finalRejected = new Promise<void>(resolve => { rejectedFinal = resolve })
    let enteredClaim: () => void = () => {}
    const claimEntered = new Promise<void>(resolve => { enteredClaim = resolve })
    let releaseClaim: () => void = () => {}
    const claimRelease = new Promise<void>(resolve => { releaseClaim = resolve })
    let rejectedClaim: () => void = () => {}
    const claimRejected = new Promise<void>(resolve => { rejectedClaim = resolve })
    let settled: () => void = () => {}
    const finalWritten = new Promise<void>(resolve => { settled = resolve })
    let finalFailed = false
    let claimFailed = false
    const setAgentRun = store.setAgentRun.bind(store)
    vi.spyOn(store, 'setAgentRun').mockImplementation(async (id, run, matches) => {
      if (typeof run === 'function' && !finalFailed) {
        finalFailed = true
        rejectedFinal()
        throw Object.assign(new Error('final rename EIO'), { code: 'EIO' })
      }
      if (typeof run !== 'function' && run.status === 'running' && finalFailed && !claimFailed) {
        claimFailed = true
        enteredClaim()
        await claimRelease
        rejectedClaim()
        throw Object.assign(new Error('replacement claim rename EIO'), { code: 'EIO' })
      }
      return setAgentRun(id, run, matches)
    })
    const unsubscribe = store.onChange(() => {
      if (store.get(panel.id).agentRun?.status === 'idle') settled()
    })
    const tools = new Map<string, ToolDefinition>()
    const create = vi.fn(async (options: { setup: (ctx: unknown) => Promise<void> }) => {
      await options.setup({ tools: { register: (tool: ToolDefinition) => tools.set(tool.name, tool) } })
      return { agent: {
        followup: () => {}, cancel: () => {}, whenIdle: async () => {
          await (tools.get('pad_submit_data') as unknown as { execute(args: unknown): Promise<string> }).execute({ data: { retained: true } })
        },
      }, dispose: async () => {} }
    })
    const changed = vi.fn()
    const ctx = { get: (name: string) => name === 'agents' ? { create } : undefined } as unknown as Context
    const refresher = new AgentRefresher(ctx, store, {
      timeoutMs: 10_000, concurrency: 1, retryMinutes: 5, workDir: join(dir, 'work'),
    }, changed)
    vi.useFakeTimers()
    try {
      refresher.start()
      refresher.request(panel.id)
      await finalRejected
      await vi.advanceTimersByTimeAsync(0)
      expect(refresher.isBusy(panel.id)).toBe(false)
      refresher.request(panel.id)
      await claimEntered
      expect(refresher.isBusy(panel.id)).toBe(true)
      // An uncommitted replacement intent must not discard the old CAS when
      // its retry fires, even if that replacement later fails to persist.
      await vi.advanceTimersByTimeAsync(250)
      await finalWritten
      releaseClaim()
      await claimRejected
      await vi.advanceTimersByTimeAsync(0)
      expect(refresher.isBusy(panel.id)).toBe(false)
      expect(store.get(panel.id).agentRun?.status).toBe('idle')
      expect(store.get(panel.id).agentData?.value).toEqual({ retained: true })
      expect(create).toHaveBeenCalledTimes(1)
      expect(changed).toHaveBeenCalledTimes(1)
    } finally {
      releaseClaim()
      refresher.stop()
      unsubscribe()
      vi.useRealTimers()
    }
  })

  it('reconciles a failed final write after a model edit using the new regular interval', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-pad-agent-retry-model-'))
    const store = new PanelStore(join(dir, 'panels.json'))
    const panel = await store.create(definition)
    let rejected: () => void = () => {}
    const finalRejected = new Promise<void>(resolve => { rejected = resolve })
    let failOnce = true
    const setAgentRun = store.setAgentRun.bind(store)
    vi.spyOn(store, 'setAgentRun').mockImplementation(async (id, run, matches) => {
      if (typeof run === 'function' && failOnce) {
        failOnce = false
        rejected()
        throw Object.assign(new Error('one final rename failed'), { code: 'EIO' })
      }
      return setAgentRun(id, run, matches)
    })
    let settled: () => void = () => {}
    const finalWritten = new Promise<void>(resolve => { settled = resolve })
    const unsubscribe = store.onChange(() => {
      if (store.get(panel.id).agentRun?.status === 'idle') settled()
    })
    const create = vi.fn(async () => ({ agent: {
      followup: () => {}, cancel: () => {}, whenIdle: async () => {},
    }, dispose: async () => {} }))
    const changed = vi.fn()
    const ctx = { get: (name: string) => name === 'agents' ? { create } : undefined } as unknown as Context
    const refresher = new AgentRefresher(ctx, store, {
      timeoutMs: 10_000, concurrency: 1, retryMinutes: 5, workDir: join(dir, 'work'),
    }, changed)
    vi.useFakeTimers()
    try {
      refresher.start()
      refresher.request(panel.id)
      await finalRejected
      await vi.advanceTimersByTimeAsync(0)
      expect(refresher.isBusy(panel.id)).toBe(false)
      await store.setModel(panel.id, { provider: 'mock', model: 'new' })
      expect(store.get(panel.id).agentRun?.status).toBe('running')
      await vi.advanceTimersByTimeAsync(250)
      await finalWritten
      await vi.advanceTimersByTimeAsync(0)
      expect(store.get(panel.id).agentRun?.status).toBe('idle')
      expect(store.get(panel.id).agentRun?.error).toBeUndefined()
      expect(Date.parse(store.get(panel.id).agentRun!.nextRunAt!)).toBeGreaterThan(Date.now() + 59 * 60_000)
      expect(create).toHaveBeenCalledTimes(1)
      expect(changed).not.toHaveBeenCalled()
    } finally {
      refresher.stop()
      unsubscribe()
      vi.useRealTimers()
    }
  })

  it('abandons pending terminal retries after stop or a replacement run claims the state', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-pad-agent-retry-ownership-'))
    const store = new PanelStore(join(dir, 'panels.json'))
    const panel = await store.create(definition)
    let failures = 0
    let rejected: () => void = () => {}
    const finalRejected = new Promise<void>(resolve => { rejected = resolve })
    const setAgentRun = store.setAgentRun.bind(store)
    vi.spyOn(store, 'setAgentRun').mockImplementation(async (id, run, matches) => {
      if (typeof run === 'function') {
        failures += 1
        rejected()
        throw Object.assign(new Error('final write unavailable'), { code: 'EIO' })
      }
      return setAgentRun(id, run, matches)
    })
    const create = vi.fn(async () => ({ agent: {
      followup: () => {}, cancel: () => {}, whenIdle: async () => {},
    }, dispose: async () => {} }))
    const ctx = { get: (name: string) => name === 'agents' ? { create } : undefined } as unknown as Context
    const refresher = new AgentRefresher(ctx, store, {
      timeoutMs: 10_000, concurrency: 1, retryMinutes: 5, workDir: join(dir, 'work'),
    }, () => {})
    vi.useFakeTimers()
    try {
      refresher.start()
      refresher.request(panel.id)
      await finalRejected
      await vi.advanceTimersByTimeAsync(0)
      const replacement = { status: 'idle' as const, nextRunAt: '2030-01-01T00:00:00.000Z' }
      await store.setAgentRun(panel.id, replacement)
      await vi.advanceTimersByTimeAsync(1000)
      expect(failures).toBe(1)
      expect(store.get(panel.id).agentRun).toBe(replacement)
      refresher.stop()
      await vi.advanceTimersByTimeAsync(10_000)
      expect(failures).toBe(1)
      expect(create).toHaveBeenCalledTimes(1)
    } finally {
      refresher.stop()
      vi.useRealTimers()
    }
  })

  it('recomputes final status inside the transaction after a queued model edit', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-pad-agent-final-order-'))
    const store = new PanelStore(join(dir, 'panels.json'))
    const panel = await store.create(definition)
    let finishIdle: () => void = () => {}
    const idle = new Promise<void>(resolve => { finishIdle = resolve })
    let entered: () => void = () => {}
    const idleEntered = new Promise<void>(resolve => { entered = resolve })
    let releaseTransaction: () => void = () => {}
    const transactionReturn = new Promise<void>(resolve => { releaseTransaction = resolve })
    const create = vi.fn(async () => ({ agent: {
      followup: () => {}, cancel: () => {}, whenIdle: () => { entered(); return idle },
    }, dispose: async () => {} }))
    const notify = vi.fn()
    const ctx = { get: (name: string) => name === 'agents' ? { create } : undefined } as unknown as Context
    const refresher = new AgentRefresher(ctx, store, {
      timeoutMs: 10_000, concurrency: 1, retryMinutes: 5, workDir: join(dir, 'work'),
    }, notify)
    let queuedFinal: () => void = () => {}
    const finalQueued = new Promise<void>(resolve => { queuedFinal = resolve })
    const setAgentRun = store.setAgentRun.bind(store)
    vi.spyOn(store, 'setAgentRun').mockImplementation((id, run, matches) => {
      const result = setAgentRun(id, run, matches)
      if (typeof run === 'function') queuedFinal()
      return result
    })
    try {
      refresher.start()
      refresher.request(panel.id)
      await idleEntered
      // Hold a real store transaction after its disk commit, then enqueue the
      // menu edit ahead of finalization. Final state must use that new model.
      const commit = (store as unknown as { commit: (panels: unknown[]) => Promise<void> }).commit.bind(store)
      vi.spyOn(store as unknown as { commit: (panels: unknown[]) => Promise<void> }, 'commit').mockImplementationOnce(async panels => {
        await commit(panels)
        await transactionReturn
      })
      const barrier = store.setSpan(panel.id, 2)
      const editing = store.setModel(panel.id, { provider: 'mock', model: 'new' })
      finishIdle()
      // Finalization has now been queued behind the edit while the listener is
      // removed, reproducing the otherwise rare persistence ordering window.
      await finalQueued
      releaseTransaction()
      await Promise.all([barrier, editing])
      await vi.waitFor(() => expect(refresher.isBusy(panel.id)).toBe(false))
      expect(store.get(panel.id).agentRun?.status).toBe('idle')
      expect(store.get(panel.id).agentRun?.error).toBeUndefined()
      expect(Date.parse(store.get(panel.id).agentRun!.nextRunAt!)).toBeGreaterThan(Date.now() + 59 * 60_000)
      expect(create).toHaveBeenCalledTimes(1)
      expect(notify).not.toHaveBeenCalled()
    } finally {
      finishIdle()
      releaseTransaction()
      refresher.stop()
    }
  })

  it('cancels the running turn and disposes its handle on stop', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-pad-agent-'))
    const store = new PanelStore(join(dir, 'panels.json'))
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
