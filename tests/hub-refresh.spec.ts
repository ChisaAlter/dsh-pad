import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DataHub } from '../src/host/hub.ts'
import { PanelStore } from '../src/host/store.ts'

async function setup(): Promise<{ store: PanelStore, hub: DataHub, refreshRequests: string[] }> {
  const store = new PanelStore(join(await mkdtemp(join(tmpdir(), 'dsh-pad-refresh-')), 'panels.json'))
  const refreshRequests: string[] = []
  const hub = new DataHub(store, async () => undefined, panelId => { refreshRequests.push(panelId) })
  return { store, hub, refreshRequests }
}

/** Poll until `check` holds, so a fire-and-forget run can settle. */
async function waitFor(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for the reading')
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

const command = (id: string) => ({ id, kind: 'command' as const, command: 'echo hi', parse: 'text' as const, intervalSec: 60 })

describe('refresh action', () => {
  it('runs a panel\'s sources immediately, with no approval step in the way', async () => {
    const { store, hub } = await setup()
    const panel = await store.create({ title: '负载', html: '', css: '', script: '', height: 'auto', sources: [command('load')] })
    expect(hub.views()[0]?.data.sources['load']).toBeUndefined()
    hub.refresh(panel.id)
    await waitFor(() => hub.views()[0]?.data.sources['load'] !== undefined)
    const reading = hub.views()[0]?.data.sources['load']
    expect(reading?.ok).toBe(true)
    expect(reading?.value).toBe('hi')
    hub.dispose()
  })

  it('asks for an agent refresh for a panel that has one', async () => {
    const { store, hub, refreshRequests } = await setup()
    const panel = await store.create({
      title: '余额',
      html: '',
      css: '',
      script: '',
      height: 'auto',
      sources: [],
      agent: { instruction: '查余额', everyMinutes: 60 },
    })
    hub.refresh(panel.id)
    expect(refreshRequests).toEqual([panel.id])
    hub.dispose()
  })
})
