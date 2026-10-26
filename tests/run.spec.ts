import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { DEFAULT_RUN_OPTIONS, PanelRunner } from '../src/host/run.ts'

const panel = {
  id: 'p_test',
  version: 1,
  position: 0,
  collapsed: false,
  span: 1 as const,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  definition: {
    title: 'T',
    html: '',
    css: '',
    script: '',
    height: 'auto' as const,
    sources: [],
    model: { provider: 'magpie', model: 'fast' },
  },
}

function context(chunks: readonly unknown[]): Context {
  return {
    get: (name: string) => {
      if (name === 'llm') {
        return {
          stream: async function* () {
            for (const chunk of chunks) yield chunk
          },
        }
      }
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'magpie', model: 'default' }) }
      return undefined
    },
  } as unknown as Context
}

describe('PanelRunner', () => {
  it('uses the panel model and joins text deltas', async () => {
    const seen: Record<string, unknown>[] = []
    const ctx = {
      get: (name: string) => {
        if (name === 'llm') {
          return {
            stream: async function* (options: Record<string, unknown>) {
              seen.push(options)
              yield { type: 'text-delta', text: 'Hello ' }
              yield { type: 'text-delta', text: 'panel' }
              yield { type: 'finish', reason: { kind: 'stop' } }
            },
          }
        }
        if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'other', model: 'fallback' }) }
        return undefined
      },
    } as unknown as Context
    const result = await new PanelRunner(ctx, { ...DEFAULT_RUN_OPTIONS }).run(panel, '  summarize  ')
    expect(result).toEqual({ ok: true, text: 'Hello panel' })
    expect(seen[0]).toMatchObject({
      provider: 'magpie',
      model: 'fast',
      maxTokens: DEFAULT_RUN_OPTIONS.maxTokens,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'summarize' }] }],
    })
  })

  it('reports a model failure and rejects an empty prompt', async () => {
    const failed = await new PanelRunner(context([{ type: 'finish', reason: { kind: 'error', failure: { message: 'nope' } } }]))
      .run(panel, 'hi')
    expect(failed).toEqual({ ok: false, error: 'nope' })
    const empty = await new PanelRunner(context([])).run(panel, '   ')
    expect(empty.ok).toBe(false)
  })

  it('ends at its timeout but keeps a concurrency slot until an uncooperative provider stops', async () => {
    vi.useFakeTimers()
    let release: () => void = () => {}
    const blocked = new Promise<void>(resolve => { release = resolve })
    let calls = 0
    const signals: AbortSignal[] = []
    const ctx = { get: (name: string) => name === 'llm' ? {
      stream: async function* (options: { signal: AbortSignal }) {
        signals.push(options.signal)
        calls += 1
        if (calls === 1) await blocked
        yield { type: 'text-delta', text: 'done' }
      },
    } : undefined } as unknown as Context
    const runner = new PanelRunner(ctx, { ...DEFAULT_RUN_OPTIONS, timeoutMs: 20, concurrency: 1, minIntervalMs: 0 })
    try {
      let settled = false
      const running = runner.run(panel, 'first').then(result => { settled = true; return result })
      await vi.advanceTimersByTimeAsync(20)
      expect(signals[0]?.aborted).toBe(true)
      expect(settled).toBe(true)
      expect(await running).toEqual({ ok: false, error: '模型调用超时' })
      expect((await runner.run(panel, 'second')).error).toMatch(/同时进行/)
      release()
      await vi.advanceTimersByTimeAsync(0)
      expect(await runner.run(panel, 'third')).toEqual({ ok: true, text: 'done' })
    } finally {
      release()
      vi.useRealTimers()
    }
  })

  it('does not report a partial answer as success after a timeout', async () => {
    vi.useFakeTimers()
    const ctx = { get: (name: string) => name === 'llm' ? {
      stream: async function* (options: { signal: AbortSignal }) {
        yield { type: 'text-delta', text: 'partial' }
        await new Promise<void>(resolve => options.signal.addEventListener('abort', () => resolve(), { once: true }))
      },
    } : undefined } as unknown as Context
    try {
      const running = new PanelRunner(ctx, { ...DEFAULT_RUN_OPTIONS, timeoutMs: 20 }).run(panel, 'hi')
      await vi.advanceTimersByTimeAsync(20)
      expect(await running).toEqual({ ok: false, error: '模型调用超时' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancels an active call and refuses new calls after disposal', async () => {
    let started: () => void = () => {}
    const ready = new Promise<void>(resolve => { started = resolve })
    let seen: AbortSignal | undefined
    const ctx = { get: (name: string) => name === 'llm' ? {
      stream: async function* (options: { signal: AbortSignal }) {
        seen = options.signal
        started()
        await new Promise<void>(resolve => options.signal.addEventListener('abort', () => resolve(), { once: true }))
      },
    } : undefined } as unknown as Context
    const runner = new PanelRunner(ctx)
    const running = runner.run(panel, 'hi')
    await ready
    runner.dispose()
    expect(seen?.aborted).toBe(true)
    expect(await running).toEqual({ ok: false, error: '模型调用被中止' })
    expect((await runner.run(panel, 'again')).error).toMatch(/停止/)
  })

  it('cancels an active call when the request aborts, without consuming a slot for pre-aborted requests', async () => {
    const seen: AbortSignal[] = []
    const ctx = { get: (name: string) => name === 'llm' ? {
      stream: async function* (options: { signal: AbortSignal }) {
        seen.push(options.signal)
        await new Promise<void>(resolve => options.signal.addEventListener('abort', () => resolve(), { once: true }))
      },
    } : undefined } as unknown as Context
    const runner = new PanelRunner(ctx, { ...DEFAULT_RUN_OPTIONS, minIntervalMs: 0, concurrency: 1 })
    const controller = new AbortController()
    const running = runner.run(panel, 'hi', undefined, controller.signal)
    controller.abort()
    expect(await running).toEqual({ ok: false, error: '模型调用被中止' })
    expect(seen[0]?.aborted).toBe(true)
    expect(await runner.run(panel, 'again', undefined, controller.signal)).toEqual({ ok: false, error: '模型调用被中止' })
    expect(seen).toHaveLength(1)
    runner.dispose()
  })

  it('limits concurrent model calls per panel and releases the slot after completion', async () => {
    let release: () => void = () => {}
    const blocked = new Promise<void>(resolve => { release = resolve })
    const ctx = { get: (name: string) => name === 'llm' ? {
      stream: async function* () {
        await blocked
        yield { type: 'text-delta', text: 'done' }
      },
    } : undefined } as unknown as Context
    const runner = new PanelRunner(ctx, { ...DEFAULT_RUN_OPTIONS, minIntervalMs: 0, concurrency: 1 })
    const running = runner.run(panel, 'first')
    expect((await runner.run(panel, 'second')).error).toMatch(/同时进行/)
    release()
    expect(await running).toEqual({ ok: true, text: 'done' })
    expect(await runner.run(panel, 'third')).toEqual({ ok: true, text: 'done' })
  })

  it('can be disabled', async () => {
    const result = await new PanelRunner(context([]), { ...DEFAULT_RUN_OPTIONS, enabled: false }).run(panel, 'hi')
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/关闭/)
  })
})
