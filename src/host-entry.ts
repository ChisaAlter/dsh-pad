/** Recover a complete release before resolving any platform dependency. */
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { verifyHostBundle } from './host/bundle-integrity.ts'
import { withRecoveredUpdate } from './host/update-transaction.ts'

declare const __DSH_PAD_HOST_BODY__: string

type HostPluginModule = typeof import('./index.ts') & {
  readonly registerTools?: typeof import('./host/tools.ts').registerTools
}

const entryUrl = new URL(import.meta.url)
const alreadyRecovered = entryUrl.searchParams.has('recovered')
entryUrl.search = ''
entryUrl.hash = ''
const root = fileURLToPath(new URL('../', entryUrl))
const __dshPadHostBody = __DSH_PAD_HOST_BODY__
const body = __dshPadHostBody
// Hold recovery, identity verification and body evaluation together.
const loaded = await withRecoveredUpdate(root, recovered => {
  const disk = readFileSync(entryUrl, 'utf8')
  const markers = verifyHostBundle(disk)
  // A different process may have consumed the journal after this file was read.
  const bodyDigest = createHash('sha256').update(body).digest('hex')
  if (recovered || markers.bodyDigest !== bodyDigest) {
    if (alreadyRecovered) {
      throw new Error('宿主 bundle 重载后仍与磁盘版本不一致，已中止以避免无限递归')
    }
    return undefined
  }
  return evaluateBody()
})
// Release the mutex before self-importing: the new entry acquires it afresh.
const plugin: HostPluginModule = loaded
  ?? await import(`${entryUrl.href}?recovered=${randomUUID()}`) as HostPluginModule

function evaluateBody(): HostPluginModule {
  const module = { exports: {} }
  // Resolve platform peers relative to the installed plugin after recovery.
  // The platform packages support Node 22 require(ESM).
  const run = new Function('require', 'module', 'exports', '__dshPadModuleUrl', body)
  run(createRequire(entryUrl), module, module.exports, entryUrl.href)
  return module.exports as HostPluginModule
}

export const name = plugin.name
export const inject = plugin.inject
export const Config = plugin.Config
export const apply = plugin.apply
export const registerTools = plugin.registerTools
