import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { PadClient } from '../src/client/pad-client.ts'
import { leafIds } from '../src/client/layout.ts'
import { DOCK_CSS } from '../src/client/styles.ts'
import type { PanelView, StreamEvent } from '../src/shared/types.ts'

// No browser or optional React install in CI: execute real Dock handlers with a
// deterministic hook owner, then independently verify their DOM behavior offline.
type VNode = { type: unknown, props: Record<string, any>, key?: unknown }
type Effect = { deps: unknown[] | undefined, cleanup?: () => void }
let owner: HookOwner
const same = (a?: unknown[], b?: unknown[]) => a !== undefined && b !== undefined && a.length === b.length && a.every((value, index) => Object.is(value, b[index]))
const element = (type: unknown, props: any, key?: unknown): VNode => ({ type, props: props ?? {}, key })
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
  render(extraProps: Record<string, any> = {}) {
    for (let attempt = 0; attempt < 12; attempt++) {
      owner = this; this.next = 0; this.dirty = false
      this.tree = this.component({ t: (key: string) => key === 'dock.title' ? '面板' : key, ...extraProps })
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
    super.addEventListener(type, listener, typeof options === 'boolean' ? { capture: options } : options)
  }
  override removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: any) {
    if (listener !== null) this.listeners.get(type)?.delete(listener)
    super.removeEventListener(type, listener, typeof options === 'boolean' ? { capture: options } : options)
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
let whaleCode: string
let cardCode: string
beforeAll(async () => {
  const [dock, frame, whale, card] = await Promise.all(['src/client/Dock.tsx', 'src/client/PanelFrame.tsx', 'src/client/WhalePanels.tsx', 'src/client/PanelCard.tsx'].map(entry => build({
    entryPoints: [entry], bundle: true, write: false, format: 'cjs', platform: 'browser', target: 'es2022', jsx: 'automatic',
    external: ['react', 'react/jsx-runtime', '@deepseek-ai/dsh-client-ui-primitives'],
  })))
  dockCode = dock!.outputFiles[0]!.text
  frameCode = frame!.outputFiles[0]!.text
  whaleCode = whale!.outputFiles[0]!.text
  cardCode = card!.outputFiles[0]!.text
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
  const win = Object.assign(new TrackedTarget(), { innerWidth: 1440, innerHeight: 900, open: vi.fn() })
  const doc = Object.assign(new TrackedTarget(), {
    defaultView: win, visibilityState: 'visible', body: {},
    documentElement: { dataset: {}, classList: { toggle() {}, remove() {} }, style: { setProperty() {}, removeProperty() {} } },
    getElementById: () => null, elementFromPoint: () => null, querySelectorAll: () => [],
  })
  const streams: any[] = []
  class EventSource {
    readyState = 0
    onmessage?: (event: { data: string }) => void
    constructor(readonly url: string) { streams.push(this) }
    close() { this.readyState = 2 }
    emit(event: StreamEvent) { this.onmessage?.({ data: JSON.stringify(event) }) }
  }
  let tokenSeq = 0
  const globals = {
    window: win, document: doc, EventSource, Element: CaptureTarget, ResizeObserver: Observer, MutationObserver: Observer,
    crypto: { getRandomValues: (bytes: Uint8Array) => bytes.fill((++tokenSeq) & 255) },
    matchMedia: () => ({ addEventListener() {}, removeEventListener() {} }), getComputedStyle: () => ({ getPropertyValue: () => '', colorScheme: 'light' }),
    requestAnimationFrame: () => 0, cancelAnimationFrame() {}, localStorage: { getItem: () => null, setItem: vi.fn() },
    fetch: async () => ({ ok: true, json: async () => ({ available: false }) }),
  }
  for (const [key, value] of Object.entries(globals)) vi.stubGlobal(key, value)
  const load = (code: string) => {
    const module = { exports: {} as any }
    const primitives = {
      Button: (props: any) => element('button', props),
      Input: (props: any) => element('input', props),
      Modal: (props: any) => element('div', { className: 'mock-modal', ...props }),
    }
    runInNewContext(code, {
      ...globals, Date, module, exports: module.exports, setTimeout, clearTimeout, setInterval, clearInterval,
      queueMicrotask, AbortController, Event, console,
      require: (id: string) => id === 'react' ? react : id === '@deepseek-ai/dsh-client-ui-primitives' ? primitives : { jsx: element, jsxs: element },
    })
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

  it('owns the focused folded panel subscription until focus closes or the owner unmounts', async () => {
    const env = setup()
    nodes(env.dock.tree, n => n.props?.view?.id === 'a' && typeof n.props.onExpand === 'function')[0]!.props.onExpand()
    env.dock.render()
    await Promise.resolve()
    expect(env.streams.at(-1).url).toContain('watch=a')
    env.dock.unmount()
    await Promise.resolve()
    expect(env.streams.at(-1).url.endsWith('watch=')).toBe(true)
    env.client.stop()
  })

  it('keeps the collapse toggle at the top-right corner without a side gutter', () => {
    for (const dock of [null, { x: 100, y: 100 }]) {
      const env = setup()
      env.client.setLayout({
        expanded: true,
        ballEdge: 'right',
        dock,
      })
      env.dock.render()
      const aside = byClass(env.dock.tree, 'dshpad-dock')
      const asideClasses = String(aside.props.className).split(' ')
      expect(asideClasses).toContain('dshpad-dock')
      expect(asideClasses).not.toContain('is-attached')
      expect(asideClasses).not.toContain('is-attached-right')
      expect(asideClasses).not.toContain('has-control-gutter')
      expect(aside.props.style).not.toHaveProperty('--dshpad-control-x')
      expect(aside.props.style).not.toHaveProperty('--dshpad-control-y')
      expect(aside.props.style).not.toHaveProperty('--dshpad-head-left')
      expect(aside.props.style).not.toHaveProperty('--dshpad-head-right')

      const collapseBtn = byClass(env.dock.tree, 'dshpad-collapse')
      expect(String(collapseBtn.props.className).split(' ')).not.toContain('is-attached')

      const star = byClass(env.dock.tree, 'dshpad-star-anchor')
      expect(String(star.props.className).split(' ')).not.toContain('is-arrow')
      const { left, top, width } = aside.props.style
      expect(star.props.style.left).toBe(left + width - 9 - 28)
      expect(star.props.style.top).toBe(top + 2)
      env.finish()
    }
    expect(DOCK_CSS).not.toContain('has-control-gutter')
    expect(DOCK_CSS).not.toContain('.dshpad-collapse.is-attached')
  })

  it('restores an edge-attached ball on expand -> collapse without dragging, and collapses in place after drag', () => {
    for (const [edge, ball] of [['left', { x: 1, y: 300 }], ['right', { x: 1411, y: 300 }]] as const) {
      const env = setup(false)
      env.client.setLayout({ expanded: false, ball, ballEdge: edge, dock: null })
      env.dock.render()
      // Click ball to open
      byClass(env.dock.tree, 'dshpad-ball').props.onPointerDown(env.press())
      env.dispatch('pointerup', 1, 200, 110)
      env.dock.render()
      expect(env.client.getSnapshot().layout.expanded).toBe(true)
      expect(env.client.getSnapshot().layout.dock).toBeNull()
      // Collapse immediately without dragging dock -> returns cleanly to original edge & position
      byClass(env.dock.tree, 'dshpad-collapse').props.onClick()
      vi.advanceTimersByTime(160)
      env.dock.render()
      expect(env.client.getSnapshot().layout.expanded).toBe(false)
      expect(env.client.getSnapshot().layout.ballEdge).toBe(edge)
      expect(env.client.getSnapshot().layout.ball).toEqual(ball)
      env.finish()
    }

    // Dragged dock collapses in place at top-right collapse button as a free ball.
    const env = setup(false)
    env.client.setLayout({ expanded: false, ball: { x: 1, y: 300 }, ballEdge: 'left', dock: null })
    env.dock.render()
    byClass(env.dock.tree, 'dshpad-ball').props.onPointerDown(env.press())
    env.dispatch('pointerup', 1, 200, 110)
    env.dock.render()
    byClass(env.dock.tree, 'dshpad-dock-head').props.onPointerDown(env.press())
    env.dispatch('pointermove', 1, 450, 260)
    env.dispatch('pointerup', 1, 450, 260)
    env.dock.render()
    expect(env.client.getSnapshot().layout.dock).not.toBeNull()
    byClass(env.dock.tree, 'dshpad-collapse').props.onClick()
    vi.advanceTimersByTime(160)
    env.dock.render()
    expect(env.client.getSnapshot().layout.expanded).toBe(false)
    expect(env.client.getSnapshot().layout.ballEdge).toBeNull()
    env.finish()
  })

  it('does not lock dock layout when clicking resize edges without exceeding DRAG_THRESHOLD', () => {
    for (const handle of ['dshpad-resize', 'dshpad-dock-edge', 'dshpad-dock-foot']) {
      const env = setup(true)
      env.client.setLayout({ expanded: true, ball: { x: 1, y: 300 }, ballEdge: 'left', dock: null })
      env.dock.render()
      byClass(env.dock.tree, handle).props.onPointerDown(env.press())
      env.dispatch('pointermove', 1, 202, 112)
      env.dispatch('pointerup', 1, 202, 112)
      expect(env.client.getSnapshot().layout.dock).toBeNull()
      env.finish()
    }
  })

  it('protects saved and default balls across a 0x0 desktop boot viewport until reveal', () => {
    const env = setup(false)
    env.dock.unmount()
    env.client.stop()
    const storage = new Map<string, string>()
    const setItem = vi.fn((k: string, v: string) => storage.set(k, v))
    vi.stubGlobal('localStorage', { getItem: (k: string) => storage.get(k) ?? null, setItem })
    env.win.innerWidth = 0
    env.win.innerHeight = 0
    storage.set('dsh-pad:layout', JSON.stringify({ expanded: false, ball: { x: 17, y: 600 }, ballEdge: null }))
    const module = env.load(dockCode)
    const client = new PadClient()
    const dock = new HookOwner(module.createDock(client))
    dock.render()
    expect(setItem).not.toHaveBeenCalled()
    expect(client.getSnapshot().layout.ball).toEqual({ x: 17, y: 600 })
    // Reveal the window
    env.win.innerWidth = 1440
    env.win.innerHeight = 900
    env.win.dispatchEvent(new Event('resize'))
    dock.render()
    expect(client.getSnapshot().layout.ball).toEqual({ x: 17, y: 600 })
    dock.unmount()
    client.stop()
  })

  it('closes update dialog on Escape and focuses/errors/escapes the focused modal', async () => {
    const env = setup(true)
    vi.spyOn(env.client, 'checkUpdate').mockResolvedValue({ available: true, current: '0.4.5', latest: '0.5.0', canApply: false, reason: 'source', url: 'https://example.com' })
    const module = env.load(dockCode)
    const dock = new HookOwner(module.createDock(env.client))
    dock.render()
    await vi.advanceTimersByTimeAsync(0)
    dock.render()
    byClass(dock.tree, 'dshpad-update-btn').props.onClick()
    dock.render()
    expect(nodes(dock.tree, n => typeof n.props?.className === 'string' && n.props.className.includes('dshpad-update')).length).toBeGreaterThan(0)
    env.doc.dispatchEvent(Object.assign(new Event('keydown'), { key: 'Escape', stopPropagation: vi.fn() }))
    dock.render()
    expect(nodes(dock.tree, n => typeof n.props?.className === 'string' && n.props.className === 'dshpad-update')).toHaveLength(0)

    // Focused modal: focus moves in, scriptError renders, and onEscape closes it.
    nodes(dock.tree, n => n.props?.view?.id === 'a' && typeof n.props.onExpand === 'function')[0]!.props.onExpand()
    dock.render()
    const focusPanel = byClass(dock.tree, 'dshpad-focus-panel')
    expect(focusPanel.props.tabIndex).toBe(-1)
    const focusedFrame = nodes(dock.tree, n => typeof n.props?.onEscape === 'function')[0]!
    focusedFrame.props.onScriptError('ReferenceError: boom\n  at line 1')
    dock.render()
    expect(nodes(dock.tree, n => n.props?.className === 'dshpad-card-note is-alert' && n.props.children === 'ReferenceError: boom')).toHaveLength(1)
    focusedFrame.props.onEscape()
    dock.render()
    expect(nodes(dock.tree, n => n.props?.className === 'dshpad-focus')).toHaveLength(0)
    dock.unmount()
    env.finish()
  })
})

describe('PanelFrame security, throttling and abort lifecycle', () => {
  it('unmounts iframe on recovery exhaustion, blocks messages, aborts pending runs and throttles actions', async () => {
    const env = setup()
    env.dock.unmount()
    const { PanelFrame } = env.load(frameCode)
    const onRefresh = vi.fn()
    const onAsk = vi.fn()
    const onEscape = vi.fn()
    const onScriptError = vi.fn()
    let resolveRun!: (value: { ok: boolean, text?: string }) => void
    const runSignals: Array<AbortSignal | undefined> = []
    const onRun = vi.fn((_prompt: string, _system?: string, signal?: AbortSignal) => {
      runSignals.push(signal)
      return new Promise<{ ok: boolean, text?: string }>(resolve => { resolveRun = resolve })
    })
    let currentView = panel('p1')
    const frame = new HookOwner(() => PanelFrame({
      view: currentView, histories: () => ({}), theme: { mode: 'light', css: ':root{}' }, lang: 'zh-CN',
      onRefresh, onAsk, onRun, onScriptError, onEscape, resizeLabel: 'resize',
    }))
    frame.render()
    const iframe = () => nodes(frame.tree, n => n.type === 'iframe')[0]
    expect(iframe()?.key).toBe('p1:1:zh-CN:0')

    // Wire a fake contentWindow onto frameRef and extract the per-frame token from srcDoc.
    const postMessage = vi.fn()
    const contentWindow = { postMessage }
    const tokenOf = () => /data-token="([^"]+)"/.exec(String(iframe()!.props.srcDoc))![1]!
    const sendFromFrame = (data: Record<string, unknown>) => {
      iframe()!.props.ref.current = { contentWindow }
      env.win.dispatchEvent(Object.assign(new Event('message'), { source: contentWindow, data: { ...data, token: tokenOf() } }))
    }

    // Boot ready + test throttling on refresh / ask / open + escape forwarding.
    sendFromFrame({ kind: 'ready' })
    sendFromFrame({ kind: 'refresh' })
    sendFromFrame({ kind: 'refresh' })
    expect(onRefresh).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1000)
    sendFromFrame({ kind: 'refresh' })
    expect(onRefresh).toHaveBeenCalledTimes(2)

    sendFromFrame({ kind: 'ask', text: 'first' })
    sendFromFrame({ kind: 'ask', text: 'second' })
    expect(onAsk).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(500)
    sendFromFrame({ kind: 'ask', text: 'third' })
    expect(onAsk).toHaveBeenCalledTimes(2)

    sendFromFrame({ kind: 'open', url: 'https://example.com/1' })
    sendFromFrame({ kind: 'open', url: 'https://example.com/2' })
    expect(env.win.open).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(500)
    sendFromFrame({ kind: 'open', url: 'https://example.com/3' })
    expect(env.win.open).toHaveBeenCalledTimes(2)

    sendFromFrame({ kind: 'escape' })
    expect(onEscape).toHaveBeenCalledTimes(1)

    // Start an in-flight dsh.run, then exhaust navigation recoveries (3 recoveries + 4th navigation stops).
    sendFromFrame({ kind: 'run', id: 'r1', prompt: 'hello' })
    expect(runSignals[0]?.aborted).toBe(false)
    for (let i = 0; i < 4; i++) {
      iframe()!.props.onLoad() // initial
      iframe()!.props.onLoad() // navigated
      frame.render()
    }
    expect(runSignals[0]?.aborted).toBe(true)
    expect(iframe()).toBeUndefined()
    expect(byClass(frame.tree, 'dshpad-frame-stopped')).toBeDefined()

    // Late resolution of the aborted run must NOT post run-result.
    postMessage.mockClear()
    resolveRun({ ok: true, text: 'secret' })
    await Promise.resolve()
    await Promise.resolve()
    expect(postMessage).not.toHaveBeenCalled()

    // Editing definition version resets stopped state and mounts a fresh iframe with updated key.
    currentView = { ...currentView, version: 2 }
    frame.render()
    expect(iframe()?.key).toBe('p1:2:zh-CN:3')
    frame.unmount()
    env.client.stop()
  })
})

describe('WhalePanels and PanelCard hardening', () => {
  it('dedupes requestAdd, clears state on inactive/timeout, tolerates storage errors, and keeps expand height local', () => {
    const env = setup()
    env.dock.unmount()
    const storageSet = vi.fn(() => { throw new Error('QuotaExceededError') })
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: storageSet })
    const { createWhalePanels } = env.load(whaleCode)
    const WhalePanels = createWhalePanels(env.client)

    // Mounting with requestAdd > 0 does not spuriously open the modal (ref dedupe on remount).
    const mounted = new HookOwner(props => WhalePanels({ t: props.t, requestAdd: props.requestAdd ?? 2, active: props.active ?? true }))
    mounted.render({ requestAdd: 2, active: true })
    const modal = () => nodes(mounted.tree, n => typeof n.props?.onClose === 'function' && 'open' in n.props)[0]!
    expect(modal().props.open).toBe(false)

    // Incrementing requestAdd while mounted opens the modal.
    mounted.render({ requestAdd: 3, active: true })
    expect(modal().props.open).toBe(true)

    // Becoming inactive closes modal and clears notice.
    const firstCard = nodes(mounted.tree, n => n.props?.view?.id === 'a' && typeof n.props.onAsk === 'function')[0]!
    firstCard.props.onAsk('draft text')
    mounted.render({ requestAdd: 3, active: true })
    expect(nodes(mounted.tree, n => n.props?.className === 'dshpad-whale-notice' && n.props.children === 'whale.unavailable')).toHaveLength(1)
    mounted.render({ requestAdd: 3, active: false })
    expect(modal().props.open).toBe(false)
    expect(nodes(mounted.tree, n => n.props?.className === 'dshpad-whale-notice' && n.props.children === 'whale.unavailable')).toHaveLength(0)

    // Notice auto-clears after 4s.
    mounted.render({ requestAdd: 3, active: true })
    firstCard.props.onAsk('draft text')
    mounted.render({ requestAdd: 3, active: true })
    expect(nodes(mounted.tree, n => n.props?.className === 'dshpad-whale-notice' && n.props.children === 'whale.unavailable')).toHaveLength(1)
    vi.advanceTimersByTime(4000)
    mounted.render({ requestAdd: 3, active: true })
    expect(nodes(mounted.tree, n => n.props?.className === 'dshpad-whale-notice' && n.props.children === 'whale.unavailable')).toHaveLength(0)

    // Local expand does not pollute floating Dock heights.
    expect(env.client.panelHeight('a')).toBeUndefined()
    firstCard.props.onExpand()
    mounted.render({ requestAdd: 3, active: true })
    expect(env.client.panelHeight('a')).toBeUndefined()
    const updatedCard = nodes(mounted.tree, n => n.props?.view?.id === 'a' && typeof n.props.onExpand === 'function')[0]!
    expect(updatedCard.props.height).toBe(480)

    // Hide action persists via try/catch without throwing on QuotaExceededError.
    const hideAction = updatedCard.props.sidebarActions.find((a: any) => a.label === 'whale.hide')
    expect(() => hideAction.run()).not.toThrow()
    mounted.unmount()
    env.client.stop()
  })

  it('guards invalid dates in PanelCard and stops Escape propagation in capture phase', () => {
    const env = setup()
    env.dock.unmount()
    const { PanelCard, relativeTime, clock } = env.load(cardCode)
    const t = (k: string) => k
    expect(relativeTime(t, 'not-a-date', Date.now())).toBe('—')
    expect(relativeTime(t, '2026-10-23T00:00:00Z', Number.NaN)).toBe('—')
    expect(clock('not-a-date')).toBe('—')
    expect(clock(undefined)).toBe('—')

    const card = new HookOwner(() => PanelCard({
      view: panel('a'), client: env.client, theme: { mode: 'light', css: ':root{}' }, lang: 'zh-CN', t,
      clockActive: false, fresh: false, dragging: false, dropTarget: false, onAsk() {}, onExpand() {},
    }))
    card.render()
    // Open menu -> Escape stops propagation in capture phase and closes menu.
    byClass(card.tree, 'dshpad-more').props.onClick()
    card.render()
    expect(nodes(card.tree, n => n.props?.className === 'dshpad-menu')).toHaveLength(1)
    const stopPropagation = vi.fn()
    env.doc.dispatchEvent(Object.assign(new Event('keydown'), { key: 'Escape', stopPropagation }))
    card.render()
    expect(stopPropagation).toHaveBeenCalledOnce()
    expect(nodes(card.tree, n => n.props?.className === 'dshpad-menu')).toHaveLength(0)

    // Open delete confirm -> Escape stops propagation and closes confirm dialog.
    byClass(card.tree, 'dshpad-more').props.onClick()
    card.render()
    byClass(card.tree, 'is-danger').props.onClick()
    card.render()
    expect(nodes(card.tree, n => n.props?.className === 'dshpad-confirm')).toHaveLength(1)
    const stopConfirm = vi.fn()
    env.doc.dispatchEvent(Object.assign(new Event('keydown'), { key: 'Escape', stopPropagation: stopConfirm }))
    card.render()
    expect(stopConfirm).toHaveBeenCalledOnce()
    expect(nodes(card.tree, n => n.props?.className === 'dshpad-confirm')).toHaveLength(0)
    card.unmount()
    env.client.stop()
  })
})
