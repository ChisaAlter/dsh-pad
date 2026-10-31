import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

// Execute the shipped closure format with real Cordis and SlotRegistry, so
// activation state, failure cleanup and declaration lifetimes are real.
const require = createRequire(import.meta.url)
const { Context } = require('@deepseek-ai/cordis') as typeof import('@deepseek-ai/cordis')
const slots = require('@deepseek-ai/dsh-client-ui-slots')
const platform = (id: string): unknown => {
  if (id === '@deepseek-ai/cordis') return { ...require(id) }
  if (id === '@deepseek-ai/dsh-client-ui-slots') return slots
  // These tests inspect registration rather than rendering. The application
  // supplies React at runtime; no browser-only dependency is needed here.
  if (id === 'react') return { Component: class {}, createContext: () => ({}) }
  if (id === 'react/jsx-runtime') return { jsx: (type: unknown, props: unknown) => ({ type, props }), jsxs: (type: unknown, props: unknown) => ({ type, props }) }
  if (id === 'react-dom' || id === 'react-dom/client') return {}
  return require(id)
}

function moduleExports(source: string, globals: Record<string, unknown> = {}): Record<string, any> {
  let registration: { factory: (require: (id: string) => unknown) => Record<string, any> } | undefined
  runInNewContext(source, {
    console, setTimeout, clearTimeout, URL, queueMicrotask, ...globals,
    window: { innerWidth: 1440, innerHeight: 900, __ModuleLoader__: { load: (value: typeof registration) => { registration = value } } },
  })
  if (registration === undefined) throw new Error('No client module registration')
  return registration.factory(platform)
}

let source: string
const renderer = moduleExports(readFileSync(new URL('../node_modules/@deepseek-ai/dsh-client-ui-renderer/lib/client.js', import.meta.url), 'utf8'))
beforeAll(async () => {
  const result = await build({
    entryPoints: ['src/client/index.ts'], bundle: true, write: false, format: 'cjs', platform: 'browser',
    target: 'es2022', jsx: 'automatic', external: ['react', 'react/jsx-runtime', '@deepseek-ai/*'],
  })
  source = `window.__ModuleLoader__.load({factory:(require)=>{var module={exports:{}};var exports=module.exports;${result.outputFiles[0]!.text}\nreturn module.exports;}})`
})
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

async function environment(declared = true) {
  const ctx = new Context()
  const styles: unknown[] = []
  const document = {
    createElement: () => {
      const element = { dataset: {}, textContent: '', remove: () => { const index = styles.indexOf(element); if (index >= 0) styles.splice(index, 1) } }
      return element
    },
    head: { appendChild: (element: unknown) => { styles.push(element) } },
  }
  let dictionaryCount = 0
  const locale = {
    register: () => { dictionaryCount++; return () => { dictionaryCount-- } },
  }
  const setup = ctx.plugin({ apply(ctx) { new renderer.SlotRegistry(ctx); ctx.reflect.provide('locale', locale) } })
  await setup.await()
  const registry = ctx.get('slots') as any
  const declare = () => registry.register({ name: 'root', children: {
    'shell.overlay': { kind: 'list', scope: 'root' },
    'conversation.input.overlay': { kind: 'list', scope: 'root' },
  } }, () => null)
  const disposeDeclaration = declared ? declare() : () => {}
  return { ctx, document, styles, locale, registry, declare, disposeDeclaration, dictionaries: () => dictionaryCount }
}

const tick = async (): Promise<void> => { for (let n = 0; n < 12; n++) await Promise.resolve() }

describe('dock activation and recovery', () => {
  it('keeps its entrance when the first stream construction fails, then reconnects', async () => {
    vi.useFakeTimers()
    const env = await environment()
    let attempts = 0
    const streams: { onopen: (() => void) | null, close: ReturnType<typeof vi.fn> }[] = []
    const plugin = moduleExports(source, { document: env.document, EventSource: class {
      onopen: (() => void) | null = null
      close = vi.fn()
      constructor() { attempts++; if (attempts === 1) throw new Error('blocked stream'); streams.push(this) }
    } })
    const fiber = env.ctx.plugin(plugin as any).ctx.fiber
    try {
      await fiber.await()
      expect(fiber.state).toBe(2)
      expect(env.registry.entries('shell.overlay')).toHaveLength(1)
      expect(env.styles).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(3000)
      expect(attempts).toBe(2)
      streams[0]?.onopen?.()
      expect(env.registry.entries('shell.overlay')).toHaveLength(1)
      await fiber.dispose()
      expect(streams[0]?.close).toHaveBeenCalledOnce()
      expect(env.styles).toHaveLength(0)
      expect(env.dictionaries()).toBe(0)
    } finally { await env.ctx.fiber.dispose() }
  })

  it('rolls back a slot conflict and reports failure so retry can recover once', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const env = await environment()
    const streams: unknown[] = []
    const plugin = moduleExports(source, { document: env.document, EventSource: class {
      constructor() { streams.push(this) }
      close() {}
    } })
    const removeConflict = env.registry.register({ name: 'shell.overlay', id: 'dsh-pad' }, () => null)
    const fiber = env.ctx.plugin(plugin as any).ctx.fiber
    try {
      await expect(fiber.await()).rejects.toThrow()
      await tick()
      expect(fiber.state).toBe(3)
      expect(env.styles).toHaveLength(0)
      expect(env.dictionaries()).toBe(0)
      expect(streams).toHaveLength(0)
      removeConflict()
      await fiber.restart()
      await fiber.await()
      expect(fiber.state).toBe(2)
      expect(env.registry.entries('shell.overlay')).toHaveLength(1)
      expect(env.registry.entries('conversation.input.overlay')).toHaveLength(1)
      expect(env.styles).toHaveLength(1)
      expect(env.dictionaries()).toBe(1)
      expect(streams).toHaveLength(1)
    } finally { await env.ctx.fiber.dispose() }
  })

  it('removes an already registered entrance when a later composer registration fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const env = await environment()
    const plugin = moduleExports(source, { document: env.document, EventSource: class { close() {} } })
    const removeConflict = env.registry.register({ name: 'conversation.input.overlay', id: 'dsh-pad.composer-bridge' }, () => null)
    const fiber = env.ctx.plugin(plugin as any).ctx.fiber
    try {
      await expect(fiber.await()).rejects.toThrow()
      await tick()
      expect(fiber.state).toBe(3)
      expect(env.registry.entries('shell.overlay')).toHaveLength(0)
      expect(env.styles).toHaveLength(0)
      expect(env.dictionaries()).toBe(0)
      removeConflict()
      await fiber.restart()
      await fiber.await()
      expect(env.registry.entries('shell.overlay')).toHaveLength(1)
      expect(env.registry.entries('conversation.input.overlay')).toHaveLength(1)
    } finally { await env.ctx.fiber.dispose() }
  })

  it('retries a delayed registration failure after its declaration is already live', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const env = await environment(false)
    const plugin = moduleExports(source, { document: env.document, EventSource: class { close() {} } })
    const register = env.registry._register.bind(env.registry)
    let blocked = true
    vi.spyOn(env.registry, '_register').mockImplementation((options: any, component: unknown) => {
      if (options.id === 'dsh-pad' && blocked) throw new Error('temporary registration failure')
      return register(options, component)
    })
    const fiber = env.ctx.plugin(plugin as any).ctx.fiber
    try {
      await fiber.await()
      env.declare()
      await tick()
      expect(env.registry.entriesOfSlot('shell.overlay')).toHaveLength(0)
      blocked = false
      await vi.advanceTimersByTimeAsync(3000)
      expect(env.registry.entriesOfSlot('shell.overlay')).toHaveLength(1)
      expect(env.registry.entriesOfSlot('conversation.input.overlay')).toHaveLength(1)
      expect(fiber.state).toBe(2)
    } finally { await env.ctx.fiber.dispose() }
    expect(vi.getTimerCount()).toBe(0)
  })

  it('restores an entrance retired by the renderer without duplicating its registration', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const env = await environment()
    const plugin = moduleExports(source, { document: env.document, EventSource: class { close() {} } })
    const fiber = env.ctx.plugin(plugin as any).ctx.fiber
    try {
      await fiber.await()
      const entry = env.registry.entries('shell.overlay')[0]
      env.registry._core.reportEntryError('shell.overlay', entry, new Error('temporary slot render failure'), { abdicate: true })
      expect(env.registry.entries('shell.overlay')).toHaveLength(1)
      expect(env.registry.entriesOfSlot('shell.overlay')).toHaveLength(0)
      await vi.advanceTimersByTimeAsync(3000)
      expect(env.registry.entriesOfSlot('shell.overlay')).toHaveLength(1)
      expect(env.registry.entries('shell.overlay')).toHaveLength(1)
      expect(env.registry.entriesOfSlot('shell.overlay')[0]).not.toBe(entry)
      expect(env.registry.entriesOfSlot('conversation.input.overlay')).toHaveLength(1)
      expect(env.styles).toHaveLength(1)
    } finally { await env.ctx.fiber.dispose() }
    expect(vi.getTimerCount()).toBe(0)
  })

  it('backs off repeated renderer failures without stacking retries or registrations', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const env = await environment()
    const plugin = moduleExports(source, { document: env.document, EventSource: class { close() {} } })
    const fiber = env.ctx.plugin(plugin as any).ctx.fiber
    try {
      await fiber.await()
      for (const delay of [3000, 6000, 12000]) {
        const entry = env.registry.entries('shell.overlay')[0]
        env.registry._core.reportEntryError('shell.overlay', entry, new Error('persistent render failure'), { abdicate: true })
        expect(vi.getTimerCount()).toBe(1)
        await vi.advanceTimersByTimeAsync(delay - 1)
        expect(env.registry.entriesOfSlot('shell.overlay')).toHaveLength(0)
        await vi.advanceTimersByTimeAsync(1)
        expect(env.registry.entriesOfSlot('shell.overlay')).toHaveLength(1)
        expect(env.registry.entries('shell.overlay')).toHaveLength(1)
        expect(vi.getTimerCount()).toBe(0)
      }
    } finally { await env.ctx.fiber.dispose() }
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cancels a pending recovery when a declaration disappears and registers once when it returns', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const env = await environment()
    const plugin = moduleExports(source, { document: env.document, EventSource: class { close() {} } })
    const fiber = env.ctx.plugin(plugin as any).ctx.fiber
    try {
      await fiber.await()
      const entry = env.registry.entries('shell.overlay')[0]
      env.registry._core.reportEntryError('shell.overlay', entry, new Error('temporary render failure'), { abdicate: true })
      expect(vi.getTimerCount()).toBe(1)
      env.disposeDeclaration()
      expect(vi.getTimerCount()).toBe(0)
      await vi.advanceTimersByTimeAsync(5000)
      expect(env.registry.entries('shell.overlay')).toHaveLength(0)
      env.declare()
      expect(env.registry.entriesOfSlot('shell.overlay')).toHaveLength(1)
      expect(env.registry.entriesOfSlot('conversation.input.overlay')).toHaveLength(1)
      expect(vi.getTimerCount()).toBe(0)
    } finally { await env.ctx.fiber.dispose() }
  })

  it('does not reinstall a retired entrance after the plugin unloads', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const env = await environment()
    const close = vi.fn()
    const plugin = moduleExports(source, { document: env.document, EventSource: class { close = close } })
    const fiber = env.ctx.plugin(plugin as any).ctx.fiber
    try {
      await fiber.await()
      const entry = env.registry.entries('shell.overlay')[0]
      env.registry._core.reportEntryError('shell.overlay', entry, new Error('slot render failure'), { abdicate: true })
      await fiber.dispose()
      await vi.advanceTimersByTimeAsync(10000)
      expect(env.registry.entriesOfSlot('shell.overlay')).toHaveLength(0)
      expect(env.registry.entries('shell.overlay')).toHaveLength(0)
      expect(env.styles).toHaveLength(0)
      expect(env.dictionaries()).toBe(0)
      expect(close).toHaveBeenCalledOnce()
      expect(vi.getTimerCount()).toBe(0)
    } finally { await env.ctx.fiber.dispose() }
  })

  it('restores exactly one entrance after the shell declaration is rebuilt', async () => {
    const env = await environment()
    const close = vi.fn()
    const plugin = moduleExports(source, { document: env.document, EventSource: class { close = close } })
    const fiber = env.ctx.plugin(plugin as any).ctx.fiber
    try {
      await fiber.await()
      env.disposeDeclaration()
      expect(env.registry.entries('shell.overlay')).toHaveLength(0)
      env.declare()
      expect(env.registry.entries('shell.overlay')).toHaveLength(1)
      expect(env.registry.entries('conversation.input.overlay')).toHaveLength(1)
      await fiber.dispose()
      expect(env.registry.entries('shell.overlay')).toHaveLength(0)
      expect(env.styles).toHaveLength(0)
      expect(close).toHaveBeenCalledOnce()
    } finally { await env.ctx.fiber.dispose() }
  })
})
