import { createRequire } from 'node:module'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

// Exercise real Cordis activation/rollback, rather than only testing a wrapper
// that directly invokes apply() without its resource owner.
const require = createRequire(import.meta.url)
const { Context } = require('@deepseek-ai/cordis') as typeof import('@deepseek-ai/cordis')
const roots: string[] = []
let source: string
beforeAll(async () => {
  const result = await build({
    entryPoints: ['src/index.ts'], bundle: true, write: false, format: 'cjs',
    platform: 'node', target: 'node22', external: ['@deepseek-ai/*'],
    define: { 'import.meta.url': '__hostModuleUrl' }, logLevel: 'silent',
  })
  source = result.outputFiles[0]!.text
})
afterEach(async () => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function environment() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-pad-startup-'))
  roots.push(root)
  const logs: unknown[][] = []
  const module = { exports: {} as any }
  runInNewContext(source, {
    module, exports: module.exports, require, console: { error: (...args: unknown[]) => logs.push(args) },
    __hostModuleUrl: pathToFileURL(join(root, 'lib', 'index.js')).href,
    process, Buffer, TextEncoder, Response, ReadableStream, Request, URL, fetch, AbortController, AbortSignal,
    setTimeout, clearTimeout, setInterval, clearInterval,
  })
  const ctx = new Context()
  const routes = new Map<string, unknown>()
  const tools = new Map<string, unknown>()
  let blocked = true
  const services = ctx.plugin({ apply(serviceCtx: typeof ctx) {
    serviceCtx.reflect.provide('connection', { fetch: { register(entry: { path: string }) {
      routes.set(entry.path, entry)
      return () => routes.delete(entry.path)
    } } } as any)
    serviceCtx.reflect.provide('tools', { register(tool: { name: string }) {
      if (blocked && tools.size === 2) throw new Error('temporary tool registration failure')
      tools.set(tool.name, tool)
      return () => tools.delete(tool.name)
    } } as any)
  } })
  await services.await()
  const config = {
    dataFile: join(root, 'panels.json'), minIntervalSec: 2,
    agentRefresh: false, minAgentMinutes: 15, agentTimeoutSec: 300, agentConcurrency: 1,
    agentRetryMinutes: 15, interactiveModel: true, runTimeoutSec: 120, runMaxTokens: 2048,
    runConcurrency: 2, updateCheck: false, updateCheckHours: 6,
  }
  return { ctx, routes, tools, logs, plugin: module.exports, config, unblock: () => { blocked = false } }
}

describe('Host activation ownership', () => {
  it('rolls back partial registrations and can restart without duplicates', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const env = await environment()
    const fiber = env.ctx.plugin(env.plugin, env.config).ctx.fiber
    try {
      await expect(fiber.await()).rejects.toThrow('temporary tool registration failure')
      expect(fiber.state).toBe(3)
      expect(env.routes.size).toBe(0)
      expect(env.tools.size).toBe(0)
      expect(env.logs).toHaveLength(1)
      env.unblock()
      await fiber.restart()
      await fiber.await()
      expect(fiber.state).toBe(2)
      expect(env.routes.size).toBe(6)
      expect([...env.tools.keys()].sort()).toEqual([
        'pad_create', 'pad_delete', 'pad_get', 'pad_guide', 'pad_list', 'pad_models', 'pad_refresh', 'pad_test_source', 'pad_update',
      ])
      await fiber.dispose()
      expect(env.routes.size).toBe(0)
      expect(env.tools.size).toBe(0)
    } finally {
      await env.ctx.fiber.dispose()
    }
  })

  it('contains an unreadable store in the plugin without activating resources', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const env = await environment()
    const blocker = join(roots.at(-1)!, 'not-a-directory')
    await writeFile(blocker, 'blocker')
    const fiber = env.ctx.plugin(env.plugin, { ...env.config, dataFile: join(blocker, 'panels.json') }).ctx.fiber
    try {
      await expect(fiber.await()).rejects.toThrow()
      expect(fiber.state).toBe(3)
      expect(env.routes.size).toBe(0)
      expect(env.tools.size).toBe(0)
      expect(env.ctx.fiber.state).toBe(2)
    } finally {
      await env.ctx.fiber.dispose()
    }
  })
})
