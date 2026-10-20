/**
 * Browser-side panel state: one event stream to the Host, the panel list,
 * per-source reading history, and the dock's own view state (expanded,
 * width, capsule position) persisted per device.
 */
import { type Json, type PanelAction, type PanelData, type PanelModelCatalog, type PanelRunResult, type PanelView, type PadUpdateInfo, ROUTES, type StreamEvent } from '../shared/types.ts'

export const HISTORY_LIMIT = 120

export interface HistoryPoint {
  readonly value: Json
  readonly at: string
}

/** One row of tiled cards; weights are relative widths inside the row. */
export interface PanelRowLayout {
  readonly ids: readonly string[]
  readonly weights: readonly number[]
}

export interface DockLayout {
  readonly expanded: boolean
  readonly width: number
  /** Tiled rows; every panel appears in exactly one row. */
  readonly rows: readonly PanelRowLayout[]
  /** Capsule vertical position as a fraction of the viewport height. */
  readonly capsuleY: number
  /** Per-panel iframe height in px, set by dragging a panel's bottom edge. */
  readonly heights: Readonly<Record<string, number>>
  /** Dock height in px, set by dragging the dock's top or bottom edge. */
  readonly dockHeight?: number
}

export interface PadSnapshot {
  readonly panels: readonly PanelView[]
  readonly connected: boolean
  /** Whether the first panel list arrived. */
  readonly loaded: boolean
  readonly layout: DockLayout
  /** Id of a panel created while this page was open, for a short highlight. */
  readonly fresh: string | undefined
}

const LAYOUT_KEY = 'dsh-pad:layout'
const DEFAULT_LAYOUT: DockLayout = { expanded: false, width: 352, rows: [], capsuleY: 0.42, heights: {} }
export const MIN_WIDTH = 288
export const MAX_WIDTH = 980
/** Safe band for the floating capsule: it must stay clear of the window chrome. */
export const MIN_CAPSULE_Y = 0.1
export const MAX_CAPSULE_Y = 0.9
export const MIN_PANEL_HEIGHT = 120
export const MAX_PANEL_HEIGHT = 900
/** Bounds for a dock height chosen with its top/bottom edge handles. */
export const MIN_DOCK_HEIGHT = 180
export const MAX_DOCK_HEIGHT = 2000

/** Document-relative form of an absolute `/api/…` route, as dsh's own transport uses. */
function routeUrl(route: string): string {
  return route.slice(1)
}

function readHeights(raw: unknown): Record<string, number> {
  const heights: Record<string, number> = {}
  if (typeof raw !== 'object' || raw === null) return heights
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'number' && Number.isFinite(value)) heights[id] = clampPanelHeight(value)
  }
  return heights
}

export function clampPanelHeight(height: number): number {
  return Math.round(Math.min(MAX_PANEL_HEIGHT, Math.max(MIN_PANEL_HEIGHT, height)))
}

/** Keeps the floating capsule in a band where it can always be clicked again. */
function readCapsuleY(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_LAYOUT.capsuleY
  // A capsule parked against the top edge hides under the window chrome and can
  // never be clicked again, so a stuck value falls back to the default position.
  if (value < 0.08 || value > 0.95) return DEFAULT_LAYOUT.capsuleY
  return Math.min(MAX_CAPSULE_Y, Math.max(MIN_CAPSULE_Y, value))
}

function normalizeDockHeight(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return Math.round(Math.min(MAX_DOCK_HEIGHT, Math.max(MIN_DOCK_HEIGHT, value)))
}

function readRows(raw: unknown): PanelRowLayout[] {
  if (!Array.isArray(raw)) return []
  const rows: PanelRowLayout[] = []
  for (const value of raw) {
    if (typeof value !== 'object' || value === null) continue
    const row = value as Record<string, unknown>
    const ids = row['ids']
    const weights = row['weights']
    if (!Array.isArray(ids) || !Array.isArray(weights)) continue
    const cleanIds = ids.filter((id): id is string => typeof id === 'string' && id.length > 0)
    if (cleanIds.length === 0) continue
    const cleanWeights = cleanIds.map((_, index) => {
      const weight = weights[index]
      return typeof weight === 'number' && Number.isFinite(weight) && weight > 0 ? Math.min(20, weight) : 1
    })
    rows.push({ ids: cleanIds, weights: cleanWeights })
  }
  return rows
}

function normalizeLayout(raw: Partial<DockLayout> | null): DockLayout {
  if (raw === null) return DEFAULT_LAYOUT
  return {
    expanded: raw.expanded === true,
    width: typeof raw.width === 'number' && Number.isFinite(raw.width)
      ? Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, raw.width))
      : DEFAULT_LAYOUT.width,
    rows: readRows(raw.rows),
    capsuleY: readCapsuleY(raw.capsuleY),
    heights: readHeights(raw.heights),
    dockHeight: normalizeDockHeight(raw.dockHeight),
  }
}

function readLayout(): DockLayout {
  try {
    return normalizeLayout(JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? 'null') as Partial<DockLayout> | null)
  } catch {
    return DEFAULT_LAYOUT
  }
}

export class PadClient {
  private snapshot: PadSnapshot = { panels: [], connected: false, loaded: false, layout: readLayout(), fresh: undefined }
  private readonly listeners = new Set<() => void>()
  private readonly history = new Map<string, Map<string, HistoryPoint[]>>()
  private source: EventSource | undefined
  private watchKey = ''
  private known: Set<string> | undefined
  private freshTimer: ReturnType<typeof setTimeout> | undefined
  private modelCatalog: PanelModelCatalog | undefined
  private started = false

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  readonly getSnapshot = (): PadSnapshot => this.snapshot

  start(): void {
    if (this.started) return
    this.started = true
    this.reconnect()
  }

  stop(): void {
    this.started = false
    this.source?.close()
    this.source = undefined
    this.watchKey = ''
    clearTimeout(this.freshTimer)
  }

  /** Readings of one source collected while this page was open, oldest first. */
  historyOf(panelId: string, sourceId: string): readonly HistoryPoint[] {
    return this.history.get(panelId)?.get(sourceId) ?? []
  }

  /** All histories of one panel, for the panel frame. */
  historiesOf(panelId: string): Record<string, readonly HistoryPoint[]> {
    return Object.fromEntries(this.history.get(panelId) ?? [])
  }

  setLayout(patch: Partial<DockLayout>): void {
    this.persistLayout(patch)
    this.reconnect()
  }

  /** Pin one card at a freeform position, or return it to the auto flow. */
  /** Store the tiled rows (order, grouping and split weights). */
  setRows(rows: readonly PanelRowLayout[]): void {
    this.setLayout({ rows })
  }

  /** Remember one panel's iframe height, or clear it with `undefined` (auto). */
  setPanelHeight(panelId: string, height: number | undefined): void {
    const heights = { ...this.snapshot.layout.heights }
    if (height === undefined) delete heights[panelId]
    else heights[panelId] = clampPanelHeight(height)
    this.persistLayout({ heights })
  }

  /** Remember the dock's height, or clear it with `undefined` (auto). */
  setDockHeight(height: number | undefined): void {
    this.persistLayout({ dockHeight: height })
  }

  /** The height the user dragged a panel to, if any. */
  panelHeight(panelId: string): number | undefined {
    return this.snapshot.layout.heights[panelId]
  }

  private persistLayout(patch: Partial<DockLayout>): void {
    const layout = normalizeLayout({ ...this.snapshot.layout, ...patch })
    try {
      localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout))
    } catch {
      // Private mode: layout just doesn't persist.
    }
    this.update({ layout })
  }

  async act(action: PanelAction): Promise<{ ok: boolean, error?: string }> {
    try {
      const response = await fetch(routeUrl(ROUTES.action), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(action),
        credentials: 'same-origin',
      })
      const body = await response.json().catch(() => ({})) as { ok?: boolean, error?: string }
      return response.ok ? { ok: true } : { ok: false, error: body.error ?? `HTTP ${response.status}` }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  /** The per-panel model picker's catalog; fetched once per page. */
  async models(force = false): Promise<PanelModelCatalog> {
    if (!force && this.modelCatalog !== undefined) return this.modelCatalog
    const response = await fetch(routeUrl(ROUTES.models), { credentials: 'same-origin' })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    this.modelCatalog = await response.json() as PanelModelCatalog
    return this.modelCatalog
  }

  /** One `dsh.run` call from this panel's frame. */
  async run(panelId: string, prompt: string, system?: string): Promise<PanelRunResult> {
    try {
      const response = await fetch(routeUrl(ROUTES.run), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ panelId, prompt, ...(system === undefined ? {} : { system }) }),
        credentials: 'same-origin',
      })
      const body = await response.json().catch(() => ({})) as Partial<PanelRunResult>
      if (!response.ok && typeof body.error !== 'string') return { ok: false, error: `HTTP ${response.status}` }
      return {
        ok: body.ok === true,
        ...(typeof body.text === 'string' ? { text: body.text } : {}),
        ...(typeof body.error === 'string' ? { error: body.error } : {}),
      }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  /** Latest GitHub release compared with the version loaded by the Host. */
  async checkUpdate(force = false): Promise<PadUpdateInfo> {
    const response = await fetch(`${routeUrl(ROUTES.update)}${force ? '?force=1' : ''}`, { credentials: 'same-origin' })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return await response.json() as PadUpdateInfo
  }

  /** Download the release and replace this plugin; the next dsh start loads it. */
  async applyUpdate(): Promise<{ ok: boolean, error?: string, update?: PadUpdateInfo }> {
    try {
      const response = await fetch(routeUrl(ROUTES.update), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'apply' }),
        credentials: 'same-origin',
      })
      const body = await response.json().catch(() => ({})) as { ok?: boolean, error?: string, update?: PadUpdateInfo }
      return {
        ok: response.ok && body.ok === true,
        ...(typeof body.error === 'string' ? { error: body.error } : {}),
        ...(body.update === undefined ? {} : { update: body.update }),
      }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  /** Panels the Host should poll: everything visible in an expanded dock. */
  private watchIds(): string[] {
    if (!this.snapshot.layout.expanded) return []
    return this.snapshot.panels.filter(p => !p.collapsed && !p.needsApproval).map(p => p.id)
  }

  /** (Re)open the stream when the watched set changed. */
  private reconnect(): void {
    if (!this.started) return
    const ids = this.watchIds()
    const key = ids.join(',')
    if (this.source !== undefined && key === this.watchKey) return
    this.watchKey = key
    this.source?.close()
    const url = `${routeUrl(ROUTES.stream)}?watch=${encodeURIComponent(key)}`
    const source = new EventSource(url, { withCredentials: true })
    this.source = source
    source.onopen = () => {
      if (this.source === source) this.update({ connected: true })
    }
    source.onerror = () => {
      if (this.source === source) this.update({ connected: false })
    }
    source.onmessage = (message: MessageEvent<string>) => {
      if (this.source !== source) return
      try {
        this.receive(JSON.parse(message.data) as StreamEvent)
      } catch {
        // Ignore a malformed frame; the next one carries full state.
      }
    }
  }

  private receive(event: StreamEvent): void {
    if (event.type === 'panels') {
      for (const panel of event.panels) this.record(panel.id, panel.data)
      const ids = new Set(event.panels.map(p => p.id))
      for (const id of [...this.history.keys()]) if (!ids.has(id)) this.history.delete(id)
      const created = this.known === undefined ? undefined : event.panels.find(p => !this.known!.has(p.id))
      this.known = ids
      this.update({ panels: event.panels, loaded: true, connected: true })
      if (created !== undefined) this.announce(created.id)
      this.reconnect()
      return
    }
    this.record(event.panelId, event.data)
    this.update({
      panels: this.snapshot.panels.map(p => (p.id === event.panelId ? { ...p, data: event.data } : p)),
    })
  }

  /** A panel appeared while the page was open: open the dock and highlight it. */
  private announce(panelId: string): void {
    clearTimeout(this.freshTimer)
    if (!this.snapshot.layout.expanded) this.setLayout({ expanded: true })
    this.update({ fresh: panelId })
    this.freshTimer = setTimeout(() => this.update({ fresh: undefined }), 2400)
  }

  private record(panelId: string, data: PanelData): void {
    let panelHistory = this.history.get(panelId)
    if (panelHistory === undefined) {
      panelHistory = new Map()
      this.history.set(panelId, panelHistory)
    }
    for (const [sourceId, reading] of Object.entries(data.sources)) {
      if (!reading.ok || reading.value === undefined) continue
      let points = panelHistory.get(sourceId)
      if (points === undefined) {
        points = []
        panelHistory.set(sourceId, points)
      }
      if (points.length > 0 && points[points.length - 1]!.at === reading.at) continue
      points.push({ value: reading.value, at: reading.at })
      if (points.length > HISTORY_LIMIT) points.splice(0, points.length - HISTORY_LIMIT)
    }
  }

  private update(patch: Partial<PadSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch }
    for (const listener of this.listeners) listener()
  }
}
