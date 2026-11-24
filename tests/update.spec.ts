import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { hostBundleMarker, parseHostBundleMarkers, verifyHostBundle } from '../src/host/bundle-integrity.ts'
import { compareVersions, MAX_UPDATE_FILE_BYTES, parseLatestStableRelease, UpdateService } from '../src/host/update.ts'
import { recoverUpdate, UPDATE_JOURNAL } from '../src/host/update-transaction.ts'

const roots: string[] = []
const VALID_PATCH = '- insert:\n    - id: dsh-pad\n      name: dsh-pad\n'

function validManifest(version = '0.2.0', overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    name: 'dsh-pad',
    version,
    main: 'lib/index.js',
    exports: { '.': './lib/index.js', './client': './lib/client.js' },
    dsh: { bundle: { patch: './cordis.patch.yml' } },
    ...overrides,
  })
}

function validClientBundle(body = 'new client'.padEnd(1200, 'y'), withSourceMap = true): string {
  return [
    'window.__ModuleLoader__.load({ id: "dsh-pad", factory: (require) => {',
    `/* ${body} */`,
    'return module.exports; } });',
    ...(withSourceMap ? ['//# sourceMappingURL=client.js.map'] : []),
  ].join('\n')
}

async function pluginRoot(version = '0.1.1', source = false): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-pad-update-'))
  roots.push(root)
  await mkdir(join(root, 'lib'), { recursive: true })
  await writeFile(join(root, 'package.json'), validManifest(version))
  await writeFile(join(root, 'lib', 'index.js'), 'old host')
  await writeFile(join(root, 'lib', 'client.js'), 'old client')
  await writeFile(join(root, 'cordis.patch.yml'), VALID_PATCH)
  if (source) await mkdir(join(root, '.git'))
  return root
}

function releaseFetch(files: Record<string, string | Response> = {}, feedXml?: string): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.endsWith('/releases.atom')) {
      return new Response(feedXml ?? [
        '<?xml version="1.0"?><feed>',
        '<entry><link rel="alternate" type="text/html" href="https://github.com/ChisaAlter/dsh-pad/releases/tag/v0.2.0"/>',
        '<title>v0.2.0 — test</title></entry>',
        '</feed>',
      ].join(''), { status: 200 })
    }
    const match = /raw\.githubusercontent\.com\/ChisaAlter\/dsh-pad\/[^/]+\/(.+)$/.exec(url)
    const file = match?.[1]
    const override = file === undefined ? undefined : files[file]
    if (override instanceof Response) return override
    if (override !== undefined) return new Response(override, { status: 200 })
    if (file === 'package.json') {
      return new Response(validManifest('0.2.0'), { status: 200 })
    }
    return new Response('missing', { status: 404 })
  }) as typeof fetch
}

export function hostBundle(body = 'test host body'): string {
  const bodyId = createHash('sha256').update(body).digest('hex')
  const withBody = body + `\n// dsh-pad-body:${bodyId}\n`
  const id = createHash('sha256').update(withBody).digest('hex')
  return withBody + `\n// dsh-pad-build:${id}\n`
}

function controlledPromise<T>(): { promise: Promise<T>, resolve: (value: T) => void, reject: (reason: unknown) => void } {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail })
  return { promise, resolve, reject }
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

  it.each([
    ['1.0.0-alpha', '1.0.0-alpha.1'],
    ['1.0.0-alpha.1', '1.0.0-alpha.beta'],
    ['1.0.0-alpha.beta', '1.0.0-beta'],
    ['1.0.0-beta', '1.0.0-beta.2'],
    ['1.0.0-beta.2', '1.0.0-beta.11'],
    ['1.0.0-beta.11', '1.0.0-rc.1'],
    ['1.0.0-rc.2', '1.0.0-rc.10'],
    ['1.0.0-rc.10', '1.0.0'],
    ['1.0.0-9', '1.0.0-alpha'],
    ['1.0.0-RC', '1.0.0-rc'],
    ['1.0.0-rc.9007199254740992', '1.0.0-rc.9007199254740993'],
  ])('orders SemVer identifiers %s < %s', (left, right) => {
    expect(compareVersions(left, right)).toBeLessThan(0)
    expect(compareVersions(right, left)).toBeGreaterThan(0)
  })

  it('ignores build metadata in stable and prerelease versions', () => {
    expect(compareVersions('1.0.0+build.10', 'v1.0.0+build.2')).toBe(0)
    expect(compareVersions('1.0.0-rc.10+build.2', '1.0.0-rc.10')).toBe(0)
    expect(compareVersions('1.0.0-rc.10+build.2', '1.0.0-rc.2+build.10')).toBeGreaterThan(0)
  })

  it.each(['1.0.0-rc..1', '1.0.0-01', '1.0.0-', '1.00.0', '1.0.0+'])('rejects invalid SemVer tags: %s', version => {
    expect(compareVersions(version, '1.0.0')).toBe(0)
  })
})

describe('Atom feed parsing and bundle integrity', () => {
  it('rejects malicious href schemes/hosts and traversal tags', () => {
    const feed = [
      '<feed>',
      '<entry><link href="javascript:alert(1)/releases/tag/v9.9.9"/></entry>',
      '<entry><link href="https://evil.example/ChisaAlter/dsh-pad/releases/tag/v9.9.9"/></entry>',
      '<entry><link href="https://github.com/OtherOwner/dsh-pad/releases/tag/v9.9.9"/></entry>',
      '<entry><link href="https://github.com/ChisaAlter/dsh-pad/releases/tag/..%2Fv9.9.9"/></entry>',
      '<entry><link href="https://github.com/ChisaAlter/dsh-pad/releases/tag/v0.2.0?evil=1"/></entry>',
      '</feed>',
    ].join('')
    expect(parseLatestStableRelease(feed)).toBeUndefined()
  })

  it('skips prereleases across all entries and picks the highest stable version', () => {
    const feed = [
      '<feed>',
      '<entry><link rel="alternate" href="https://github.com/ChisaAlter/dsh-pad/releases/tag/v0.5.0-rc.1"/></entry>',
      '<entry><link rel="alternate" href="https://github.com/ChisaAlter/dsh-pad/releases/tag/v0.4.0-beta.2"/></entry>',
      '<entry><link rel="alternate" href="https://github.com/ChisaAlter/dsh-pad/releases/tag/v0.2.1"/></entry>',
      '<entry><link rel="alternate" href="https://github.com/ChisaAlter/dsh-pad/releases/tag/v0.3.0-alpha.1"/></entry>',
      '<entry><link rel="alternate" href="https://github.com/ChisaAlter/dsh-pad/releases/tag/v0.3.2"/></entry>',
      '</feed>',
    ].join('')
    expect(parseLatestStableRelease(feed)).toEqual({
      tag: 'v0.3.2',
      version: '0.3.2',
      url: 'https://github.com/ChisaAlter/dsh-pad/releases/tag/v0.3.2',
    })
  })

  it('decodes URL-encoded tags and rebuilds the release URL from the allowlisted prefix', () => {
    const feed = '<feed><entry><link href="https://github.com/ChisaAlter/dsh-pad/releases/tag/v0.2.0%2Bbuild.1"/></entry></feed>'
    expect(parseLatestStableRelease(feed)).toEqual({
      tag: 'v0.2.0+build.1',
      version: '0.2.0+build.1',
      url: 'https://github.com/ChisaAlter/dsh-pad/releases/tag/v0.2.0%2Bbuild.1',
    })
  })

  it('requires dsh-pad-body and dsh-pad-build to be jointly anchored at EOF', () => {
    const body = 'new host'.padEnd(1200, 'x')
    const valid = hostBundle(body)
    const markers = parseHostBundleMarkers(valid)
    expect(markers).toBeDefined()
    expect(verifyHostBundle(valid).bodyDigest).toBe(markers!.bodyDigest)

    // Mid-file body marker followed by extra lines before build marker must fail.
    const fakeBodyDigest = createHash('sha256').update(body).digest('hex')
    const midPrefix = `${body}\n// dsh-pad-body:${fakeBodyDigest}\nconst injected = 1;\n`
    const midBuild = createHash('sha256').update(midPrefix).digest('hex')
    const forged = `${midPrefix}\n// dsh-pad-build:${midBuild}\n`
    expect(parseHostBundleMarkers(forged)).toBeUndefined()
    expect(() => verifyHostBundle(forged)).toThrow(/dsh-pad-body/)
  })

  it('verifies embedded __dshPadHostBody matches dsh-pad-body sha256', () => {
    const inner = 'exports.name = "dsh-pad";\n'
    const mismatchedDigest = createHash('sha256').update('different body').digest('hex')
    const wrapperPrefix = `var __dshPadHostBody = ${JSON.stringify(inner)};\nnew Function("require","module","exports","__dshPadModuleUrl",__dshPadHostBody);\n`.padEnd(1200, ' ')
    const withBody = `${wrapperPrefix}\n// dsh-pad-body:${mismatchedDigest}`
    const buildId = createHash('sha256').update(withBody).digest('hex')
    expect(() => verifyHostBundle(`${withBody}\n// dsh-pad-build:${buildId}\n`)).toThrow(/内嵌正文/)

    const realDigest = createHash('sha256').update(inner).digest('hex')
    const validWithBody = `${wrapperPrefix}\n// dsh-pad-body:${realDigest}`
    const validBuildId = createHash('sha256').update(validWithBody).digest('hex')
    expect(verifyHostBundle(`${validWithBody}\n// dsh-pad-build:${validBuildId}\n`).bodyDigest).toBe(realDigest)
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
        'lib/index.js': hostBundle('new host'.padEnd(1200, 'x')),
        'lib/client.js': validClientBundle(),
        'cordis.patch.yml': VALID_PATCH,
      }),
    })

    const info = await service.check(true)
    expect(info.available).toBe(true)
    expect(info.latest).toBe('0.2.0')
    expect(info.canApply).toBe(true)
    expect(info.reason).toBe('available')

    const applied = await service.apply()
    expect(applied.ok, applied.error).toBe(true)
    expect(applied.update.applied).toBe('0.2.0')
    expect(applied.update.requiresRestart).toBe(true)
    expect(JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version).toBe('0.2.0')
    expect((await readFile(join(root, 'lib', 'index.js'), 'utf8')).startsWith('new host')).toBe(true)
    expect(existsSync(join(root, '.dsh-pad-update-backup'))).toBe(true)
  })

  it.each([
    ['applied', 'success'], ['applied', 'failure'],
    ['pending', 'success'], ['pending', 'failure'],
  ] as const)('preserves %s state when an older feed check settles with %s', async (outcome, feedResult) => {
    const root = await pluginRoot()
    const blocker = join(root, 'lib', `client.js.update-${process.pid}`)
    if (outcome === 'pending') await mkdir(blocker)
    const response = controlledPromise<Response>()
    const waiting = controlledPromise<void>()
    const release = releaseFetch({
      'lib/index.js': hostBundle('new host'.padEnd(1200, 'x')),
      'lib/client.js': validClientBundle(),
      'cordis.patch.yml': VALID_PATCH,
    })
    let feeds = 0
    let requests = 0
    const service = new UpdateService({
      current: '0.1.1', root, enabled: true, checkHours: 6,
      fetchImpl: (async (input, init) => {
        requests++
        if (String(input).endsWith('/releases.atom') && ++feeds === 2) {
          waiting.resolve()
          return response.promise
        }
        return release(input, init)
      }) as typeof fetch,
    })
    await service.check(true)
    const staleCheck = service.check(true)
    await waiting.promise
    const applied = await service.apply()
    expect(applied.ok, applied.error).toBe(outcome === 'applied')
    expect(applied.update.requiresRestart).toBe(true)
    expect(applied.update.canApply).toBe(false)
    const stateAfterApply = service.info()
    if (feedResult === 'success') {
      response.resolve(new Response('<feed><entry><link href="https://github.com/ChisaAlter/dsh-pad/releases/tag/v0.3.0"/></entry></feed>'))
    } else {
      response.reject(new Error('late feed failure'))
    }
    expect(await staleCheck).toBe(stateAfterApply)
    expect(service.info()).toBe(stateAfterApply)
    const beforeRetry = requests
    const retry = await service.apply()
    expect(retry.ok, retry.error).toBe(outcome === 'applied')
    expect(retry.update.canApply).toBe(false)
    expect(retry.update.requiresRestart).toBe(true)
    expect(requests).toBe(beforeRetry)
    if (outcome === 'applied') {
      expect(retry.update.reason).toBe('applied')
      expect(retry.update.applied).toBe('0.2.0')
    } else {
      expect(retry.error).toContain('重启以恢复完整更新')
      expect(existsSync(join(root, UPDATE_JOURNAL))).toBe(true)
    }
  })

  it('keeps every installed file when creating the backup fails', async () => {
    const root = await pluginRoot()
    // A non-directory at the backup path reproduces a failed mkdir before any
    // installed file has been replaced (also occurs with permissions/disk errors).
    await writeFile(join(root, '.dsh-pad-update-backup'), 'blocked')
    const service = new UpdateService({
      current: '0.1.1', root, enabled: true, checkHours: 6,
      fetchImpl: releaseFetch({
        'lib/index.js': hostBundle('new host'.padEnd(1200, 'x')),
        'lib/client.js': validClientBundle(),
        'cordis.patch.yml': VALID_PATCH,
      }),
    })
    await service.check(true)
    expect((await service.apply()).ok).toBe(false)
    expect(await readFile(join(root, 'lib', 'index.js'), 'utf8')).toBe('old host')
    expect(await readFile(join(root, 'lib', 'client.js'), 'utf8')).toBe('old client')
    expect(JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version).toBe('0.1.1')
    expect(await readFile(join(root, 'cordis.patch.yml'), 'utf8')).toBe(VALID_PATCH)
  })

  it('retains a complete recoverable update after a replacement fails and blocks another apply', async () => {
    const root = await pluginRoot()
    const blocker = join(root, 'lib', `client.js.update-${process.pid}`)
    await mkdir(blocker)
    const nextPatch = `${VALID_PATCH}# new\n`
    const nextClient = validClientBundle('next client'.padEnd(1200, 'y'))
    const service = new UpdateService({
      current: '0.1.1', root, enabled: true, checkHours: 6,
      fetchImpl: releaseFetch({
        'lib/index.js': hostBundle('new host'.padEnd(1200, 'x')),
        'lib/client.js': nextClient,
        'cordis.patch.yml': nextPatch,
      }),
    })
    await service.check(true)
    const failed = await service.apply()
    expect(failed.ok).toBe(false)
    expect(failed.update.canApply, failed.error).toBe(false)
    expect(failed.update.requiresRestart).toBe(true)
    expect(failed.error).toContain('重启以恢复完整更新')
    const journal = await readFile(join(root, UPDATE_JOURNAL), 'utf8')
    expect((await readFile(join(root, 'lib', 'index.js'), 'utf8')).startsWith('new host')).toBe(true)
    expect(await readFile(join(root, 'lib', 'client.js'), 'utf8')).toBe('old client')
    expect(JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version).toBe('0.1.1')
    expect((await service.check(true)).canApply).toBe(false)
    expect((await service.apply()).ok).toBe(false)
    expect(await readFile(join(root, UPDATE_JOURNAL), 'utf8')).toBe(journal)
    // The loader calls this before initializing the Host body, after the
    // environmental failure is removed; no live installation is involved.
    await rm(blocker, { recursive: true })
    expect(await recoverUpdate(root)).toBe(true)
    expect(await recoverUpdate(root)).toBe(false)
    expect(await readFile(join(root, 'lib', 'client.js'), 'utf8')).toBe(nextClient)
    expect(JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version).toBe('0.2.0')
    expect(await readFile(join(root, 'cordis.patch.yml'), 'utf8')).toBe(nextPatch)
    expect(existsSync(join(root, UPDATE_JOURNAL))).toBe(false)
  })

  it('does not replace a source checkout', async () => {
    const root = await pluginRoot('0.1.1', true)
    const service = new UpdateService({
      current: '0.1.1',
      root,
      enabled: true,
      checkHours: 6,
      fetchImpl: releaseFetch({
        'lib/index.js': hostBundle('new host'.padEnd(1200, 'x')),
        'lib/client.js': validClientBundle(),
        'cordis.patch.yml': VALID_PATCH,
      }),
    })
    const info = await service.check(true)
    expect(info.available).toBe(true)
    expect(info.canApply).toBe(false)
    expect(info.reason).toBe('source')
    const applied = await service.apply()
    expect(applied.ok, applied.error).toBe(false)
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
        'lib/index.js': hostBundle('new host'.padEnd(1200, 'x')),
        'lib/client.js': validClientBundle(),
        'cordis.patch.yml': VALID_PATCH,
      }),
    })
    const info = await service.check(true)
    expect(info.available).toBe(false)
    expect(info.reason).toBe('up-to-date')
  })

  it('ignores prerelease-only and malicious feed entries during check()', async () => {
    const root = await pluginRoot('0.1.1')
    const service = new UpdateService({
      current: '0.1.1',
      root,
      enabled: true,
      checkHours: 6,
      fetchImpl: releaseFetch(
        {},
        [
          '<feed>',
          '<entry><link href="https://evil.example/ChisaAlter/dsh-pad/releases/tag/v9.9.9"/></entry>',
          '<entry><link href="https://github.com/ChisaAlter/dsh-pad/releases/tag/v0.5.0-rc.1"/></entry>',
          '</feed>',
        ].join(''),
      ),
    })
    const info = await service.check(true)
    expect(info.available).toBe(false)
    expect(info.latest).toBeUndefined()
    expect(info.url).toBe('https://github.com/ChisaAlter/dsh-pad/releases')
  })

  it('rejects a host bundle without a build marker before replacing files', async () => {
    const root = await pluginRoot()
    const service = new UpdateService({
      current: '0.1.1', root, enabled: true, checkHours: 6,
      fetchImpl: releaseFetch({
        'lib/index.js': 'new host'.padEnd(1200, 'x'),
        'lib/client.js': validClientBundle(),
        'cordis.patch.yml': VALID_PATCH,
      }),
    })
    await service.check(true)
    const applied = await service.apply()
    expect(applied.ok).toBe(false)
    expect(applied.error).toContain('校验')
    expect(await readFile(join(root, 'lib', 'index.js'), 'utf8')).toBe('old host')
    expect(existsSync(join(root, UPDATE_JOURNAL))).toBe(false)
  })

  it('rejects a host bundle whose build marker hash does not match', async () => {
    const root = await pluginRoot()
    const bundle = hostBundle('new host'.padEnd(1200, 'x'))
    const corrupt = bundle.slice(0, 100) + 'y' + bundle.slice(101)
    expect(hostBundleMarker(corrupt)).toBe(hostBundleMarker(bundle))
    const service = new UpdateService({
      current: '0.1.1', root, enabled: true, checkHours: 6,
      fetchImpl: releaseFetch({
        'lib/index.js': corrupt,
        'lib/client.js': validClientBundle(),
        'cordis.patch.yml': VALID_PATCH,
      }),
    })
    await service.check(true)
    const applied = await service.apply()
    expect(applied.ok).toBe(false)
    expect(applied.error).toContain('校验')
    expect(await readFile(join(root, 'lib', 'index.js'), 'utf8')).toBe('old host')
    expect(existsSync(join(root, UPDATE_JOURNAL))).toBe(false)
  })

  it('rejects a host bundle without a body marker before replacing files', async () => {
    const root = await pluginRoot()
    const body = 'new host'.padEnd(1200, 'x')
    const id = createHash('sha256').update(`${body}\n`).digest('hex')
    const bundle = `${body}\n\n// dsh-pad-build:${id}\n`
    const service = new UpdateService({
      current: '0.1.1', root, enabled: true, checkHours: 6,
      fetchImpl: releaseFetch({
        'lib/index.js': bundle,
        'lib/client.js': validClientBundle(),
        'cordis.patch.yml': VALID_PATCH,
      }),
    })
    await service.check(true)
    const applied = await service.apply()
    expect(applied.ok).toBe(false)
    expect(applied.error).toContain('校验')
    expect(await readFile(join(root, 'lib', 'index.js'), 'utf8')).toBe('old host')
    expect(existsSync(join(root, UPDATE_JOURNAL))).toBe(false)
  })

  it('rejects a truncated client bundle missing closure header or footer', async () => {
    const root = await pluginRoot()
    const truncated = 'window.__ModuleLoader__.load({ id: "dsh-pad", factory: () => {\n' + 'x'.repeat(1200)
    const service = new UpdateService({
      current: '0.1.1', root, enabled: true, checkHours: 6,
      fetchImpl: releaseFetch({
        'lib/index.js': hostBundle('new host'.padEnd(1200, 'x')),
        'lib/client.js': truncated,
        'cordis.patch.yml': VALID_PATCH,
      }),
    })
    await service.check(true)
    const applied = await service.apply()
    expect(applied.ok).toBe(false)
    expect(applied.error).toContain('校验')
    expect(await readFile(join(root, 'lib', 'client.js'), 'utf8')).toBe('old client')
  })

  it('rejects an invalid package.json manifest or cordis.patch.yml before replacing files', async () => {
    const root = await pluginRoot()
    const badManifestService = new UpdateService({
      current: '0.1.1', root, enabled: true, checkHours: 6,
      fetchImpl: releaseFetch({
        'package.json': JSON.stringify({ name: 'dsh-pad', version: '0.2.0', main: 'lib/index.js' }),
        'lib/index.js': hostBundle('new host'.padEnd(1200, 'x')),
        'lib/client.js': validClientBundle(),
        'cordis.patch.yml': VALID_PATCH,
      }),
    })
    await badManifestService.check(true)
    const badManifestResult = await badManifestService.apply()
    expect(badManifestResult.ok).toBe(false)
    expect(badManifestResult.error).toContain('校验')

    const badPatchService = new UpdateService({
      current: '0.1.1', root, enabled: true, checkHours: 6,
      fetchImpl: releaseFetch({
        'lib/index.js': hostBundle('new host'.padEnd(1200, 'x')),
        'lib/client.js': validClientBundle(),
        'cordis.patch.yml': '- insert: []',
      }),
    })
    await badPatchService.check(true)
    const badPatchResult = await badPatchService.apply()
    expect(badPatchResult.ok).toBe(false)
    expect(badPatchResult.error).toContain('校验')
    expect(await readFile(join(root, 'cordis.patch.yml'), 'utf8')).toBe(VALID_PATCH)
  })

  it('rejects oversized file downloads by both content-length and streamed body size', async () => {
    const root = await pluginRoot()
    const byHeader = new UpdateService({
      current: '0.1.1', root, enabled: true, checkHours: 6,
      fetchImpl: releaseFetch({
        'lib/index.js': hostBundle('new host'.padEnd(1200, 'x')),
        'lib/client.js': new Response('short', {
          status: 200,
          headers: { 'content-length': String(MAX_UPDATE_FILE_BYTES + 1) },
        }),
        'cordis.patch.yml': VALID_PATCH,
      }),
    })
    await byHeader.check(true)
    const headerRes = await byHeader.apply()
    expect(headerRes.ok).toBe(false)
    expect(headerRes.error).toContain('下载失败')
    expect(headerRes.error).toContain('超过上限')

    const oversizedStream = new ReadableStream<Uint8Array>({
      start(controller) {
        const chunk = new Uint8Array(512 * 1024)
        for (let i = 0; i < 5; i += 1) controller.enqueue(chunk)
        controller.close()
      },
    })
    const byStream = new UpdateService({
      current: '0.1.1', root, enabled: true, checkHours: 6,
      fetchImpl: releaseFetch({
        'lib/index.js': hostBundle('new host'.padEnd(1200, 'x')),
        'lib/client.js': new Response(oversizedStream, { status: 200 }),
        'cordis.patch.yml': VALID_PATCH,
      }),
    })
    await byStream.check(true)
    const streamRes = await byStream.apply()
    expect(streamRes.ok).toBe(false)
    expect(streamRes.error).toContain('下载失败')
    expect(streamRes.error).toContain('超过上限')
    expect(await readFile(join(root, 'lib', 'client.js'), 'utf8')).toBe('old client')
  })
})
