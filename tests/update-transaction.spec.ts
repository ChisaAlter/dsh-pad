import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, realpathSync } from 'node:fs'
import { createServer } from 'node:net'
import { mkdtemp, mkdir, open, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { recoverUpdate, replaceUpdateFiles, updateLockEndpoint, UPDATE_FILES, UPDATE_JOURNAL } from '../src/host/update-transaction.ts'

const roots: string[] = []
let helper: string
beforeAll(async () => {
  const result = await build({
    entryPoints: ['src/host/update-transaction.ts'], bundle: true, write: false,
    format: 'cjs', platform: 'node', target: 'node22',
  })
  helper = result.outputFiles[0]!.text
})
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

const release = new Map<string, string>([
  ['lib/index.js', 'export const version = "new-host";'],
  ['lib/client.js', '// new-client'],
  ['package.json', JSON.stringify({ name: 'dsh-pad', version: '0.2.0', type: 'module' })],
  ['cordis.patch.yml', '- insert: [new]'],
])

function original(file: string): string {
  return file === 'package.json' ? JSON.stringify({ name: 'dsh-pad', version: '0.1.0', type: 'module' }) : `old:${file}`
}

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-pad-transaction-'))
  roots.push(root)
  await mkdir(join(root, 'lib'))
  for (const file of UPDATE_FILES) await writeFile(join(root, file), original(file))
  await writeFile(join(root, 'update-helper.cjs'), helper)
  return root
}

async function snapshot(root: string): Promise<string[]> {
  return Promise.all(UPDATE_FILES.map(file => readFile(join(root, file), 'utf8')))
}

/**
 * Fake roots only. A fresh Node exits at an exact filesystem boundary without
 * running a catch handler, approximating process termination during replacement.
 * No plugin, model, credential, network or data source is loaded by this child.
 */
async function child(root: string, mode: 'apply' | 'recover', boundary?: number, before = false): Promise<number | null> {
  const script = join(root, 'transaction-child.cjs')
  await writeFile(script, `
const fs = require('node:fs');
const path = require('node:path');
const root = __dirname;
const files = ${JSON.stringify(UPDATE_FILES)};
const rename = fs.renameSync;
fs.renameSync = function (from, to) {
  const index = files.findIndex(file => path.join(root, file) === to);
  if (${JSON.stringify(before)} && index === ${boundary ?? -1}) process.exit(73);
  const result = rename(from, to);
  if (!${JSON.stringify(before)} && index === ${boundary ?? -1}) process.exit(73);
  return result;
};
const helper = require('./update-helper.cjs');
const operation = ${JSON.stringify(mode)} === 'recover' ? helper.recoverUpdate(root) : helper.replaceUpdateFiles(root, new Map(${JSON.stringify([...release])}));
operation.catch(error => { console.error(error); process.exitCode = 1; });
`)
  const output = await open(join(root, 'child-output.txt'), 'w')
  try {
    const process = spawn(globalThis.process.execPath, [script], { cwd: root, stdio: ['ignore', output.fd, output.fd] })
    const code = await new Promise<number | null>((resolve, reject) => { process.once('error', reject); process.once('exit', resolve) })
    if (code !== 0 && code !== 73) throw new Error(`Child failed (${code}): ${await readFile(join(root, 'child-output.txt'), 'utf8')}`)
    return code
  } finally {
    await output.close()
  }
}

async function journal(root: string): Promise<{ format: number, id: string, files: { path: string, size: number, sha256: string }[] }> {
  return JSON.parse(await readFile(join(root, UPDATE_JOURNAL), 'utf8'))
}

async function worker(root: string, name: string, source: string) {
  const script = join(root, `${name}.cjs`)
  await writeFile(script, source)
  const output = await open(join(root, `${name}-output.txt`), 'w')
  const process = spawn(globalThis.process.execPath, [script], { cwd: root, stdio: ['ignore', output.fd, output.fd] })
  const exited = new Promise<number | null>((resolve, reject) => { process.once('error', reject); process.once('exit', resolve) })
  return {
    process,
    async done(): Promise<number | null> {
      try {
        const code = await exited
        if (code !== 0 && code !== 73) throw new Error(`Worker ${name} failed (${code}): ${await readFile(join(root, `${name}-output.txt`), 'utf8')}`)
        return code
      } finally { await output.close() }
    },
  }
}

async function untilFile(path: string): Promise<void> {
  const deadline = Date.now() + 4000
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`Worker did not reach ${path}`)
    await delay(10)
  }
}

describe('durable update transaction', () => {
  it('does not bind or wait for the lock endpoint when there is no journal', async () => {
    const root = await fixture()
    const occupied = createServer(socket => { socket.destroy() })
    await new Promise<void>((resolve, reject) => {
      occupied.once('error', reject)
      occupied.listen(updateLockEndpoint(root), resolve)
    })
    const started = Date.now()
    try {
      expect(await recoverUpdate(root)).toBe(false)
      expect(Date.now() - started).toBeLessThan(1000)
      expect(await snapshot(root)).toEqual(UPDATE_FILES.map(original))
    } finally {
      await new Promise<void>((resolve, reject) => { occupied.close(error => { if (error) reject(error); else resolve() }) })
    }
  })

  it.skipIf(process.platform !== 'win32' && process.platform !== 'linux')('uses a root-specific IPC name even when the old TCP lock port is occupied', async () => {
    const root = await fixture()
    let canonical = realpathSync.native(root)
    if (process.platform === 'win32') canonical = canonical.toLowerCase()
    const hash = createHash('sha256').update(canonical).digest('hex')
    const endpoint = updateLockEndpoint(root)
    expect(endpoint.path).toBe(process.platform === 'win32' ? `\\\\.\\pipe\\dsh-pad-update-${hash}` : `\0dsh-pad-update-${hash}`)
    expect(endpoint.port).toBeUndefined()
    const oldPort = 49152 + Number.parseInt(hash.slice(0, 4), 16) % 16384
    const occupied = createServer(socket => { socket.destroy() })
    await new Promise<void>((resolve, reject) => {
      occupied.once('error', reject)
      occupied.listen({ host: '127.0.0.1', port: oldPort, exclusive: true }, resolve)
    })
    try {
      await replaceUpdateFiles(root, release)
      expect(await snapshot(root)).toEqual([...release.values()])
      expect(existsSync(join(root, UPDATE_JOURNAL))).toBe(false)
    } finally {
      await new Promise<void>((resolve, reject) => { occupied.close(error => { if (error) reject(error); else resolve() }) })
    }
  })

  it.each([0, 1, 2, 3])('recovers the full release in a fresh process after file %i is replaced', async boundary => {
    const root = await fixture()
    expect(await child(root, 'apply', boundary)).toBe(73)
    const pending = await journal(root)
    expect(pending.files.map(file => file.path)).toEqual(UPDATE_FILES)
    for (const file of pending.files) {
      expect(file.sha256).toMatch(/^[0-9a-f]{64}$/)
      expect(file.size).toBe(Buffer.byteLength(release.get(file.path)!))
    }
    expect(await child(root, 'recover')).toBe(0)
    expect(await snapshot(root)).toEqual([...release.values()])
    expect(existsSync(join(root, UPDATE_JOURNAL))).toBe(false)
    expect(await recoverUpdate(root)).toBe(false)
    for (const file of UPDATE_FILES) {
      expect(await readFile(join(root, '.dsh-pad-update-backup', pending.id, 'original', file), 'utf8')).toBe(original(file))
    }
  })

  it('can recover when publication succeeded but no installed file was replaced', async () => {
    const root = await fixture()
    expect(await child(root, 'apply', 0, true)).toBe(73)
    expect(await snapshot(root)).toEqual(UPDATE_FILES.map(original))
    expect(await recoverUpdate(root)).toBe(true)
    expect(await snapshot(root)).toEqual([...release.values()])
  })

  it('can itself be interrupted and replayed again', async () => {
    const root = await fixture()
    expect(await child(root, 'apply', 0)).toBe(73)
    expect(await child(root, 'recover', 1)).toBe(73)
    expect(existsSync(join(root, UPDATE_JOURNAL))).toBe(true)
    expect(await child(root, 'recover')).toBe(0)
    expect(await snapshot(root)).toEqual([...release.values()])
  })

  it('verifies every staged checksum before changing an installed file', async () => {
    const root = await fixture()
    expect(await child(root, 'apply', 0)).toBe(73)
    const pending = await journal(root)
    const original = await snapshot(root)
    const staged = join(root, '.dsh-pad-update-backup', pending.id, 'staged', 'cordis.patch.yml')
    // Keep the size equal: digest verification, not merely the size, catches it.
    await writeFile(staged, '- insert: [bad]')
    await expect(recoverUpdate(root)).rejects.toThrow('checksum mismatch')
    expect(await snapshot(root)).toEqual(original)
    expect(existsSync(join(root, UPDATE_JOURNAL))).toBe(true)
    await writeFile(staged, release.get('cordis.patch.yml')!)
    expect(await recoverUpdate(root)).toBe(true)
    expect(await snapshot(root)).toEqual([...release.values()])
  })

  it('refuses incomplete staging without modifying the installed set or consuming the journal', async () => {
    const root = await fixture()
    expect(await child(root, 'apply', 0, true)).toBe(73)
    const pending = await journal(root)
    await rm(join(root, '.dsh-pad-update-backup', pending.id, 'staged', 'lib/client.js'))
    await expect(recoverUpdate(root)).rejects.toThrow()
    expect(await snapshot(root)).toEqual(UPDATE_FILES.map(original))
    expect(existsSync(join(root, UPDATE_JOURNAL))).toBe(true)
  })

  it.each(['id', 'path', 'files', 'format'])('fails closed on a malformed journal %s', async field => {
    const root = await fixture()
    expect(await child(root, 'apply', 0, true)).toBe(73)
    const pending = await journal(root)
    if (field === 'id') pending.id = '../outside'
    if (field === 'path') pending.files[0]!.path = '../outside.js'
    if (field === 'files') pending.files.pop()
    if (field === 'format') pending.format = 2
    await writeFile(join(root, UPDATE_JOURNAL), JSON.stringify(pending))
    await expect(recoverUpdate(root)).rejects.toThrow('Invalid dsh-pad update journal')
    expect(await snapshot(root)).toEqual(UPDATE_FILES.map(original))
  })

  it('does not publish incomplete downloads or backups', async () => {
    const root = await fixture()
    await expect(replaceUpdateFiles(root, new Map([['lib/index.js', 'partial']]))).rejects.toThrow('Missing update file')
    expect(await snapshot(root)).toEqual(UPDATE_FILES.map(original))
    expect(existsSync(join(root, UPDATE_JOURNAL))).toBe(false)
    // Incomplete directories are retained for diagnosis; none is a journal.
    expect(await readdir(join(root, '.dsh-pad-update-backup'))).toHaveLength(1)
  })

  it('serializes simultaneous recovery processes and releases the lock after a crash', async () => {
    const root = await fixture()
    expect(await child(root, 'apply', 0)).toBe(73)
    const recovering = await worker(root, 'paused-recovery', `
const fs = require('node:fs');
const path = require('node:path');
const original = fs.renameSync;
let paused = false;
fs.renameSync = function(from, to) {
  const result = original(from, to);
  if (!paused && to === path.join(__dirname, 'lib/index.js')) {
    paused = true;
    fs.writeFileSync(path.join(__dirname, 'recovery-has-lock'), 'locked');
    while (!fs.existsSync(path.join(__dirname, 'release-recovery'))) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  return result;
};
require('./update-helper.cjs').recoverUpdate(__dirname).catch(error => { console.error(error); process.exitCode = 1; });
`)
    let competitor: Awaited<ReturnType<typeof worker>> | undefined
    try {
      await untilFile(join(root, 'recovery-has-lock'))
      competitor = await worker(root, 'second-recovery', `
const fs = require('node:fs');
const path = require('node:path');
const result = require('./update-helper.cjs').recoverUpdate(__dirname);
fs.writeFileSync(path.join(__dirname, 'competitor-started'), 'started');
result.then(value => fs.writeFileSync(path.join(__dirname, 'competitor-result'), String(value))).catch(error => { console.error(error); process.exitCode = 1; });
`)
      await untilFile(join(root, 'competitor-started'))
      await delay(50)
      expect(existsSync(join(root, 'competitor-result'))).toBe(false)
      await writeFile(join(root, 'release-recovery'), 'continue')
      expect(await recovering.done()).toBe(0)
      expect(await competitor.done()).toBe(0)
      expect(await readFile(join(root, 'competitor-result'), 'utf8')).toBe('false')
      expect(await snapshot(root)).toEqual([...release.values()])
    } finally {
      recovering.process.kill()
      competitor?.process.kill()
    }
  })

  it('does not let an older recovery erase a later update journal', async () => {
    const root = await fixture()
    expect(await child(root, 'apply', 0)).toBe(73)
    const nextRelease = new Map([...release].map(([file, content]) => [file, file === 'package.json' ? JSON.stringify({ name: 'dsh-pad', version: '0.3.0', type: 'module' }) : content + '\\n// next']))
    const recovering = await worker(root, 'first-recovery', `
const fs = require('node:fs');
const path = require('node:path');
const original = fs.unlinkSync;
fs.unlinkSync = function(target) {
  if (target === path.join(__dirname, ${JSON.stringify(UPDATE_JOURNAL)})) {
    fs.writeFileSync(path.join(__dirname, 'before-journal-remove'), 'ready');
    while (!fs.existsSync(path.join(__dirname, 'finish-first-recovery'))) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  return original(target);
};
require('./update-helper.cjs').recoverUpdate(__dirname).catch(error => { console.error(error); process.exitCode = 1; });
`)
    let updating: Awaited<ReturnType<typeof worker>> | undefined
    try {
      await untilFile(join(root, 'before-journal-remove'))
      updating = await worker(root, 'next-update', `
const fs = require('node:fs');
const path = require('node:path');
const original = fs.renameSync;
fs.renameSync = function(from, to) {
  const result = original(from, to);
  if (to === path.join(__dirname, 'lib/index.js')) process.exit(73);
  return result;
};
const result = require('./update-helper.cjs').replaceUpdateFiles(__dirname, new Map(${JSON.stringify([...nextRelease])}));
fs.writeFileSync(path.join(__dirname, 'next-update-started'), 'started');
result.catch(error => { console.error(error); process.exitCode = 1; });
`)
      await untilFile(join(root, 'next-update-started'))
      await writeFile(join(root, 'finish-first-recovery'), 'continue')
      expect(await recovering.done()).toBe(0)
      expect(await updating.done()).toBe(73)
      expect(existsSync(join(root, UPDATE_JOURNAL))).toBe(true)
      expect(await recoverUpdate(root)).toBe(true)
      expect(await snapshot(root)).toEqual([...nextRelease.values()])
    } finally {
      recovering.process.kill()
      updating?.process.kill()
    }
  })

  it('preserves a pending journal and all staging when a later update is attempted', async () => {
    const root = await fixture()
    expect(await child(root, 'apply', 1)).toBe(73)
    const pending = await readFile(join(root, UPDATE_JOURNAL), 'utf8')
    const mixed = await snapshot(root)
    await expect(replaceUpdateFiles(root, release)).rejects.toThrow('must be recovered')
    expect(await readFile(join(root, UPDATE_JOURNAL), 'utf8')).toBe(pending)
    expect(await snapshot(root)).toEqual(mixed)
    expect(await recoverUpdate(root)).toBe(true)
  })
})
