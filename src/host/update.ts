/**
 * Self-update for the plugin itself: check the GitHub release feed, then let the
 * dock download the release's built `lib/` when the user clicks Update. Nothing
 * is replaced until that click, and a source checkout (`.git/`) is never
 * overwritten: it keeps its normal `git pull && npm run build` workflow.
 */
import { existsSync } from 'node:fs'
import { copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { PadUpdateInfo, PadUpdateResponse } from '../shared/types.ts'

const REPO = 'ChisaAlter/dsh-pad'
const RELEASE_API = `https://api.github.com/repos/${REPO}/releases/latest`
const RAW_ROOT = `https://raw.githubusercontent.com/${REPO}`
const REQUEST_TIMEOUT_MS = 15_000
const FIRST_CHECK_DELAY_MS = 7_000
const UPDATE_FILES = ['lib/index.js', 'lib/client.js', 'package.json', 'cordis.patch.yml'] as const

interface ReleasePayload {
  readonly tag_name?: unknown
  readonly html_url?: unknown
  readonly body?: unknown
}

interface ParsedVersion {
  readonly parts: readonly [number, number, number]
  readonly pre?: string
}

function parseVersion(value: string): ParsedVersion | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(value.trim())
  if (match === null) return undefined
  return {
    parts: [Number(match[1]), Number(match[2]), Number(match[3])],
    ...(match[4] === undefined ? {} : { pre: match[4] }),
  }
}

/** Semver ordering for the release tags this plugin uses; 0 for equal, NaN-ish input sorts as equal. */
export function compareVersions(left: string, right: string): number {
  const a = parseVersion(left)
  const b = parseVersion(right)
  if (a === undefined || b === undefined) return 0
  for (let index = 0; index < 3; index += 1) {
    const delta = (a.parts[index] ?? 0) - (b.parts[index] ?? 0)
    if (delta !== 0) return delta
  }
  if (a.pre === b.pre) return 0
  if (a.pre === undefined) return 1
  if (b.pre === undefined) return -1
  return a.pre < b.pre ? -1 : 1
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
    if (!this.enabled || this.applied !== undefined) return this.state
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
    const headers: Record<string, string> = {
      accept: 'application/vnd.github+json',
      'user-agent': `dsh-pad/${this.current}`,
    }
    const token = process.env['GITHUB_TOKEN']
    if (token !== undefined && token.trim() !== '') headers['authorization'] = `Bearer ${token.trim()}`
    try {
      const response = await this.fetchImpl(RELEASE_API, {
        headers,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      if (!response.ok) throw new Error(`GitHub ${response.status}`)
      const release = await response.json() as ReleasePayload
      const tag = typeof release.tag_name === 'string' ? release.tag_name : ''
      const latest = tag.replace(/^v/i, '')
      const url = typeof release.html_url === 'string' ? release.html_url : `https://github.com/${REPO}/releases`
      const notes = typeof release.body === 'string' ? release.body.slice(0, 2000) : undefined
      const available = latest !== '' && compareVersions(latest, this.current) > 0
      this.tag = tag
      this.state = {
        current: this.current,
        latest: latest === '' ? undefined : latest,
        available,
        canApply: available && !this.source,
        reason: available ? (this.source ? 'source' : 'available') : 'up-to-date',
        url,
        ...(notes === undefined ? {} : { notes }),
        checkedAt: new Date().toISOString(),
      }
    } catch (error) {
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
    const latest = this.state.latest
    if (!this.state.available || latest === undefined || this.tag === undefined) {
      return { ok: false, update: this.state, error: this.state.reason === 'source' ? 'source' : 'no-update' }
    }
    if (this.source) {
      return { ok: false, update: this.state, error: 'source' }
    }

    const contents = new Map<string, string>()
    try {
      const fetched = await Promise.all(UPDATE_FILES.map(async file => {
        const response = await this.fetchImpl(`${RAW_ROOT}/${encodeURIComponent(this.tag ?? '')}/${file}`, {
          headers: { 'user-agent': `dsh-pad/${this.current}` },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        })
        if (!response.ok) throw new Error(`${file}: GitHub ${response.status}`)
        return [file, await response.text()] as const
      }))
      for (const [file, content] of fetched) contents.set(file, content)
    } catch (error) {
      return this.fail(`下载失败：${error instanceof Error ? error.message : String(error)}`)
    }

    try {
      const manifest = JSON.parse(contents.get('package.json') ?? '') as { name?: unknown, version?: unknown }
      if (manifest.name !== 'dsh-pad' || manifest.version !== latest) {
        throw new Error('release manifest does not match dsh-pad@' + latest)
      }
      if ((contents.get('lib/index.js') ?? '').length < 1000 || (contents.get('lib/client.js') ?? '').length < 1000) {
        throw new Error('release bundles are incomplete')
      }
    } catch (error) {
      return this.fail(`校验失败：${error instanceof Error ? error.message : String(error)}`)
    }

    const backup = join(this.root, '.dsh-pad-update-backup', new Date().toISOString().replace(/[:.]/g, '-'))
    try {
      await mkdir(backup, { recursive: true })
      for (const file of UPDATE_FILES) {
        const target = join(this.root, file)
        if (existsSync(target)) {
          await mkdir(dirname(join(backup, file)), { recursive: true })
          await copyFile(target, join(backup, file))
        }
      }
      for (const file of UPDATE_FILES) {
        const content = contents.get(file)
        if (content === undefined) continue
        const target = join(this.root, file)
        await mkdir(dirname(target), { recursive: true })
        const temp = `${target}.update-${process.pid}`
        await writeFile(temp, content, 'utf8')
        try {
          await rename(temp, target)
        } catch {
          await rm(target, { force: true })
          await rename(temp, target)
        }
      }
    } catch (error) {
      await this.restore(backup)
      return this.fail(`写入失败：${error instanceof Error ? error.message : String(error)}`)
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

  private async restore(backup: string): Promise<void> {
    for (const file of UPDATE_FILES) {
      const saved = join(backup, file)
      const target = join(this.root, file)
      try {
        if (existsSync(saved)) await copyFile(saved, target)
        else await rm(target, { force: true })
      } catch {
        // Keep trying the remaining files; the update route reports the first error.
      }
    }
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
