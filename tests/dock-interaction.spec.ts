import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { PadClient } from '../src/client/pad-client.ts'
import { leafIds } from '../src/client/layout.ts'
import type { PanelView, StreamEvent } from '../src/shared/types.ts'

// No browser or optional React install in CI: execute real Dock handlers with a
// deterministic hook owner, then independently verify their DOM behavior offline.
type VNode = { type: unknown, props: Record<string, any> }
type Effect = { deps: unknown[] | undefined, cleanup?: () => void }
let owner: HookOwner
const same = (a?: unknown[], b?: unknown[]) => a !== undefined && b !== undefined && a.length === b.length && a.every((value, index) => Object.is(value, b[index]))
const element = (type: unknown, props: any): VNode => ({ type, props: props ?? {} })
const react = {
  Fragment: Symbol('Fragment'),
  Component: class {},
  useState(initial: any) {
    const context = owner, index = context.next++
    if (!(index in context.values)) context.values[index] = typeof initial === 'function' ? initial() : initial
    return [context.values[index], (value: any) => { context.values[index] = typeof value === 'function' ? value(context.values[index]) : value; context.dirty = true }]
  },
  useRef(initial: any) { const index = owner.next++; return owner.values[index] ?? (owner.values[index] = { current: initial }) },
  useMemo(callback: () => unknown, deps?: unknown[]) {
    const index = owner.next++, previous = owner.values[index]
    if (previous === undefined || !same(previous.deps, deps)) owner.values[index] = { deps, value: callback() }
    return owner.values[index].value
  },
  useEffect(callback: () => (() => void) | void, deps?: unknown[]) {
    const index = owner.next++, previous = owner.effects[index]
    if (previous === undefined || !same(previous.deps, deps)) owner.pending.set(index, { callback, deps })
  },
  useLayoutEffect(callback: () => (() => void) | void, deps?: unknown[]) { react.useEffect(callback, deps) },
  useSyncExternalStore(_subscribe: unknown, snapshot: () => unknown) { return snapshot() },
}
class HookOwner {
  next = 0
  values: any[] = []
  effects: (Effect | undefined)[] = []
  pending = new Map<number, { callback: () => (() => void) | void, deps?: unknown[] }>()
  dirty = false
  tree!: VNode
  constructor(readonly component: (props: any) => VNode) {}
  render() {
    for (let attempt = 0; attempt < 12; attempt++) {
      owner = this; this.next = 0; this.dirty = false
      this.tree = this.component({ t: (key: string) => key === 'dock.title' ? '面板' : key })
      for (const [index, effect] of this.pending) {
        this.effects[index]?.cleanup?.()
        this.effects[index] = { deps: effect.deps, cleanup: effect.callback() || undefined }
      }
      this.pending.clear()
      if (!this.dirty) return
    }
    throw new Error('Dock hooks did not settle')
  }
  unmount() { for (const effect of this.effects) effect?.cleanup?.() }
}
class TrackedTarget extends EventTarget {
  readonly listeners = new Map<string, Set<EventListenerOrEventListenerObject>>()
  override addEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: any) {
    if (listener !== null) { let set = this.listeners.get(type); if (!set) this.listeners.set(type, set = new Set()); set.add(listener) }
    super.addEventListener(type, listener, options)
  }
  override removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: any) {
    if (listener !== null) this.listeners.get(type)?.delete(listener)
    super.removeEventListener(type, listener, options)
  }
}
class CaptureTarget extends TrackedTarget {
  ownerDocument: any
  parentElement = { getBoundingClientRect: () => ({ width: 352 }) }
  closest() { return null }
  setPointerCapture() {}
  hasPointerCapture() { return false }
  releasePointerCapture() {}
}
class Observer { observe() {} disconnect() {} }
let dockCode: string
let frameCode: string
beforeAll(async () => {
  const [dock, frame] = await Promise.all(['src/client/Dock.tsx', 'src/client/PanelFrame.tsx'].map(entry => build({ entryPoints: [entry], bundle: true, write: false, format: 'cjs', platform: 'browser', target: 'es2022', jsx: 'automatic', external: ['react', 'react/jsx-runtime'] })))
  dockCode = dock!.outputFiles[0]!.text
  frameCode = frame!.outputFiles[0]!.text
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

function nodes(node: any, predicate: (node: VNode) => boolean): VNode[] {
  if (Array.isArray(node)) return node.flatMap(item => nodes(item, predicate))
  if (typeof node !== 'object' || node === null) return []
  return [...(predicate(node) ? [node] : []), ...nodes(node.props?.children, predicate)]
}
function byClass(tree: VNode, name: string): VNode {
  const match = nodes(tree, n => typeof n.props?.className === 'string' && n.props.className.split(' ').includes(name))[0]
  if (!match) throw new Error(`Missing ${name}`)
  return match
}
const panel = (id: string): PanelView => ({ id, version: 1, position: 0, collapsed: true, span: 1, updatedAt: '', definition: { title: id, html: '', css: '', script: '', height: 'auto', sources: [] }, data: { sources: {}, agent: null }, history: {}, canUndo: false, agentRun: null })
function setup(expanded = true) {
  vi.useFakeTimers()
  const win = Object.assign(new TrackedTarget(), { innerWidth: 1440, innerHeight: 900 })
  const doc = Object.assign(new TrackedTarget(), {
    defaultView: win, visibilityState: 'visible', body: {},
    documentElement: { dataset: {}, classList: { toggle() {}, remove() {} }, style: { setProperty() {}, removeProperty() {} } },
    getElementById: () => null, elementFromPoint: () => null,
  })
  const streams: any[] = []
  class EventSource {
    readyState = 0
    onmessage?: (event: { data: string }) => void
    constructor(readonly url: string) { streams.push(this) }
    close() { this.readyState = 2 }
    emit(event: StreamEvent) { this.onmessage?.({ data: JSON.stringify(event) }) }
  }
  const globals = {
    window: win, document: doc, EventSource, Element: CaptureTarget, ResizeObserver: Observer, MutationObserver: Observer,
    crypto: { getRandomValues: (bytes: Uint8Array) => bytes.fill(1) },
    matchMedia: () => ({ addEventListener() {}, removeEventListener() {} }), getComputedStyle: () => ({ getPropertyValue: () => '', colorScheme: 'light' }),
    requestAnimationFrame: () => 0, cancelAnimationFrame() {}, localStorage: { getItem: () => null, setItem: vi.fn() },
    fetch: async () => ({ ok: true, json: async () => ({ available: false }) }),
  }
  for (const [key, value] of Object.entries(globals)) vi.stubGlobal(key, value)
  const load = (code: string) => {
    const module = { exports: {} as any }
    runInNewContext(code, { ...globals, module, exports: module.exports, setTimeout, clearTimeout, setInterval, clearInterval, console, require: (id: string) => id === 'react' ? react : { jsx: element, jsxs: element } })
    return module.exports
  }
  const module = load(dockCode)
  const client = new PadClient()
  client.setLayout({ expanded, ballEdge: null, dock: { x: 100, y: 100 }, tree: { kind: 'split', dir: 'row', children: [{ kind: 'leaf', id: 'a' }, { kind: 'leaf', id: 'b' }], weights: [1, 1] } })
  client.start(); streams.at(-1).emit({ type: 'panels', panels: [panel('a'), panel('b')] })
  const dock = new HookOwner(module.createDock(client)); dock.render()
  const target = new CaptureTarget(); target.ownerDocument = doc
  const press = (id = 1) => ({ button: 0, pointerId: id, clientX: 200, clientY: 110, currentTarget: target, target, preventDefault() {}, stopPropagation() {} })
  const dispatch = (type: string, id = 1, x = 350, y = 210) => doc.dispatchEvent(Object.assign(new Event(type), { pointerId: id, clientX: x, clientY: y, preventDefault() {} }))
  const ids = () => nodes(dock.tree, n => typeof n.props?.onExpand === 'function').map(n => n.props.view.id)
  const finish = () => { dock.unmount(); client.stop() }
  return { doc, win, target, client, dock, streams, press, dispatch, ids, finish, load }
}

describe('Dock gesture wiring', () => {
  it('cancels an unmounted PanelFrame resize and commits only its own pointer on a live frame', () => {
    const env = setup()
    env.dock.unmount()
    const { PanelFrame } = env.load(frameCode)
    const onHeightChange = vi.fn()
    const frame = () => new HookOwner(() => PanelFrame({ view: panel('a'), histories: () => ({}), theme: { mode: 'light', css: ':root{}' }, lang: 'en', onRefresh() {}, onAsk() {}, onRun: async () => ({ ok: true }), onScriptError() {}, onHeightChange, resizeLabel: 'resize' }))
    const retired = frame(); retired.render()
    byClass(retired.tree, 'dshpad-frame-handle').props.onPointerDown(env.press())
    env.dispatch('pointermove')
    retired.unmount()
    env.dispatch('pointerup')
    expect(onHeightChange).not.toHaveBeenCalled()
    const active = frame(); active.render()
    byClass(active.tree, 'dshpad-frame-handle').props.onPointerDown(env.press())
    env.dispatch('pointerup', 2)
    expect(onHeightChange).not.toHaveBeenCalled()
    env.dispatch('pointerup', 1)
    expect(onHeightChange).toHaveBeenCalledExactlyOnceWith(164)
    active.unmount(); env.client.stop()
    for (const type of ['pointermove', 'pointerup', 'pointercancel']) expect(env.doc.listeners.get(type)?.size ?? 0).toBe(0)
  })

  it.each(['dshpad-dock-head', 'dshpad-resize', 'dshpad-dock-edge', 'dshpad-dock-foot', 'dshpad-splitter', 'dshpad-collapse'])('unmount retires the active %s handler without a late layout write', name => {
    const env = setup()
    byClass(env.dock.tree, name).props.onPointerDown(env.press())
    env.dispatch('pointermove')
    const before = env.client.getSnapshot().layout
    env.dock.unmount()
    for (const type of ['pointermove', 'pointerup', 'pointercancel']) expect(env.doc.listeners.get(type)?.size ?? 0).toBe(0)
    env.dispatch('pointermove'); env.dispatch('pointerup')
    expect(env.client.getSnapshot().layout).toBe(before)
    env.client.stop()
  })

  it('ignores the secondary pointer and cancels a ball press when capture is lost', () => {
    const env = setup(false)
    byClass(env.dock.tree, 'dshpad-ball').props.onPointerDown(env.press())
    env.dispatch('pointerup', 2)
    expect(env.client.getSnapshot().layout.expanded).toBe(false)
    env.target.dispatchEvent(Object.assign(new Event('lostpointercapture'), { pointerId: 1 }))
    env.dispatch('pointerup', 1)
    expect(env.client.getSnapshot().layout.expanded).toBe(false)
    env.finish()
  })

  it('cancels a splitter preview when hidden instead of saving partial weights', () => {
    const env = setup()
    const before = env.client.getSnapshot().layout.tree
    byClass(env.dock.tree, 'dshpad-splitter').props.onPointerDown(env.press())
    env.dispatch('pointermove')
    env.doc.visibilityState = 'hidden'; env.doc.dispatchEvent(new Event('visibilitychange'))
    env.dispatch('pointerup')
    expect(env.client.getSnapshot().layout.tree).toBe(before)
    env.finish()
  })

  it('keeps a concurrent panel addition visible after releasing a splitter', () => {
    const env = setup()
    byClass(env.dock.tree, 'dshpad-splitter').props.onPointerDown(env.press())
    env.streams.at(-1).emit({ type: 'panels', panels: [panel('a'), panel('b'), panel('c')] })
    env.dock.render(); expect(env.ids()).toEqual(['a', 'b', 'c'])
    env.dispatch('pointerup'); env.dock.render()
    expect(env.ids()).toEqual(['a', 'b', 'c'])
    expect(leafIds(env.client.getSnapshot().layout.tree)).toEqual(['a', 'b', 'c'])
    env.finish()
  })

  it('uses the latest panel set and order when finishing a card drag', () => {
    const env = setup()
    const card = nodes(env.dock.tree, n => n.props?.view?.id === 'a' && typeof n.props.onDragStart === 'function')[0]!
    card.props.onDragStart(env.press())
    env.dispatch('pointermove')
    env.streams.at(-1).emit({ type: 'panels', panels: [panel('a'), panel('b'), panel('c')] })
    env.dock.render(); env.dispatch('pointerup'); env.dock.render()
    expect(env.ids()).toEqual(['b', 'c', 'a'])
    env.finish()
  })

  it('owns the focused folded panel subscription until focus closes or the owner unmounts', () => {
    const env = setup()
    nodes(env.dock.tree, n => n.props?.view?.id === 'a' && typeof n.props.onExpand === 'function')[0]!.props.onExpand()
    env.dock.render()
    expect(env.streams.at(-1).url).toContain('watch=a')
    env.dock.unmount()
    expect(env.streams.at(-1).url.endsWith('watch=')).toBe(true)
    env.client.stop()
  })
})
