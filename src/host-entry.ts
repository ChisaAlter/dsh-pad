/** Recover a complete release before resolving any platform dependency. */
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { withRecoveredUpdate } from './host/update-transaction.ts'

declare const __DSH_PAD_HOST_BODY__: string

const entryUrl = new URL(import.meta.url)
entryUrl.search = ''
entryUrl.hash = ''
const root = fileURLToPath(new URL('../', entryUrl))
const body = __DSH_PAD_HOST_BODY__
// Hold the same kernel mutex through recovery, identity verification and body
// evaluation. Another updater cannot replace half the release in this window.
const loaded = await withRecoveredUpdate(root, recovered => {
  const disk = readFileSync(entryUrl, 'utf8')
  const marker = /\n\/\/ dsh-pad-build:([a-f0-9]{64})\n?$/.exec(disk)
  if (marker === null || createHash('sha256').update(disk.slice(0, marker.index)).digest('hex') !== marker[1]) {
    throw new Error('dsh-pad Host bundle is incomplete or corrupt; reinstall the complete release')
  }
  // A different process may have consumed the journal after this file was read.
  const bodyDigest = createHash('sha256').update(body).digest('hex')
  const diskBodyDigest = /\/\/ dsh-pad-body:([a-f0-9]{64})\n/.exec(disk)?.[1]
  return recovered || diskBodyDigest !== bodyDigest ? undefined : evaluateBody()
})
// Release the mutex before self-importing: the new entry acquires it afresh.
const plugin: typeof import('./index.ts') = loaded
  ?? await import(`${entryUrl.href}?recovered=${randomUUID()}`)

function evaluateBody(): typeof import('./index.ts') {
  const module = { exports: {} }
  // Resolve platform peers relative to the installed plugin after recovery.
  // The platform packages support Node 22 require(ESM).
  const run = new Function('require', 'module', 'exports', '__dshPadModuleUrl', body)
  run(createRequire(entryUrl), module, module.exports, entryUrl.href)
  return module.exports as typeof import('./index.ts')
}

export const name = plugin.name
export const inject = plugin.inject
export const Config = plugin.Config
export const apply = plugin.apply
