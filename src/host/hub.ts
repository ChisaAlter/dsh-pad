/**
 * The data hub: latest readings per panel source, polling while somebody
 * watches, and fan-out to the browser streams.
 *
 * Direct sources only poll while at least one open stream watches the panel
 * (the dock is expanded and the card is not folded), so a closed browser or a
 * collapsed dock costs nothing on the Host.
 */
import type { PanelData, PanelRecord, PanelView, SourceReading, StreamEvent } from '../shared/types.ts'
import { type SecretResolver, runSource } from './sources.ts'
import { type PanelStore, sourcesFingerprint } from './store.ts'

/** One open browser stream. */
export interface Subscriber {
  /** Watched panel ids; polling runs for the union of all subscribers. */
  watch: ReadonlySet<string>
  send(event: StreamEvent): void
}

interface SourceTimer {
  /** Fingerprint of the source definition the timer was started for. */
  readonly key: string
  timer: ReturnType<typeof setTimeout> | undefined
  running: boolean
}

export class DataHub {
  private readonly readings = new Map<string, Map<string, SourceReading>>()
  private readonly timers = new Map<string, Map<string, SourceTimer>>()
  private readonly subscribers = new Set<Subscriber>()
  private disposed = false

  constructor(
    private readonly store: PanelStore,
    private readonly resolveSecret: SecretResolver,
    private readonly onAgentRefresh: (panelId: string) => void,
  ) {}

  /** Re-sync after a store change: push the panel list, restart changed timers. */
  storeChanged(): void {
    const ids = new Set(this.store.list().map(p => p.id))
    for (const id of [...this.readings.keys()]) if (!ids.has(id)) this.readings.delete(id)
    this.broadcast({ type: 'panels', panels: this.views() })
    this.reconcile()
  }

  subscribe(subscriber: Subscriber): () => void {
    this.subscribers.add(subscriber)
    subscriber.send({ type: 'panels', panels: this.views() })
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

  views(): PanelView[] {
    return this.store.list().map(panel => this.view(panel))
  }

  dispose(): void {
    this.disposed = true
    for (const sources of this.timers.values()) for (const t of sources.values()) clearTimeout(t.timer)
    this.timers.clear()
    this.subscribers.clear()
  }

  private view(panel: PanelRecord): PanelView {
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
    }
  }

  private data(panel: PanelRecord): PanelData {
    const readings = this.readings.get(panel.id)
    const sources: Record<string, SourceReading> = {}
    for (const source of panel.definition.sources) {
      const reading = readings?.get(source.id)
      if (reading !== undefined) sources[source.id] = reading
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
        const key = sourcesFingerprint([source])
        keep.add(source.id)
        const existing = timers.get(source.id)
        if (existing?.key === key) continue
        if (existing !== undefined) clearTimeout(existing.timer)
        const entry: SourceTimer = { key, timer: undefined, running: false }
        timers.set(source.id, entry)
        // Start immediately unless a reading of this exact source is still fresh.
        const last = existing === undefined ? this.readings.get(panel.id)?.get(source.id) : undefined
        const age = last === undefined ? Infinity : Date.now() - Date.parse(last.at)
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
   * @returns one reading per source (a source already running reports its last reading).
   */
  async runAll(panelId: string): Promise<Array<SourceReading & { readonly id: string }>> {
    const panel = this.store.get(panelId)
    return await Promise.all(panel.definition.sources.map(async source => {
      const reading = await this.runNow(panel, source.id)
      return { id: source.id, ...(reading ?? { ok: false, error: '正在运行中', at: new Date().toISOString() }) }
    }))
  }

  private async runNow(panel: PanelRecord, sourceId: string): Promise<SourceReading | undefined> {
    const source = panel.definition.sources.find(s => s.id === sourceId)
    if (source === undefined) return undefined
    const entry = this.timers.get(panel.id)?.get(sourceId)
    if (entry?.running) return this.readings.get(panel.id)?.get(sourceId)
    if (entry) entry.running = true
    try {
      const reading = await runSource(source, this.resolveSecret)
      const current = this.store.find(panel.id)
      // Drop readings of a source that changed while it ran.
      const still = current?.definition.sources.find(s => s.id === sourceId)
      if (current === undefined || still === undefined || sourcesFingerprint([still]) !== sourcesFingerprint([source])) return reading
      let readings = this.readings.get(panel.id)
      if (readings === undefined) {
        readings = new Map()
        this.readings.set(panel.id, readings)
      }
      readings.set(sourceId, reading)
      this.broadcastData(current)
      return reading
    } finally {
      if (entry) entry.running = false
    }
  }

  private broadcastData(panel: PanelRecord): void {
    const event: StreamEvent = { type: 'data', panelId: panel.id, data: this.data(panel) }
    for (const subscriber of this.subscribers) if (subscriber.watch.has(panel.id)) subscriber.send(event)
  }

  private broadcast(event: StreamEvent): void {
    for (const subscriber of this.subscribers) subscriber.send(event)
  }
}
