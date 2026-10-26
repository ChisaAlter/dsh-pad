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
function bootFrame(data: unknown, heightMode = 'auto') {
  const posted: Posted[] = []
  const attributes = new Map([['data-token', 'test-token'], ['data-height', heightMode]])
  let sizeReads = 0
  let resizeCallback = (): void => {}
  class Observer {
    constructor(callback: () => void) { resizeCallback = callback }
    observe(): void {}
    disconnect(): void {}
  }
  const handlers = new Map<string, (event: any) => void>()
  const parent = { postMessage: (message: Posted): void => { posted.push(message) } }
  const documentStub = {
    documentElement: { getAttribute: (name: string): string | undefined => attributes.get(name), setAttribute: (name: string, value: string): void => { attributes.set(name, value) } },
    getElementById: (id: string): { textContent: string } => ({
      textContent: id === 'pad-init' ? JSON.stringify({ data, histories: {}, state: {}, lang: 'zh' }) : '',
    }),
    addEventListener: (): void => {},
    body: { get scrollHeight() { sizeReads++; return 10 } },
  }
  const windowStub = {
    parent,
    addEventListener: (type: string, handler: (event: any) => void): void => { handlers.set(type, handler) },
    dsh: undefined as unknown,
  }

  new Function('window', 'document', 'ResizeObserver', FRAME_RUNTIME)(windowStub, documentStub, Observer)

  return {
    posted,
    sizeReads: () => sizeReads,
    resize: () => resizeCallback(),
    dsh: (windowStub as { dsh: any }).dsh,
    sendData(next: unknown) {
      this.send({ kind: 'data', data: next })
    },
    send(message: Record<string, unknown>) {
      const handler = handlers.get('message')
      if (handler === undefined) throw new Error('the frame did not listen for messages')
      handler({ source: parent, data: structuredClone({ ...message, token: 'test-token' }) })
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

  it('merges incremental histories before rendering and keeps the last 120 points', () => {
    const frame = bootFrame(data)
    const stamp = (i: number): string => new Date(Date.UTC(2026, 9, 23, 12, 0, i)).toISOString()
    const points = Array.from({ length: 120 }, (_, i) => ({ at: stamp(i), value: i }))
    frame.send({ kind: 'data', data, histories: { metric: points } })
    let rendered: unknown
    frame.dsh.onData(() => { rendered = frame.dsh.history('metric') })
    frame.send({ kind: 'data', data, historyDelta: { metric: [{ at: stamp(120), value: 120 }] } })
    expect(rendered).toEqual([...points.slice(1), { at: stamp(120), value: 120 }])
    frame.send({ kind: 'data', data, historyDelta: { metric: [{ at: stamp(120), value: 121 }] } })
    expect(frame.dsh.history('metric')).toHaveLength(120)
    expect(frame.dsh.history('metric').at(-1).value).toBe(121)
  })

  it('inserts backfilled histories in order and updates an older timestamp', () => {
    const frame = bootFrame(data)
    const a = { at: '2026-10-23T12:00:01.000Z', value: 1 }
    const b = { at: '2026-10-23T12:00:02.000Z', value: 2 }
    const c = { at: '2026-10-23T12:00:03.000Z', value: 3 }
    frame.send({ kind: 'data', data, histories: { metric: [a, c] } })
    frame.send({ kind: 'data', data, historyDelta: { metric: [b] } })
    expect(frame.dsh.history('metric')).toEqual([a, b, c])
    frame.send({ kind: 'data', data, historyDelta: { metric: [{ ...a, value: 9 }] } })
    expect(frame.dsh.history('metric')).toEqual([{ ...a, value: 9 }, b, c])
  })

  it('supports a source named constructor before and after its first history point', () => {
    const frame = bootFrame(data)
    expect(frame.dsh.history('constructor')).toEqual([])
    const first = { at: '2026-10-23T12:00:01.000Z', value: 1 }
    frame.send({ kind: 'data', data, historyDelta: { constructor: [first] } })
    expect(frame.dsh.history('constructor')).toEqual([first])
  })

  it('skips fixed-height layout measurements and resumes when reset to auto', () => {
    const frame = bootFrame(data, 'fixed')
    frame.resize()
    expect(frame.sizeReads()).toBe(0)
    frame.send({ kind: 'height', auto: true })
    expect(frame.sizeReads()).toBe(1)
    expect(frame.posted.some(message => message.kind === 'resize')).toBe(true)
    frame.send({ kind: 'height', auto: false })
    frame.resize()
    expect(frame.sizeReads()).toBe(1)
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
