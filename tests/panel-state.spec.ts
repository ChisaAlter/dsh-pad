import { describe, expect, it } from 'vitest'
import { FRAME_RUNTIME } from '../src/client/frame-runtime.ts'
import {
  encodePanelState,
  isSafeStateKey,
  MAX_STATE_CHARS,
  parsePanelState,
  STATE_PREFIX,
} from '../src/client/panel-state.ts'

describe('panel state', () => {
  it('exports the storage prefix and size limit', () => {
    expect(STATE_PREFIX).toBe('dsh-pad:state:')
    expect(MAX_STATE_CHARS).toBe(64 * 1024)
  })

  it('rejects prototype-polluting keys and accepts normal keys', () => {
    expect(isSafeStateKey('__proto__')).toBe(false)
    expect(isSafeStateKey('constructor')).toBe(false)
    expect(isSafeStateKey('prototype')).toBe(false)
    expect(isSafeStateKey('range')).toBe(true)
    expect(isSafeStateKey('activeTab')).toBe(true)
  })

  it('parses only plain JSON objects and falls back to {}', () => {
    expect(parsePanelState(null)).toEqual({})
    expect(parsePanelState('{}')).toEqual({})
    expect(parsePanelState('nope')).toEqual({})
    expect(parsePanelState('123')).toEqual({})
    expect(parsePanelState('[]')).toEqual({})
    expect(parsePanelState('"x"')).toEqual({})
    expect(parsePanelState('null')).toEqual({})
    expect(parsePanelState('{"range":"24h","count":3}')).toEqual({ range: '24h', count: 3 })
  })

  it('drops __proto__, constructor and prototype keys without polluting Object.prototype', () => {
    const raw = '{"__proto__":{"polluted":true},"constructor":{"bad":1},"prototype":{"bad":2},"ok":true}'
    const parsed = parsePanelState(raw)

    expect(parsed).toEqual({ ok: true })
    expect(Object.prototype.hasOwnProperty.call(parsed, '__proto__')).toBe(false)
    expect(Object.prototype.hasOwnProperty.call(parsed, 'constructor')).toBe(false)
    expect(Object.prototype.hasOwnProperty.call(parsed, 'prototype')).toBe(false)
    expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined()
  })

  it('returns undefined without throwing for BigInt, circular objects, and oversized payloads', () => {
    expect(() => encodePanelState({ value: 1n })).not.toThrow()
    expect(encodePanelState({ value: 1n })).toBeUndefined()

    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(() => encodePanelState(circular)).not.toThrow()
    expect(encodePanelState(circular)).toBeUndefined()

    const oversized = { text: 'a'.repeat(MAX_STATE_CHARS) }
    expect(() => encodePanelState(oversized)).not.toThrow()
    expect(encodePanelState(oversized)).toBeUndefined()

    expect(encodePanelState({ range: '24h' })).toBe('{"range":"24h"}')
  })

  it('ignores unsafe keys in frame-runtime dsh.state.set', () => {
    const posted: Array<{ kind?: string, key?: string }> = []
    const documentStub = {
      documentElement: { getAttribute: () => 'tok', setAttribute: () => {} },
      getElementById: (id: string) => ({ textContent: id === 'pad-init' ? '{}' : '' }),
      addEventListener: () => {},
      body: { scrollHeight: 10 },
    }
    const windowStub: { parent: unknown, addEventListener: () => void, dsh: any } = {
      parent: { postMessage: (msg: { kind?: string, key?: string }) => { posted.push(msg) } },
      addEventListener: () => {},
      dsh: undefined,
    }
    new Function('window', 'document', 'ResizeObserver', FRAME_RUNTIME)(windowStub, documentStub, undefined)
    posted.length = 0

    windowStub.dsh.state.set('__proto__', { polluted: true })
    windowStub.dsh.state.set('constructor', 'bad')
    windowStub.dsh.state.set('prototype', 'bad')
    expect(posted).toEqual([])
    expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined()

    windowStub.dsh.state.set('range', '7d')
    expect(posted).toEqual([{ kind: 'state', key: 'range', value: '7d', token: 'tok' }])
  })
})
