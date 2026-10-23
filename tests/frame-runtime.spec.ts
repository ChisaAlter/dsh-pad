import { describe, expect, it } from 'vitest'
import { FRAME_RUNTIME } from '../src/client/frame-runtime.ts'

interface Posted {
  readonly kind?: string
  readonly message?: string
  readonly token?: string
}

/**
 * Run the frame runtime against a stubbed document/window and give back the
 * messages it posts to the dock plus its `dsh` object.
 */
function bootFrame(data: unknown): { posted: Posted[], dsh: any, sendData(next: unknown): void } {
  const posted: Posted[] = []
  const handlers = new Map<string, (event: any) => void>()
  const parent = { postMessage: (message: Posted): void => { posted.push(message) } }
  const documentStub = {
    documentElement: { getAttribute: (): string => 'test-token', setAttribute: (): void => {} },
    getElementById: (id: string): { textContent: string } => ({
      textContent: id === 'pad-init' ? JSON.stringify({ data, histories: {}, state: {}, lang: 'zh' }) : '',
    }),
    addEventListener: (): void => {},
    body: { scrollHeight: 10 },
  }
  const windowStub = {
    parent,
    addEventListener: (type: string, handler: (event: any) => void): void => { handlers.set(type, handler) },
    dsh: undefined as unknown,
  }

  new Function('window', 'document', 'ResizeObserver', FRAME_RUNTIME)(windowStub, documentStub, undefined)

  return {
    posted,
    dsh: (windowStub as { dsh: any }).dsh,
    sendData(next: unknown) {
      const handler = handlers.get('message')
      if (handler === undefined) throw new Error('the frame did not listen for messages')
      handler({ source: parent, data: { kind: 'data', data: next, histories: {}, token: 'test-token' } })
    },
  }
}

const reading = { ok: true, value: { total: 1 }, at: new Date().toISOString() }
const data = { sources: { metric: reading }, agent: null }

describe('frame runtime', () => {
  it('is valid inline JavaScript', () => {
    expect(() => new Function(FRAME_RUNTIME)).not.toThrow()
  })

  it('reports a render that worked so a stale error can be cleared', () => {
    const frame = bootFrame(data)
    expect(frame.posted.some(message => message.kind === 'ready')).toBe(true)
    frame.posted.length = 0
    frame.dsh.onData(() => {})
    frame.sendData(data)
    expect(frame.posted).toContainEqual({ kind: 'ok', token: 'test-token' })
  })

  it('reports a throwing render and no success for it', () => {
    const frame = bootFrame(null)
    frame.dsh.onData(() => { throw new Error('boom') })
    frame.sendData(data)
    const kinds = frame.posted.map(message => message.kind)
    expect(kinds).toContain('error')
    expect(kinds).not.toContain('ok')
    expect(frame.posted.find(message => message.kind === 'error')?.message).toContain('boom')
  })

  it('stays quiet for a script that never subscribed to data', () => {
    // A panel that threw before `dsh.onData(...)` must keep its error visible:
    // clearing it on the next data set would hide a dead panel.
    const frame = bootFrame(null)
    frame.posted.length = 0
    frame.sendData(data)
    expect(frame.posted).toEqual([])
  })
})
