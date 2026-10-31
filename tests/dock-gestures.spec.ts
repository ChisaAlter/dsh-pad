import { describe, expect, it, vi } from 'vitest'
import { PointerGestures } from '../src/client/gesture.ts'

class Target extends EventTarget {
  readonly listeners = new Map<string, Set<EventListenerOrEventListenerObject>>()
  override addEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions): void {
    if (listener !== null) {
      let set = this.listeners.get(type)
      if (set === undefined) this.listeners.set(type, set = new Set())
      set.add(listener)
    }
    super.addEventListener(type, listener, options)
  }
  override removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | EventListenerOptions): void {
    if (listener !== null) this.listeners.get(type)?.delete(listener)
    super.removeEventListener(type, listener, options)
  }
  count(): number { return [...this.listeners.values()].reduce((n, listeners) => n + listeners.size, 0) }
}

function environment(captureThrows = false) {
  const win = new Target()
  const doc = Object.assign(new Target(), { defaultView: win, visibilityState: 'visible' })
  const target = Object.assign(new Target(), {
    ownerDocument: doc,
    setPointerCapture: vi.fn(() => { if (captureThrows) throw new Error('synthetic pointer') }),
    hasPointerCapture: vi.fn(() => true),
    releasePointerCapture: vi.fn((id: number) => { target.dispatchEvent(pointer('lostpointercapture', id)) }),
  })
  const handlers = { move: vi.fn(), end: vi.fn(), cancel: vi.fn() }
  const gestures = new PointerGestures()
  const start = (id = 1) => gestures.start({ pointerId: id, currentTarget: target as unknown as Element }, handlers)
  const remaining = () => doc.count() + target.count() + win.count()
  return { win, doc, target, handlers, gestures, start, remaining }
}

function pointer(type: string, id = 1): PointerEvent {
  return Object.assign(new Event(type), { pointerId: id, clientX: 20, clientY: 30 }) as PointerEvent
}

describe('owned pointer gestures', () => {
  it('ignores other pointers and commits its owner once, releasing every listener and capture', () => {
    const env = environment()
    env.start()
    env.doc.dispatchEvent(pointer('pointermove', 2))
    env.doc.dispatchEvent(pointer('pointerup', 2))
    env.doc.dispatchEvent(pointer('pointercancel', 2))
    env.target.dispatchEvent(pointer('lostpointercapture', 2))
    expect(env.handlers.move).not.toHaveBeenCalled()
    expect(env.handlers.end).not.toHaveBeenCalled()
    expect(env.handlers.cancel).not.toHaveBeenCalled()
    env.doc.dispatchEvent(pointer('pointermove'))
    const up = pointer('pointerup')
    env.doc.dispatchEvent(up)
    expect(env.handlers.move).toHaveBeenCalledOnce()
    expect(env.handlers.end).toHaveBeenCalledExactlyOnceWith(up)
    expect(env.handlers.cancel).not.toHaveBeenCalled()
    expect(env.target.releasePointerCapture).toHaveBeenCalledExactlyOnceWith(1)
    expect(env.remaining()).toBe(0)
    env.doc.dispatchEvent(pointer('pointerup'))
    env.gestures.cancel()
    expect(env.handlers.end).toHaveBeenCalledOnce()
  })

  it.each(['owner-unmount', 'pointercancel', 'lostpointercapture', 'detached-capture', 'hidden', 'blur'] as const)('cancels on %s without committing or leaving stale handlers', reason => {
    const env = environment()
    env.start()
    env.doc.dispatchEvent(pointer('pointermove'))
    if (reason === 'owner-unmount') env.gestures.cancel()
    if (reason === 'pointercancel') env.doc.dispatchEvent(pointer('pointercancel'))
    if (reason === 'lostpointercapture') env.target.dispatchEvent(pointer('lostpointercapture'))
    if (reason === 'detached-capture') env.doc.dispatchEvent(pointer('lostpointercapture'))
    if (reason === 'hidden') { env.doc.visibilityState = 'hidden'; env.doc.dispatchEvent(new Event('visibilitychange')) }
    if (reason === 'blur') env.win.dispatchEvent(new Event('blur'))
    expect(env.handlers.cancel).toHaveBeenCalledOnce()
    expect(env.handlers.end).not.toHaveBeenCalled()
    expect(env.remaining()).toBe(0)
    env.doc.dispatchEvent(pointer('pointermove'))
    env.doc.dispatchEvent(pointer('pointerup'))
    expect(env.handlers.move).toHaveBeenCalledOnce()
    expect(env.handlers.end).not.toHaveBeenCalled()
    env.gestures.cancel()
    expect(env.handlers.cancel).toHaveBeenCalledOnce()
  })

  it('cancels the previous gesture when a new one acquires ownership', () => {
    const env = environment()
    env.start(1)
    const next = { move: vi.fn(), end: vi.fn(), cancel: vi.fn() }
    env.gestures.start({ pointerId: 2, currentTarget: env.target as unknown as Element }, next)
    expect(env.handlers.cancel).toHaveBeenCalledOnce()
    env.doc.dispatchEvent(pointer('pointerup', 1))
    expect(next.end).not.toHaveBeenCalled()
    env.doc.dispatchEvent(pointer('pointerup', 2))
    expect(next.end).toHaveBeenCalledOnce()
    expect(env.remaining()).toBe(0)
  })

  it('still supervises synthetic pointers when setPointerCapture is unavailable', () => {
    const env = environment(true)
    expect(() => env.start()).not.toThrow()
    env.doc.dispatchEvent(pointer('pointerup'))
    expect(env.handlers.end).toHaveBeenCalledOnce()
    expect(env.remaining()).toBe(0)
  })

  it('never acquires listeners on a hidden document', () => {
    const env = environment()
    env.doc.visibilityState = 'hidden'
    env.start()
    expect(env.remaining()).toBe(0)
    expect(env.target.setPointerCapture).not.toHaveBeenCalled()
  })
})
