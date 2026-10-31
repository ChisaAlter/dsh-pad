import { createServer, type Server } from 'node:http'
import { mkdtemp, readFile } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { parseOutput, runSource, secretNames } from '../src/host/sources.ts'
import { MAX_SOURCE_JSON_DEPTH, MAX_SOURCE_JSON_NODES } from '../src/host/source-json.ts'
import type { HttpSource } from '../src/shared/types.ts'

const noSecrets = async (): Promise<string | undefined> => undefined

describe('parseOutput', () => {
  it('parses json, lines and text', () => {
    expect(parseOutput('{"a":1}\n', 'json')).toEqual({ a: 1 })
    expect(parseOutput('a\n\nb\r\n', 'lines')).toEqual(['a', 'b'])
    expect(parseOutput('  hello \n\n', 'text')).toBe('  hello')
  })

  it('explains invalid json', () => {
    expect(() => parseOutput('nope', 'json')).toThrow(/不是合法 JSON/)
  })

  it('rejects small deeply nested JSON before it can enter the hub', () => {
    const atLimit = '['.repeat(MAX_SOURCE_JSON_DEPTH) + '0' + ']'.repeat(MAX_SOURCE_JSON_DEPTH)
    expect(() => JSON.stringify({ data: parseOutput(atLimit, 'json') })).not.toThrow()
    const tooDeep = '['.repeat(10_000) + '0' + ']'.repeat(10_000)
    expect(() => parseOutput(tooDeep, 'json')).toThrow(/JSON 嵌套超过/)
    expect(() => parseOutput(tooDeep, 'json', new Set(['fixture-secret']))).toThrow(/JSON 嵌套超过/)
  })

  it('bounds broad JSON structures separately from their byte size', () => {
    const broad = '[' + '0,'.repeat(MAX_SOURCE_JSON_NODES) + '0]'
    expect(() => parseOutput(broad, 'json')).toThrow(/JSON 节点超过/)
  })
})

describe('command sources', () => {
  it('runs a shell command', async () => {
    const reading = await runSource({ id: 'x', kind: 'command', command: 'node -e "console.log(JSON.stringify({n:42}))"', parse: 'json', intervalSec: 5 }, noSecrets)
    expect(reading).toMatchObject({ ok: true, value: { n: 42 } })
    expect(typeof reading.durationMs).toBe('number')
  })

  it('reports a failing command with its stderr', async () => {
    const reading = await runSource({ id: 'x', kind: 'command', command: 'node -e "console.error(\'boom\'); process.exit(3)"', parse: 'text', intervalSec: 5 }, noSecrets)
    expect(reading.ok).toBe(false)
    expect(reading.error).toMatch(/退出码 3.*boom/)
  })

  it('times out', async () => {
    const reading = await runSource({ id: 'x', kind: 'command', command: 'node -e "setTimeout(function () {}, 60000)"', parse: 'text', intervalSec: 5, timeoutMs: 500 }, noSecrets)
    expect(reading).toMatchObject({ ok: false, error: '命令超时（500ms）' })
  })

  it('does not launch a command after cancellation', async () => {
    const marker = join(await mkdtemp(join(tmpdir(), 'dsh-pad-cancel-')), 'started.txt')
    const controller = new AbortController()
    controller.abort()
    const reading = await runSource({
      id: 'x', kind: 'command', parse: 'text', intervalSec: 5,
      command: `node -e "require('node:fs').writeFileSync('${marker.replace(/\\/g, '/')}', 'started')"`,
    }, noSecrets, controller.signal)
    expect(reading).toMatchObject({ ok: false, error: '已取消' })
    await expect(readFile(marker, 'utf8')).rejects.toThrow()
  })

  it('caps the output size', async () => {
    const reading = await runSource({ id: 'x', kind: 'command', command: 'node -e "process.stdout.write(\'x\'.repeat(600000))"', parse: 'text', intervalSec: 5 }, noSecrets)
    expect(reading.ok).toBe(false)
    expect(reading.error).toMatch(/输出超过 512KB/)
  })
})

describe('http sources', () => {
  let server: Server
  let base: string
  const seen: { auth?: string, url?: string }[] = []

  beforeAll(async () => {
    server = createServer((req, res) => {
      seen.push({ auth: req.headers.authorization, url: req.url })
      if (req.url?.startsWith('/deep')) {
        res.end('['.repeat(10_000) + '1' + ']'.repeat(10_000))
        return
      }
      if (req.url?.startsWith('/fail')) {
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end(`{"error":"bad key ${req.headers.authorization}"}`)
        return
      }
      if (req.url?.startsWith('/echo')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ authorization: req.headers.authorization, nested: [req.headers.authorization] }))
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"balance":"12.50"}')
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterAll(() => new Promise<void>(resolve => server.close(() => resolve())))

  const source = (path: string): HttpSource => ({
    id: 'api', kind: 'http', url: `${base}${path}?k={{env:TOKEN}}`, parse: 'json', intervalSec: 60,
    headers: { Authorization: 'Bearer {{ env:TOKEN }}' },
  })
  const secrets = async (name: string): Promise<string | undefined> => (name === 'TOKEN' ? 'sk-secret-123' : undefined)

  it('lists secret references', () => {
    expect(secretNames(source('/ok'))).toEqual(['TOKEN'])
  })

  it('reports excessive JSON nesting as a failed reading', async () => {
    const reading = await runSource({ ...source('/deep'), url: `${base}/deep`, headers: {} }, noSecrets)
    expect(reading).toMatchObject({ ok: false, error: expect.stringMatching(/JSON 嵌套超过/) })
    expect(() => JSON.stringify({ panels: [{ data: reading }] })).not.toThrow()
  })

  it('fills secrets on the Host', async () => {
    const reading = await runSource(source('/ok'), secrets)
    expect(reading).toMatchObject({ ok: true, value: { balance: '12.50' } })
    expect(seen.at(-1)).toEqual({ auth: 'Bearer sk-secret-123', url: '/ok?k=sk-secret-123' })
  })

  it('redacts secrets from errors', async () => {
    const reading = await runSource(source('/fail'), secrets)
    expect(reading.ok).toBe(false)
    expect(reading.error).toMatch(/^HTTP 401/)
    expect(reading.error).not.toContain('sk-secret-123')
    expect(reading.error).toContain('***')
  })

  it('redacts credentials echoed in successful responses without corrupting JSON', async () => {
    // Quotes and a backslash force the response to JSON-escape the credential.
    const secret = 'a"b\\c'
    const reading = await runSource({ ...source('/echo'), url: `${base}/echo` }, async () => secret)
    expect(reading).toMatchObject({ ok: true, value: { authorization: 'Bearer ***', nested: ['Bearer ***'] } })
    expect(JSON.stringify(reading)).not.toContain(JSON.stringify(secret).slice(1, -1))
  })

  it('redacts short credentials as well as long ones', async () => {
    const reading = await runSource({ ...source('/fail'), url: `${base}/fail` }, async () => 'xyz')
    expect(reading.error).toContain('***')
    expect(reading.error).not.toContain('xyz')
  })

  it('does not contact an HTTP source after cancellation during secret resolution', async () => {
    const controller = new AbortController()
    let release: (value: string) => void = () => {}
    const resolve = vi.fn(() => new Promise<string>(done => { release = done }))
    const before = seen.length
    const result = runSource({ ...source('/ok'), url: `${base}/ok` }, resolve, controller.signal)
    await Promise.resolve()
    controller.abort()
    release('a-secret')
    expect(await result).toMatchObject({ ok: false, error: '已取消' })
    expect(seen).toHaveLength(before)
  })

  it('names a missing secret', async () => {
    const reading = await runSource(source('/ok'), noSecrets)
    expect(reading).toMatchObject({ ok: false })
    expect(reading.error).toMatch(/密钥 TOKEN 没有配置/)
  })
})

describe('HTTP redirect credential boundaries', () => {
  let server: Server
  let origin: string
  let target: string
  const received: Array<{ method: string, body: string, token?: string, url: string }> = []

  beforeAll(async () => {
    server = createServer(async (req, res) => {
      if (req.url?.startsWith('/jump')) {
        res.writeHead(302, { location: '/cross' })
        res.end()
        return
      }
      if (req.url?.startsWith('/cross')) {
        res.writeHead(req.method === 'POST' ? 307 : 302, { location: target })
        res.end()
        return
      }
      if (req.url?.startsWith('/same')) {
        res.writeHead(Number(new URL(req.url, origin).searchParams.get('status') ?? 302), { location: '/destination' })
        res.end()
        return
      }
      if (req.url?.startsWith('/loop')) {
        res.writeHead(302, { location: '/loop' })
        res.end()
        return
      }
      const parts: Buffer[] = []
      for await (const part of req) parts.push(part as Buffer)
      received.push({ method: req.method!, body: Buffer.concat(parts).toString('utf8'), token: req.headers['x-api-key'] as string | undefined, url: req.url! })
      res.end('{"ok":true}')
    })
    await new Promise<void>(resolve => server.listen(0, resolve))
    const port = (server.address() as AddressInfo).port
    origin = `http://127.0.0.1:${port}`
    target = `http://localhost:${port}/destination`
  })
  afterAll(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) }))

  const http = (path: string, extra: Partial<HttpSource> = {}): HttpSource => ({
    id: 'fixture', kind: 'http', url: origin + path, parse: 'json', intervalSec: 60, timeoutMs: 1000, ...extra,
  })

  it('blocks a custom credential header before a different hostname is contacted', async () => {
    const count = received.length
    const reading = await runSource(http('/cross', { headers: { 'x-api-key': '{{env:TOKEN}}' } }), async () => 'fixture-token')
    expect(reading).toMatchObject({ ok: false, error: expect.stringMatching(/不能跨 origin/) })
    expect(reading.error).not.toContain('fixture-token')
    expect(received).toHaveLength(count)
  })

  it('checks later hops and literal custom headers too', async () => {
    const count = received.length
    const reading = await runSource(http('/jump', { headers: { 'x-api-key': 'fixture-literal' } }), noSecrets)
    expect(reading).toMatchObject({ ok: false, error: expect.stringMatching(/不能跨 origin/) })
    expect(received).toHaveLength(count)
  })

  it('does not resend credential-bearing POST bodies on cross-origin 307', async () => {
    const count = received.length
    const reading = await runSource(http('/cross', { method: 'POST', body: '{"token":"{{env:TOKEN}}"}', headers: { 'content-type': 'application/json' } }), async () => 'fixture-post-token')
    expect(reading).toMatchObject({ ok: false, error: expect.stringMatching(/不能跨 origin/) })
    expect(received).toHaveLength(count)
  })

  it('keeps same-origin credentials on 307 and applies POST-to-GET on 303', async () => {
    const extra: Partial<HttpSource> = { method: 'POST', body: 'token={{env:TOKEN}}', headers: { 'x-api-key': '{{env:TOKEN}}' } }
    expect((await runSource(http('/same?status=307', extra), async () => 'fixture-post')).ok).toBe(true)
    expect(received.at(-1)).toMatchObject({ method: 'POST', body: 'token=fixture-post', token: 'fixture-post' })
    expect((await runSource(http('/same?status=303', extra), async () => 'fixture-post')).ok).toBe(true)
    expect(received.at(-1)).toMatchObject({ method: 'GET', body: '', token: 'fixture-post' })
  })

  it('allows public cross-origin GETs and bounds redirect loops', async () => {
    expect((await runSource(http('/cross'), noSecrets)).ok).toBe(true)
    expect(received.at(-1)).toMatchObject({ method: 'GET', body: '', url: '/destination' })
    expect(await runSource(http('/loop'), noSecrets)).toMatchObject({ ok: false, error: expect.stringMatching(/重定向超过/) })
  })
})
