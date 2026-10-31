import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { replaceUpdateFiles, UPDATE_FILES, UPDATE_JOURNAL } from '../src/host/update-transaction.ts'

// Exercise the exact two-stage production build, including dependency linking.
// @ts-expect-error Build scripts intentionally stay standalone JavaScript.
import { buildHost } from '../scripts/host-build.mjs'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function entry(version: string, beforeBody = ''): Promise<string> {
  const result = await buildHost({
    write: false,
    bodySource: `${beforeBody}\nglobalThis.__padBodies.push(${JSON.stringify(version)});export const name=${JSON.stringify(version)};export const inject=[];export const Config={};export function apply(){}`,
  })
  return result.outputFiles.find((file: { path: string }) => file.path.endsWith('index.js')).text
}

async function setup(oldPrefix = '', nextPrefix = '') {
  const root = await mkdtemp(join(tmpdir(), 'dsh-pad-entry-'))
  roots.push(root)
  await mkdir(join(root, 'lib'))
  const old = await entry('old', oldPrefix)
  const latest = await entry('new', nextPrefix)
  const contents = new Map([
    ['lib/index.js', latest], ['lib/client.js', 'new client'],
    ['package.json', JSON.stringify({ name: 'dsh-pad', version: '0.4.6', type: 'module' })],
    ['cordis.patch.yml', 'new patch'],
  ])
  await writeFile(join(root, 'lib/index.js'), old)
  await writeFile(join(root, 'lib/client.js'), 'old client')
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'dsh-pad', version: '0.4.5', type: 'module' }))
  await writeFile(join(root, 'cordis.patch.yml'), 'old patch')
  return { root, contents, old }
}

function load(root: string, expressionPrefix = ''): string {
  const expression = `globalThis.__padBodies=[];${expressionPrefix};const m=await import(${JSON.stringify(pathToFileURL(join(root, 'lib/index.js')).href)});console.log(JSON.stringify({name:m.name,bodies:globalThis.__padBodies}));`
  return execFileSync(process.execPath, ['--input-type=module', '--eval', expression], { encoding: 'utf8' }).trim()
}

async function pending(root: string, contents: Map<string, string>, blockedFile = 'lib/index.js') {
  const blocker = `${join(root, blockedFile)}.update-${process.pid}`
  await mkdir(blocker)
  await expect(replaceUpdateFiles(root, contents)).rejects.toThrow()
  await expect(readFile(join(root, UPDATE_JOURNAL), 'utf8')).resolves.toBeTruthy()
  await rm(blocker, { recursive: true })
}

describe('shipped Host entry recovery', () => {
  it.each(['lib/index.js', 'lib/client.js'])('recovers before evaluating a body when replacement stops at %s', async (blockedFile) => {
    const { root, contents } = await setup()
    await pending(root, contents, blockedFile)
    expect(JSON.parse(load(root))).toEqual({ name: 'new', bodies: ['new'] })
    for (const file of UPDATE_FILES) expect(await readFile(join(root, file), 'utf8')).toBe(contents.get(file))
    await expect(readFile(join(root, UPDATE_JOURNAL))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('recovers before resolving an unavailable platform dependency from the obsolete body', async () => {
    const { root, contents } = await setup('import { removed } from "@deepseek-ai/audit-missing-package";globalThis.__missingExport=removed;')
    await pending(root, contents)
    expect(JSON.parse(load(root))).toEqual({ name: 'new', bodies: ['new'] })
  })

  it('detects another process consuming the journal after this entry was read', async () => {
    const { root, contents, old } = await setup()
    // An already-linked bootstrap can be obsolete even when no journal remains.
    // Import a copy with the old body while the canonical disk entry is newer.
    await replaceUpdateFiles(root, contents)
    const oldUrl = pathToFileURL(join(root, 'lib/index.js')).href + '?stale'
    const { createHash } = await import('node:crypto')
    expect(old).toContain('var entryUrl = new URL(import.meta.url);')
    const diskModule = old.replace('var entryUrl = new URL(import.meta.url);', `var entryUrl = new URL(${JSON.stringify(oldUrl)});`)
    const withoutMarker = diskModule.replace(/\n\/\/ dsh-pad-build:[a-f0-9]{64}\n?$/, '')
    // The stale copy's marker is irrelevant: it verifies the canonical entry.
    const stale = withoutMarker + '\n// dsh-pad-build:' + createHash('sha256').update(withoutMarker).digest('hex') + '\n'
    await writeFile(join(root, 'stale.mjs'), stale)
    const expression = `globalThis.__padBodies=[];const m=await import(${JSON.stringify(pathToFileURL(join(root, 'stale.mjs')).href)});console.log(JSON.stringify({name:m.name,bodies:globalThis.__padBodies}))`
    expect(JSON.parse(execFileSync(process.execPath, ['--input-type=module', '--eval', expression], { encoding: 'utf8' }))).toEqual({ name: 'new', bodies: ['new'] })
  })

  it('fails closed without evaluating a body when staged files are corrupt', async () => {
    const { root, contents } = await setup()
    await pending(root, contents)
    const journal = JSON.parse(await readFile(join(root, UPDATE_JOURNAL), 'utf8'))
    await writeFile(join(root, '.dsh-pad-update-backup', journal.id, 'staged', 'lib/client.js'), 'corrupt')
    const expression = `globalThis.__padBodies=[];try{await import(${JSON.stringify(pathToFileURL(join(root, 'lib/index.js')).href)});process.exitCode=2}catch(error){console.log(JSON.stringify({error:error.message,bodies:globalThis.__padBodies}))}`
    const result = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '--eval', expression], { encoding: 'utf8' }))
    expect(result.bodies).toEqual([])
    expect(result.error).toMatch(/checksum|staged/i)
    expect(await readFile(join(root, 'lib/client.js'), 'utf8')).toBe('old client')
  })
})
