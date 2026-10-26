import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { compareVersions, UpdateService } from '../src/host/update.ts'

const roots: string[] = []

async function pluginRoot(version = '0.1.1', source = false): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-pad-update-'))
  roots.push(root)
  await mkdir(join(root, 'lib'), { recursive: true })
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'dsh-pad', version }))
  await writeFile(join(root, 'lib', 'index.js'), 'old host')
  await writeFile(join(root, 'lib', 'client.js'), 'old client')
  await writeFile(join(root, 'cordis.patch.yml'), '- insert: []')
  if (source) await mkdir(join(root, '.git'))
  return root
}

function releaseFetch(files: Record<string, string> = {}): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.endsWith('/releases.atom')) {
      return new Response([
        '<?xml version="1.0"?><feed>',
        '<entry><link rel="alternate" type="text/html" href="https://github.com/ChisaAlter/dsh-pad/releases/tag/v0.2.0"/>',
        '<title>v0.2.0 — test</title></entry>',
        '</feed>',
      ].join(''), { status: 200 })
    }
    const match = /raw\.githubusercontent\.com\/ChisaAlter\/dsh-pad\/v0\.2\.0\/(.+)$/.exec(url)
    const file = match?.[1]
    if (file === 'package.json') {
      return new Response(JSON.stringify({ name: 'dsh-pad', version: '0.2.0' }), { status: 200 })
    }
    const body = file === undefined ? undefined : files[file]
    if (body !== undefined) return new Response(body, { status: 200 })
    return new Response('missing', { status: 404 })
  }) as typeof fetch
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('version comparison', () => {
  it('orders numeric releases and ignores a leading v', () => {
    expect(compareVersions('0.2.0', '0.1.9')).toBeGreaterThan(0)
    expect(compareVersions('v0.2.0', '0.2.0')).toBe(0)
    expect(compareVersions('0.1.1', '0.2.0')).toBeLessThan(0)
    expect(compareVersions('nonsense', '0.2.0')).toBe(0)
  })

  it('sorts a prerelease before its release', () => {
    expect(compareVersions('0.2.0-rc.1', '0.2.0')).toBeLessThan(0)
    expect(compareVersions('0.2.0', '0.2.0-rc.1')).toBeGreaterThan(0)
  })
})

describe('UpdateService', () => {
  it('reports a newer release and replaces the built files on apply', async () => {
    const root = await pluginRoot()
    const service = new UpdateService({
      current: '0.1.1',
      root,
      enabled: true,
      checkHours: 6,
      fetchImpl: releaseFetch({
        'lib/index.js': 'new host'.padEnd(1200, 'x'),
        'lib/client.js': 'new client'.padEnd(1200, 'y'),
        'cordis.patch.yml': '- insert:\n    - id: dsh-pad',
      }),
    })

    const info = await service.check(true)
    expect(info.available).toBe(true)
    expect(info.latest).toBe('0.2.0')
    expect(info.canApply).toBe(true)
    expect(info.reason).toBe('available')

    const applied = await service.apply()
    expect(applied.ok).toBe(true)
    expect(applied.update.applied).toBe('0.2.0')
    expect(applied.update.requiresRestart).toBe(true)
    expect(JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version).toBe('0.2.0')
    expect((await readFile(join(root, 'lib', 'index.js'), 'utf8')).startsWith('new host')).toBe(true)
    expect(existsSync(join(root, '.dsh-pad-update-backup'))).toBe(true)
  })

  it('keeps every installed file when creating the backup fails', async () => {
    const root = await pluginRoot()
    // A non-directory at the backup path reproduces a failed mkdir before any
    // installed file has been replaced (also occurs with permissions/disk errors).
    await writeFile(join(root, '.dsh-pad-update-backup'), 'blocked')
    const service = new UpdateService({
      current: '0.1.1', root, enabled: true, checkHours: 6,
      fetchImpl: releaseFetch({
        'lib/index.js': 'new host'.padEnd(1200, 'x'),
        'lib/client.js': 'new client'.padEnd(1200, 'y'),
        'cordis.patch.yml': '- insert: []',
      }),
    })
    await service.check(true)
    expect((await service.apply()).ok).toBe(false)
    expect(await readFile(join(root, 'lib', 'index.js'), 'utf8')).toBe('old host')
    expect(await readFile(join(root, 'lib', 'client.js'), 'utf8')).toBe('old client')
    expect(JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version).toBe('0.1.1')
    expect(await readFile(join(root, 'cordis.patch.yml'), 'utf8')).toBe('- insert: []')
  })

  it('restores every installed file after a replacement fails', async () => {
    const root = await pluginRoot()
    await mkdir(join(root, 'lib', `client.js.update-${process.pid}`))
    const service = new UpdateService({
      current: '0.1.1', root, enabled: true, checkHours: 6,
      fetchImpl: releaseFetch({
        'lib/index.js': 'new host'.padEnd(1200, 'x'),
        'lib/client.js': 'new client'.padEnd(1200, 'y'),
        'cordis.patch.yml': '- insert: []',
      }),
    })
    await service.check(true)
    expect((await service.apply()).ok).toBe(false)
    expect(await readFile(join(root, 'lib', 'index.js'), 'utf8')).toBe('old host')
    expect(await readFile(join(root, 'lib', 'client.js'), 'utf8')).toBe('old client')
    expect(JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version).toBe('0.1.1')
  })

  it('does not replace a source checkout', async () => {
    const root = await pluginRoot('0.1.1', true)
    const service = new UpdateService({
      current: '0.1.1',
      root,
      enabled: true,
      checkHours: 6,
      fetchImpl: releaseFetch({
        'lib/index.js': 'new host'.padEnd(1200, 'x'),
        'lib/client.js': 'new client'.padEnd(1200, 'y'),
        'cordis.patch.yml': '- insert: []',
      }),
    })
    const info = await service.check(true)
    expect(info.available).toBe(true)
    expect(info.canApply).toBe(false)
    expect(info.reason).toBe('source')
    const applied = await service.apply()
    expect(applied.ok).toBe(false)
    expect(applied.error).toBe('source')
    expect(JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version).toBe('0.1.1')
  })

  it('reports up to date when the release is not newer', async () => {
    const root = await pluginRoot('0.2.0')
    const service = new UpdateService({
      current: '0.2.0',
      root,
      enabled: true,
      checkHours: 6,
      fetchImpl: releaseFetch({
        'lib/index.js': 'new host'.padEnd(1200, 'x'),
        'lib/client.js': 'new client'.padEnd(1200, 'y'),
        'cordis.patch.yml': '- insert: []',
      }),
    })
    const info = await service.check(true)
    expect(info.available).toBe(false)
    expect(info.reason).toBe('up-to-date')
  })
})
