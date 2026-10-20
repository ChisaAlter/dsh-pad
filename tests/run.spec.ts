import { describe, expect, it } from 'vitest'
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

  it('can be disabled', async () => {
    const result = await new PanelRunner(context([]), { ...DEFAULT_RUN_OPTIONS, enabled: false }).run(panel, 'hi')
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/关闭/)
  })
})
