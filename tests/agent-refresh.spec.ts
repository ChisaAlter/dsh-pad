import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { AgentRefresher } from '../src/host/agent-refresh.ts'
import { PanelStore } from '../src/host/store.ts'
import type { PanelDefinition } from '../src/shared/types.ts'

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

const definition: PanelDefinition = {
  title: 'Agent panel', html: '', css: '', script: '', height: 'auto', sources: [],
  agent: { instruction: 'take a reading', everyMinutes: 60 },
}

describe('AgentRefresher', () => {
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
    await sleep(200)
    expect(created).toBe(1)
    expect(refresher.isBusy(panel.id)).toBe(true)

    refresher.stop()
    await sleep(100)
    expect(cancelled).toBe(1)
    expect(disposed).toBe(1)
    expect(refresher.isBusy(panel.id)).toBe(false)

    refresher.request(panel.id)
    await sleep(50)
    expect(created).toBe(1)
  })
})
