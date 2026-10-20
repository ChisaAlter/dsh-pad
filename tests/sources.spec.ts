import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parseOutput, runSource, secretNames } from '../src/host/sources.ts'
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
      if (req.url?.startsWith('/fail')) {
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end(`{"error":"bad key ${req.headers.authorization}"}`)
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

  it('names a missing secret', async () => {
    const reading = await runSource(source('/ok'), noSecrets)
    expect(reading).toMatchObject({ ok: false })
    expect(reading.error).toMatch(/密钥 TOKEN 没有配置/)
  })
})
