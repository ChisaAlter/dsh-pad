/**
 * Self-update for the plugin itself: check the GitHub release feed, then let the
 * dock download the release's built `lib/` when the user clicks Update. Nothing
 * is replaced until that click, and a source checkout (`.git/`) is never
 * overwritten: it keeps its normal `git pull && npm run build` workflow.
 */
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { PadUpdateInfo, PadUpdateResponse } from '../shared/types.ts'
import { verifyHostBundle } from './bundle-integrity.ts'
import { replaceUpdateFiles, UPDATE_FILES, UPDATE_JOURNAL } from './update-transaction.ts'

const REPO = 'ChisaAlter/dsh-pad'
const RELEASE_FEED = `https://github.com/${REPO}/releases.atom`
const RELEASE_TAG_PREFIX = `https://github.com/${REPO}/releases/tag/`
const RELEASES_URL = `https://github.com/${REPO}/releases`
const RAW_ROOT = `https://raw.githubusercontent.com/${REPO}`
const REQUEST_TIMEOUT_MS = 15_000
const FIRST_CHECK_DELAY_MS = 7_000
const MAX_FEED_BYTES = 1024 * 1024
export const MAX_UPDATE_FILE_BYTES = 2 * 1024 * 1024

const ESCAPED_REPO = REPO.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const RELEASE_TAG_HREF = new RegExp(`^https:\\/\\/github\\.com\\/${ESCAPED_REPO}\\/releases\\/tag\\/([^"'\\s/#?]+)$`)
const ATOM_ENTRY = /<entry\b[^>]*>([\s\S]*?)<\/entry>/gi
const ATOM_LINK = /<link\b[^>]*>/gi
const LINK_HREF = /\bhref=(?:"([^"]*)"|'([^']*)')/i
const CLIENT_FOOTER = /return module\.exports; \} \}\);(?:\r?\n\/\/# sourceMappingURL=[^\r\n]+)?\s*$/

interface ParsedVersion {
  readonly parts: readonly string[]
  readonly pre?: readonly string[]
}

export interface StableRelease {
  readonly tag: string
  readonly version: string
  readonly url: string
}

function parseVersion(value: string): ParsedVersion | undefined {
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/i.exec(value.trim())
  if (match === null) return undefined
  const pre = match[4]?.split('.')
  if (pre?.some(part => /^\d+$/.test(part) && part.length > 1 && part[0] === '0')) return undefined
  return { parts: [match[1]!, match[2]!, match[3]!], pre }
}

/**
 * Extract the highest stable SemVer release from the GitHub Atom feed.
 * Only links under `https://github.com/${REPO}/releases/tag/<tag>` are accepted;
 * prereleases and malformed/encoded traversal tags are skipped, and the returned
 * URL is always rebuilt from the allowlisted prefix + encoded tag.
 */
export function parseLatestStableRelease(xml: string): StableRelease | undefined {
  let best: StableRelease | undefined
  for (const entryMatch of xml.matchAll(ATOM_ENTRY)) {
    const entry = entryMatch[1] ?? ''
    for (const linkMatch of entry.matchAll(ATOM_LINK)) {
      const hrefMatch = LINK_HREF.exec(linkMatch[0])
      const href = hrefMatch?.[1] ?? hrefMatch?.[2]
      if (href === undefined) continue
      const tagMatch = RELEASE_TAG_HREF.exec(href.trim())
      if (tagMatch === null) continue
      let tag: string
      try {
        tag = decodeURIComponent(tagMatch[1]!)
      } catch {
        continue
      }
      if (tag === '' || /[/\\\s\u0000-\u001f\u007f]/.test(tag) || tag.includes('..')) continue
      const parsed = parseVersion(tag)
      if (parsed === undefined || parsed.pre !== undefined) continue
      const version = tag.replace(/^v/i, '')
      if (best === undefined || compareVersions(version, best.version) > 0) {
        best = {
          tag,
          version,
          url: `${RELEASE_TAG_PREFIX}${encodeURIComponent(tag)}`,
        }
      }
    }
  }
  return best
}

async function readLimitedText(response: Response, maxBytes: number, label: string): Promise<string> {
  const declared = response.headers.get('content-length')
  if (declared !== null) {
    const length = Number(declared)
    if (Number.isFinite(length) && length > maxBytes) {
      await response.body?.cancel().catch(() => {})
      throw new Error(`${label}: 响应体积超过上限（${Math.round(maxBytes / 1024)} KB）`)
    }
  }
  const reader = response.body?.getReader()
  if (reader !== undefined) {
    const chunks: Uint8Array[] = []
    let total = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        total += value.byteLength
        if (total > maxBytes) {
          await reader.cancel().catch(() => {})
          throw new Error(`${label}: 响应体积超过上限（${Math.round(maxBytes / 1024)} KB）`)
        }
        chunks.push(value)
      }
    } finally {
      reader.releaseLock()
    }
    return Buffer.concat(chunks).toString('utf8')
  }
  const text = await response.text()
  if (Buffer.byteLength(text, 'utf8') > maxBytes) {
    throw new Error(`${label}: 响应体积超过上限（${Math.round(maxBytes / 1024)} KB）`)
  }
  return text
}

function isRelativePath(value: unknown, expected: string): boolean {
  return value === expected || value === `./${expected}`
}

function validateReleaseFiles(contents: ReadonlyMap<string, string>, latest: string): void {
  const manifest = JSON.parse(contents.get('package.json') ?? '') as {
    name?: unknown
    version?: unknown
    main?: unknown
    exports?: Record<string, unknown>
    dsh?: { bundle?: { patch?: unknown } }
  }
  if (manifest === null || typeof manifest !== 'object' || manifest.name !== 'dsh-pad' || manifest.version !== latest) {
    throw new Error('release manifest does not match dsh-pad@' + latest)
  }
  if (!isRelativePath(manifest.main, 'lib/index.js')) {
    throw new Error('release manifest main must point to lib/index.js')
  }
  if (!isRelativePath(manifest.exports?.['./client'], 'lib/client.js')) {
    throw new Error('release manifest exports["./client"] must point to lib/client.js')
  }
  if (!isRelativePath(manifest.dsh?.bundle?.patch, 'cordis.patch.yml')) {
    throw new Error('release manifest dsh.bundle.patch must point to cordis.patch.yml')
  }

  const hostBundle = contents.get('lib/index.js') ?? ''
  const clientBundle = contents.get('lib/client.js') ?? ''
  if (hostBundle.length < 1000 || clientBundle.length < 1000) {
    throw new Error('release bundles are incomplete')
  }
  // The loader rejects a bundle without valid EOF-anchored markers; refuse to
  // journal one that would leave the plugin unloadable after restart.
  verifyHostBundle(hostBundle)

  if (!clientBundle.trimStart().startsWith('window.__ModuleLoader__.load(') || !CLIENT_FOOTER.test(clientBundle)) {
    throw new Error('client bundle closure is incomplete or invalid')
  }

  const patch = contents.get('cordis.patch.yml') ?? ''
  if (
    patch.trim() === '' ||
    !/^\s*-\s+insert\s*:/m.test(patch) ||
    !/^\s*(?:-\s+)?id\s*:\s*["']?dsh-pad["']?\s*$/m.test(patch) ||
    !/^\s*(?:-\s+)?name\s*:\s*["']?dsh-pad["']?\s*$/m.test(patch)
  ) {
    throw new Error('cordis.patch.yml is missing a valid dsh-pad entry')
  }
}

/** Compare decimal identifiers without losing precision for long numeric tags. */
function compareNumeric(left: string, right: string): number {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1
  return left === right ? 0 : left < right ? -1 : 1
}

/** SemVer precedence (build metadata is ignored); invalid input sorts as equal. */
export function compareVersions(left: string, right: string): number {
  const a = parseVersion(left)
  const b = parseVersion(right)
  if (a === undefined || b === undefined) return 0
  for (let index = 0; index < 3; index += 1) {
    const delta = compareNumeric(a.parts[index]!, b.parts[index]!)
    if (delta !== 0) return delta
  }
  if (a.pre === undefined && b.pre === undefined) return 0
  if (a.pre === undefined) return 1
  if (b.pre === undefined) return -1
  for (let index = 0; index < Math.max(a.pre.length, b.pre.length); index += 1) {
    const leftPart = a.pre[index]
    const rightPart = b.pre[index]
    if (leftPart === rightPart) continue
    if (leftPart === undefined) return -1
    if (rightPart === undefined) return 1
    const leftNumeric = /^\d+$/.test(leftPart)
    const rightNumeric = /^\d+$/.test(rightPart)
    if (leftNumeric && rightNumeric) return compareNumeric(leftPart, rightPart)
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1
    return leftPart < rightPart ? -1 : 1
  }
  return 0
}

export interface UpdateServiceOptions {
  /** Version of the plugin currently loaded. */
  readonly current: string
  /** Plugin directory (the parent of `lib/`). */
  readonly root: string
  /** Whether the automatic release check runs. */
  readonly enabled: boolean
  /** Hours between automatic checks. */
  readonly checkHours: number
  /** Test seam. */
  readonly fetchImpl?: typeof fetch
}

/**
 * Owns the update status shown by the dock and the explicit apply action.
 * Checks are automatic; replacing files is always user initiated.
 */
export class UpdateService {
  private state: PadUpdateInfo
  private readonly current: string
  private readonly root: string
  private readonly enabled: boolean
  private readonly checkHours: number
  private readonly fetchImpl: typeof fetch
  private readonly source: boolean
  private tag: string | undefined
  private applied: string | undefined
  private checking: Promise<PadUpdateInfo> | undefined
  private applying: Promise<PadUpdateResponse> | undefined
  private firstTimer: ReturnType<typeof setTimeout> | undefined
  private interval: ReturnType<typeof setInterval> | undefined

  constructor(options: UpdateServiceOptions) {
    this.current = options.current
    this.root = options.root
    this.enabled = options.enabled
    this.checkHours = Math.max(1, options.checkHours)
    this.fetchImpl = options.fetchImpl ?? fetch
    this.source = existsSync(join(this.root, '.git'))
    this.state = {
      current: this.current,
      available: false,
      canApply: false,
      reason: this.enabled ? 'unchecked' : 'disabled',
    }
    this.pendingRecovery()
  }

  start(): void {
    if (!this.enabled || this.firstTimer !== undefined) return
    this.firstTimer = setTimeout(() => {
      void this.check()
    }, FIRST_CHECK_DELAY_MS)
    this.firstTimer.unref?.()
    this.interval = setInterval(() => {
      void this.check(true)
    }, this.checkHours * 60 * 60 * 1000)
    this.interval.unref?.()
  }

  dispose(): void {
    if (this.firstTimer !== undefined) clearTimeout(this.firstTimer)
    if (this.interval !== undefined) clearInterval(this.interval)
    this.firstTimer = undefined
    this.interval = undefined
  }

  info(): PadUpdateInfo {
    return this.state
  }

  /** Cached info, or a check the first time the dock asks. */
  async ensure(): Promise<PadUpdateInfo> {
    if (!this.enabled || this.applied !== undefined || this.state.checkedAt !== undefined) return this.state
    return this.check()
  }

  async check(force = false): Promise<PadUpdateInfo> {
    if (this.pendingRecovery() || !this.enabled || this.applied !== undefined) return this.state
    if (this.checking !== undefined) return this.checking
    if (!force && this.state.checkedAt !== undefined && Date.now() - Date.parse(this.state.checkedAt) < this.checkHours * 60 * 60 * 1000) {
      return this.state
    }
    this.checking = this.fetchLatest().finally(() => {
      this.checking = undefined
    })
    return this.checking
  }

  private async fetchLatest(): Promise<PadUpdateInfo> {
    try {
      const response = await this.fetchImpl(RELEASE_FEED, {
        headers: {
          accept: 'application/atom+xml',
          'user-agent': `dsh-pad/${this.current}`,
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      if (!response.ok) throw new Error(`GitHub ${response.status}`)
      const xml = await readLimitedText(response, MAX_FEED_BYTES, 'releases.atom')
      // A check that started before apply must not replace its committed or
      // pending-recovery status when the delayed feed finally settles.
      if (this.applied !== undefined || this.state.requiresRestart || this.pendingRecovery()) return this.state
      const release = parseLatestStableRelease(xml)
      const tag = release?.tag
      const url = release?.url ?? RELEASES_URL
      const latest = release?.version
      const available = latest !== undefined && compareVersions(latest, this.current) > 0
      this.tag = tag
      this.state = {
        current: this.current,
        latest,
        available,
        canApply: available && !this.source,
        reason: available ? (this.source ? 'source' : 'available') : 'up-to-date',
        url,
        checkedAt: new Date().toISOString(),
      }
      this.pendingRecovery()
    } catch (error) {
      if (this.applied !== undefined || this.state.requiresRestart || this.pendingRecovery()) return this.state
      this.state = {
        ...this.state,
        available: false,
        canApply: false,
        reason: 'error',
        checkedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error),
      }
    }
    return this.state
  }

  /** Download the release's built files and replace this plugin in place. */
  async apply(): Promise<PadUpdateResponse> {
    if (this.applying !== undefined) return this.applying
    if (this.applied !== undefined) return { ok: true, update: this.state }
    this.applying = this.replaceFiles().finally(() => {
      this.applying = undefined
    })
    return this.applying
  }

  private async replaceFiles(): Promise<PadUpdateResponse> {
    if (this.pendingRecovery()) return { ok: false, update: this.state, error: this.state.error }
    const latest = this.state.latest
    const tag = this.tag
    if (!this.state.available || latest === undefined || tag === undefined) {
      return { ok: false, update: this.state, error: this.state.reason === 'source' ? 'source' : 'no-update' }
    }
    if (this.source) {
      return { ok: false, update: this.state, error: 'source' }
    }

    const contents = new Map<string, string>()
    try {
      const fetched = await Promise.all(UPDATE_FILES.map(async file => {
        const response = await this.fetchImpl(`${RAW_ROOT}/${encodeURIComponent(tag)}/${file}`, {
          headers: { 'user-agent': `dsh-pad/${this.current}` },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        })
        if (!response.ok) throw new Error(`${file}: GitHub ${response.status}`)
        return [file, await readLimitedText(response, MAX_UPDATE_FILE_BYTES, file)] as const
      }))
      for (const [file, content] of fetched) contents.set(file, content)
    } catch (error) {
      return this.fail(`下载失败：${error instanceof Error ? error.message : String(error)}`)
    }

    try {
      validateReleaseFiles(contents, latest)
    } catch (error) {
      return this.fail(`校验失败：${error instanceof Error ? error.message : String(error)}`)
    }

    try {
      await replaceUpdateFiles(this.root, contents)
    } catch (error) {
      const pending = existsSync(join(this.root, UPDATE_JOURNAL))
      if (pending) {
        this.state = { ...this.state, canApply: false, reason: 'error', requiresRestart: true }
      }
      const detail = error instanceof Error ? error.message : String(error)
      return this.fail(pending
        ? `更新未完成，请重启以恢复完整更新：${detail}`
        : `准备更新失败（原文件未改动）：${detail}`)
    }

    this.applied = latest
    this.state = {
      ...this.state,
      available: false,
      canApply: false,
      reason: 'applied',
      applied: latest,
      requiresRestart: true,
      error: undefined,
    }
    return { ok: true, update: this.state }
  }

  private pendingRecovery(): boolean {
    if (!existsSync(join(this.root, UPDATE_JOURNAL))) return false
    this.state = {
      ...this.state, available: false, canApply: false, reason: 'error', requiresRestart: true,
      error: '更新未完成，请重启以恢复完整更新',
    }
    return true
  }

  private fail(error: string): PadUpdateResponse {
    this.state = { ...this.state, error }
    return { ok: false, update: this.state, error }
  }
}

/** Read the version of the plugin at `root`; falls back when the manifest is unreadable. */
export async function readPluginVersion(root: string): Promise<string> {
  try {
    const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { version?: unknown }
    return typeof manifest.version === 'string' ? manifest.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
}
