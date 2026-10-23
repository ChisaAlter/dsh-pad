/**
 * Reading cache: the newest readings of every direct source, kept on disk next
 * to the panel file so a restarted dsh can paint panels — and their trends —
 * before the first poll comes back.
 *
 * This is a cache, never a record: the Hub owns the live readings, and a cache
 * write failing must not disturb polling. Each source keeps a short ring of its
 * last points (`HISTORY_POINTS`), so `dsh.history()` has a trend right away.
 * Writes are throttled (one file write per window, coalescing every source of
 * every panel), values over `MAX_CACHED_VALUE_CHARS` are not cached at all, and
 * an entry is only used again while the source it belongs to is unchanged — its
 * fingerprint is stored with the reading.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { Json, PanelRecord, ReadingPoint, SourceReading } from '../shared/types.ts'
import { sourcesFingerprint } from './store.ts'

/** One cached ring plus the fingerprint of the source that produced it. */
interface CacheEntry {
  readonly key: string
  /** Oldest first; the last point is the newest reading. */
  readonly points: readonly SourceReading[]
}

interface CacheFile {
  readonly version: 2
  readonly panels: Record<string, Record<string, CacheEntry>>
}

/** Longest JSON value that is worth writing to disk; bigger readings just wait for the first poll. */
export const MAX_CACHED_VALUE_CHARS = 16_384
/** Points kept per source, matching what a trend chart needs at a glance. */
export const HISTORY_POINTS = 20
/** Upper bound for one source's ring, so a chatty panel cannot bloat the file. */
export const MAX_CACHED_HISTORY_CHARS = 128 * 1024
/** Default coalescing window for cache writes. */
export const DEFAULT_FLUSH_MS = 10_000

function toReading(raw: unknown): SourceReading | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const record = raw as Record<string, unknown>
  const { ok, value, error, at, durationMs } = record
  if (ok !== true || typeof at !== 'string' || Number.isNaN(Date.parse(at))) return undefined
  if (value === undefined) return undefined
  return {
    ok: true,
    value: value as Json,
    at,
    ...(typeof durationMs === 'number' && Number.isFinite(durationMs) ? { durationMs } : {}),
    ...(typeof error === 'string' ? { error } : {}),
  }
}

function valueSize(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

/** The ring a source should have after one more reading, oldest first. */
function nextRing(previous: CacheEntry | undefined, key: string, reading: SourceReading): CacheEntry {
  const points = previous?.key === key ? [...previous.points] : []
  const last = points[points.length - 1]
  // Two readings of the same instant: the newer one wins, no extra point.
  if (last !== undefined && last.at === reading.at) points[points.length - 1] = reading
  else points.push(reading)
  while (points.length > HISTORY_POINTS) points.shift()
  // A panel whose single reading is huge still keeps a usable trend.
  while (points.length > 1 && valueSize(points) > MAX_CACHED_HISTORY_CHARS) points.shift()
  return { key, points }
}

export class ReadingCache {
  private panels = new Map<string, Map<string, CacheEntry>>()
  private timer: ReturnType<typeof setTimeout> | undefined
  private dirty = false
  private disposed = false
  private writing: Promise<void> = Promise.resolve()

  /**
   * @param file - cache file path, usually next to `panels.json`.
   * @param flushMs - coalescing window for writes.
   */
  constructor(private readonly file: string, private readonly flushMs = DEFAULT_FLUSH_MS) {}

  /**
   * Read the cache back for the panels that are still declared.
   * @param panels - panels loaded from the store.
   * @returns the newest reading per panel id and source id, ready to seed a `DataHub`.
   */
  async load(panels: readonly PanelRecord[]): Promise<Map<string, Map<string, SourceReading>>> {
    const newest = new Map<string, Map<string, SourceReading>>()
    let text: string
    try {
      text = await readFile(this.file, 'utf8')
    } catch {
      return newest
    }
    let parsed: CacheFile
    try {
      parsed = JSON.parse(text) as CacheFile
    } catch {
      return newest
    }
    if (parsed === null || typeof parsed !== 'object' || typeof parsed.panels !== 'object' || parsed.panels === null) return newest

    for (const panel of panels) {
      const entries = parsed.panels[panel.id]
      if (typeof entries !== 'object' || entries === null) continue
      for (const source of panel.definition.sources) {
        const entry = (entries as Record<string, unknown>)[source.id]
        if (typeof entry !== 'object' || entry === null) continue
        const { key, points, reading } = entry as Record<string, unknown>
        if (typeof key !== 'string' || key !== sourcesFingerprint([source])) continue
        // Older caches stored a single reading; accept it as a one-point ring.
        const raw = Array.isArray(points) ? points : reading === undefined ? [] : [reading]
        const ring = raw
          .map(toReading)
          .filter((point): point is SourceReading => point !== undefined && valueSize(point.value!) <= MAX_CACHED_VALUE_CHARS)
          .slice(-HISTORY_POINTS)
        if (ring.length === 0) continue
        let cached = this.panels.get(panel.id)
        if (cached === undefined) {
          cached = new Map()
          this.panels.set(panel.id, cached)
        }
        cached.set(source.id, { key, points: ring })
        let sources = newest.get(panel.id)
        if (sources === undefined) {
          sources = new Map()
          newest.set(panel.id, sources)
        }
        sources.set(source.id, ring[ring.length - 1]!)
      }
    }
    return newest
  }

  /** Cache one successful reading; failed and oversized readings are ignored. */
  remember(panelId: string, sourceId: string, key: string, reading: SourceReading): void {
    if (this.disposed || !reading.ok || reading.value === undefined) return
    if (valueSize(reading.value) > MAX_CACHED_VALUE_CHARS) return
    let sources = this.panels.get(panelId)
    if (sources === undefined) {
      sources = new Map()
      this.panels.set(panelId, sources)
    }
    sources.set(sourceId, nextRing(sources.get(sourceId), key, reading))
    this.schedule()
  }

  /**
   * Recent points of every cached source of one panel, oldest first.
   * @param panelId - the panel.
   * @returns points per source id; empty when nothing is cached.
   */
  history(panelId: string): Readonly<Record<string, readonly ReadingPoint[]>> {
    const sources = this.panels.get(panelId)
    if (sources === undefined) return {}
    const history: Record<string, ReadingPoint[]> = {}
    for (const [sourceId, entry] of sources) {
      history[sourceId] = entry.points.map(point => ({ value: point.value as Json, at: point.at }))
    }
    return history
  }

  /** Drop one source's readings (its definition changed). */
  forgetSource(panelId: string, sourceId: string): void {
    if (this.panels.get(panelId)?.delete(sourceId) === true) this.schedule()
  }

  /** Drop a deleted panel. */
  forgetPanel(panelId: string): void {
    if (this.panels.delete(panelId)) this.schedule()
  }

  /** Drop entries whose panel, source or source definition no longer exists. */
  prune(panels: readonly PanelRecord[]): void {
    const current = new Map(panels.map(panel => [panel.id, panel]))
    let changed = false
    for (const [panelId, sources] of this.panels) {
      const panel = current.get(panelId)
      if (panel === undefined) {
        this.panels.delete(panelId)
        changed = true
        continue
      }
      const keys = new Map(panel.definition.sources.map(source => [source.id, sourcesFingerprint([source])]))
      for (const [sourceId, entry] of sources) {
        if (keys.get(sourceId) === entry.key) continue
        sources.delete(sourceId)
        changed = true
      }
      if (sources.size === 0) {
        this.panels.delete(panelId)
        changed = true
      }
    }
    if (changed) this.schedule()
  }

  /** Write now if anything changed; concurrent calls share one write. */
  async flush(): Promise<void> {
    if (!this.dirty) return await this.writing
    this.dirty = false
    const snapshot = JSON.stringify(this.serializable())
    const write = this.writing.then(async () => {
      await mkdir(dirname(this.file), { recursive: true })
      const temp = `${this.file}.${process.pid}.tmp`
      await writeFile(temp, `${snapshot}\n`, 'utf8')
      await rename(temp, this.file)
    })
    this.writing = write.catch(() => {})
    await write
  }

  /** Stop the timer and make one last best-effort write. */
  dispose(): void {
    this.disposed = true
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    void this.flush().catch(() => {})
  }

  private serializable(): CacheFile {
    const panels: Record<string, Record<string, CacheEntry>> = {}
    for (const [panelId, sources] of this.panels) {
      const entries: Record<string, CacheEntry> = {}
      for (const [sourceId, entry] of sources) entries[sourceId] = { key: entry.key, points: entry.points }
      panels[panelId] = entries
    }
    return { version: 2, panels }
  }

  private schedule(): void {
    this.dirty = true
    if (this.timer !== undefined || this.disposed) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.flush().catch(() => {})
    }, this.flushMs)
    // The cache is best effort: it must not keep dsh alive at shutdown.
    ;(this.timer as { unref?: () => void }).unref?.()
  }
}
