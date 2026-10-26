/**
 * The data hub: latest readings per panel source, polling while somebody
 * watches, and fan-out to the browser streams.
 *
 * Direct sources only poll while at least one open stream watches the panel
 * (the dock is expanded and the card is not folded), so a closed browser or a
 * collapsed dock costs nothing on the Host.
 */
import type { PanelData, PanelRecord, PanelSource, PanelView, ReadingPoint, SourceReading, StreamEvent } from '../shared/types.ts'
import type { ReadingCache } from './readings.ts'
import { type SecretResolver, runSource } from './sources.ts'
import { type PanelStore, sourcesFingerprint } from './store.ts'

/** One open browser stream. */
export interface Subscriber {
  /** Watched panel ids; polling runs for the union of all subscribers. */
  watch: ReadonlySet<string>
  send(event: StreamEvent): void
}

export interface DataHubOptions {
  /** Readings cached by the previous run, per panel id and source id. */
  readonly restored?: ReadonlyMap<string, ReadonlyMap<string, SourceReading>> | undefined
  /** Cache that keeps the newest reading of every source on disk. */
  readonly cache?: ReadingCache | undefined
}

interface SourceTimer {
  /** Fingerprint of the source definition the timer was started for. */
  readonly key: string
  timer: ReturnType<typeof setTimeout> | undefined
}

interface ReadingEntry {
  readonly key: string
  readonly reading: SourceReading
}

interface SourceRun {
  readonly key: string
  readonly controller: AbortController
  readonly promise: Promise<SourceReading>
}

export class DataHub {
  private readonly readings = new Map<string, Map<string, ReadingEntry>>()
  private readonly timers = new Map<string, Map<string, SourceTimer>>()
  private readonly sourceKeys = new WeakMap<PanelSource, string>()
  /** Runs outlive polling timers, including while a panel is folded. */
  private readonly inFlight = new Map<string, Map<string, SourceRun>>()
  private readonly subscribers = new Set<Subscriber>()
  private readonly cache: ReadingCache | undefined
  private disposed = false

  constructor(
    private readonly store: PanelStore,
    private readonly resolveSecret: SecretResolver,
    private readonly onAgentRefresh: (panelId: string) => void,
    options: DataHubOptions = {},
  ) {
    this.cache = options.cache
    // Panels paint from the last session's readings until the first poll lands.
    for (const [panelId, sources] of options.restored ?? []) {
      const panel = this.store.find(panelId)
      if (panel === undefined) continue
      const readings = new Map<string, ReadingEntry>()
      for (const source of panel.definition.sources) {
        const reading = sources.get(source.id)
        if (reading !== undefined) readings.set(source.id, { key: this.sourceKey(source), reading })
      }
      if (readings.size > 0) this.readings.set(panelId, readings)
    }
  }

  /** Re-sync after a store change: push the panel list, restart changed timers. */
  storeChanged(): void {
    if (this.disposed) return
    const panels = this.store.list()
    const keys = new Map(panels.map(panel => [
      panel.id,
      new Map(panel.definition.sources.map(source => [source.id, this.sourceKey(source)])),
    ]))
    for (const [panelId, readings] of this.readings) {
      const current = keys.get(panelId)
      if (current === undefined) {
        this.readings.delete(panelId)
        this.cache?.forgetPanel(panelId)
        continue
      }
      for (const [sourceId, entry] of readings) if (current.get(sourceId) !== entry.key) readings.delete(sourceId)
      if (readings.size === 0) this.readings.delete(panelId)
    }
    const approved = new Set(panels.filter(panel => this.store.approved(panel)).map(panel => panel.id))
    for (const [panelId, runs] of this.inFlight) {
      const current = approved.has(panelId) ? keys.get(panelId) : undefined
      for (const [sourceId, run] of runs) {
        if (current?.get(sourceId) === run.key) continue
        runs.delete(sourceId)
        run.controller.abort()
      }
      if (runs.size === 0) this.inFlight.delete(panelId)
    }
    this.cache?.prune(panels)
    this.broadcast({ type: 'panels', panels: this.views() })
    this.reconcile()
  }

  subscribe(subscriber: Subscriber): () => void {
    this.subscribers.add(subscriber)
    // The first frame of a page also carries the cached trend; later broadcasts
    // skip it, since live readings keep the page's history up to date.
    subscriber.send({ type: 'panels', panels: this.views(true) })
    this.reconcile()
    return () => {
      this.subscribers.delete(subscriber)
      this.reconcile()
    }
  }

  /** Change what a subscriber watches (e.g. a card was folded). */
  rewatch(subscriber: Subscriber, watch: ReadonlySet<string>): void {
    subscriber.watch = watch
    this.reconcile()
  }

  /**
   * Run a panel's sources now and, for agent panels, ask for an agent refresh.
   * @param panelId - the panel to refresh.
   */
  refresh(panelId: string): void {
    if (this.disposed) return
    const panel = this.store.get(panelId)
    if (panel.definition.agent) this.onAgentRefresh(panelId)
    if (!this.store.approved(panel)) return
    for (const source of panel.definition.sources) void this.runNow(panel, source.id)
  }

  /** Send fresh data for one panel (after agent data changed). */
  pushData(panelId: string): void {
    const panel = this.store.find(panelId)
    if (panel !== undefined) this.broadcastData(panel)
  }

  /**
   * One view per panel.
   * @param withHistory - include the cached trend; only a page's first list needs it.
   */
  views(withHistory = false): PanelView[] {
    return this.store.list().map(panel => this.view(panel, withHistory))
  }

  dispose(): void {
    this.disposed = true
    for (const sources of this.timers.values()) for (const t of sources.values()) clearTimeout(t.timer)
    this.timers.clear()
    for (const runs of this.inFlight.values()) for (const run of runs.values()) run.controller.abort()
    this.inFlight.clear()
    this.subscribers.clear()
  }

  private view(panel: PanelRecord, withHistory: boolean): PanelView {
    return {
      id: panel.id,
      version: panel.version,
      position: panel.position,
      collapsed: panel.collapsed,
      span: panel.span,
      updatedAt: panel.updatedAt,
      definition: panel.definition,
      canUndo: panel.previous !== undefined,
      needsApproval: !this.store.approved(panel),
      fingerprint: sourcesFingerprint(panel.definition.sources),
      agentRun: panel.agentRun ?? null,
      data: this.data(panel),
      history: withHistory ? this.history(panel) : {},
    }
  }

  /** Cached points of the panel's declared sources, so a fresh page starts with a trend. */
  private history(panel: PanelRecord): Record<string, readonly ReadingPoint[]> {
    const cached = this.cache?.history(panel.id) ?? {}
    const history: Record<string, readonly ReadingPoint[]> = {}
    for (const source of panel.definition.sources) {
      const points = cached[source.id]
      if (points !== undefined && points.length > 0) history[source.id] = points
    }
    return history
  }

  private data(panel: PanelRecord): PanelData {
    const readings = this.readings.get(panel.id)
    const sources: Record<string, SourceReading> = {}
    for (const source of panel.definition.sources) {
      const entry = readings?.get(source.id)
      if (entry?.key === this.sourceKey(source)) sources[source.id] = entry.reading
    }
    return { sources, agent: panel.agentData ?? null }
  }

  private watched(): Set<string> {
    const ids = new Set<string>()
    for (const subscriber of this.subscribers) for (const id of subscriber.watch) ids.add(id)
    return ids
  }

  /** Start timers for watched, approved sources; stop everything else. */
  private reconcile(): void {
    if (this.disposed) return
    const watched = this.watched()
    const live = new Map<string, Set<string>>()
    for (const panel of this.store.list()) {
      if (!watched.has(panel.id) || !this.store.approved(panel)) continue
      const keep = new Set<string>()
      live.set(panel.id, keep)
      let timers = this.timers.get(panel.id)
      if (timers === undefined) {
        timers = new Map()
        this.timers.set(panel.id, timers)
      }
      for (const source of panel.definition.sources) {
        const key = this.sourceKey(source)
        keep.add(source.id)
        const existing = timers.get(source.id)
        if (existing?.key === key) continue
        if (existing !== undefined) clearTimeout(existing.timer)
        const entry: SourceTimer = { key, timer: undefined }
        timers.set(source.id, entry)
        // Start immediately unless a reading of this exact source is still fresh.
        const last = existing === undefined ? this.readings.get(panel.id)?.get(source.id) : undefined
        const age = last?.key === key ? Date.now() - Date.parse(last.reading.at) : Infinity
        const wait = Math.max(0, source.intervalSec * 1000 - age)
        entry.timer = setTimeout(() => void this.tick(panel.id, source.id), wait)
      }
    }
    for (const [panelId, timers] of this.timers) {
      const keep = live.get(panelId)
      for (const [sourceId, entry] of timers) {
        if (keep?.has(sourceId)) continue
        clearTimeout(entry.timer)
        timers.delete(sourceId)
      }
      if (timers.size === 0) this.timers.delete(panelId)
    }
  }

  private async tick(panelId: string, sourceId: string): Promise<void> {
    const entry = this.timers.get(panelId)?.get(sourceId)
    const panel = this.store.find(panelId)
    const source = panel?.definition.sources.find(s => s.id === sourceId)
    if (entry === undefined || panel === undefined || source === undefined) return
    await this.runNow(panel, sourceId)
    // Re-arm only if this timer is still the live one for the source.
    if (this.timers.get(panelId)?.get(sourceId) === entry && !this.disposed) {
      entry.timer = setTimeout(() => void this.tick(panelId, sourceId), source.intervalSec * 1000)
    }
  }

  /**
   * Run every source of a panel once, record and broadcast the readings.
   * @param panelId - the panel.
   * @returns one reading per source, sharing any in-progress run of that definition.
   */
  async runAll(panelId: string): Promise<Array<SourceReading & { readonly id: string }>> {
    const panel = this.store.get(panelId)
    return await Promise.all(panel.definition.sources.map(async source => {
      const reading = await this.runNow(panel, source.id)
      return { id: source.id, ...(reading ?? { ok: false, error: '正在运行中', at: new Date().toISOString() }) }
    }))
  }

  private async runNow(panel: PanelRecord, sourceId: string): Promise<SourceReading | undefined> {
    if (this.disposed) return undefined
    const source = panel.definition.sources.find(s => s.id === sourceId)
    if (source === undefined) return undefined
    const key = this.sourceKey(source)
    const latest = this.store.find(panel.id)
    const latestSource = latest?.definition.sources.find(s => s.id === sourceId)
    if (latest === undefined || latestSource === undefined || this.sourceKey(latestSource) !== key) {
      return { ok: false, error: '数据源已经变更', at: new Date().toISOString() }
    }
    if (!this.store.approved(latest)) {
      return { ok: false, error: '数据源还没被允许运行', at: new Date().toISOString() }
    }
    let runs = this.inFlight.get(panel.id)
    if (runs === undefined) {
      runs = new Map()
      this.inFlight.set(panel.id, runs)
    }
    const existing = runs.get(sourceId)
    if (existing?.key === key) return await existing.promise
    existing?.controller.abort()
    const controller = new AbortController()
    const promise = (async () => {
      const reading = await runSource(source, this.resolveSecret, controller.signal)
      const current = this.store.find(panel.id)
      // A superseded run must not replace a new reading or erase its cache.
      const still = current?.definition.sources.find(s => s.id === sourceId)
      if (this.disposed || controller.signal.aborted || current === undefined || !this.store.approved(current) || still === undefined || this.sourceKey(still) !== key) return reading
      let readings = this.readings.get(panel.id)
      if (readings === undefined) {
        readings = new Map()
        this.readings.set(panel.id, readings)
      }
      readings.set(sourceId, { key, reading })
      this.cache?.remember(panel.id, sourceId, key, reading)
      this.broadcastData(current)
      return reading
    })()
    const run: SourceRun = { key, controller, promise }
    runs.set(sourceId, run)
    try {
      return await promise
    } finally {
      // An older run may settle after a replacement has already started.
      if (runs.get(sourceId) === run) {
        runs.delete(sourceId)
        if (runs.size === 0 && this.inFlight.get(panel.id) === runs) this.inFlight.delete(panel.id)
      }
    }
  }

  /** Source definitions are immutable; hash each object once without retaining removed sources. */
  private sourceKey(source: PanelSource): string {
    let key = this.sourceKeys.get(source)
    if (key === undefined) {
      key = sourcesFingerprint([source])
      this.sourceKeys.set(source, key)
    }
    return key
  }

  private broadcastData(panel: PanelRecord): void {
    const event: StreamEvent = { type: 'data', panelId: panel.id, data: this.data(panel) }
    for (const subscriber of this.subscribers) if (subscriber.watch.has(panel.id)) subscriber.send(event)
  }

  private broadcast(event: StreamEvent): void {
    for (const subscriber of this.subscribers) subscriber.send(event)
  }
}
