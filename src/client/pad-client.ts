/**
 * Browser-side panel state: one event stream to the Host, the panel list,
 * per-source reading history, and the dock's own view state (expanded, width,
 * floating-ball and window positions, nested card layout) persisted per device.
 */
import type { PanelAction, PanelData, PanelDefinition, PanelModelCatalog, PanelRunResult, PanelSource, PanelView, PadUpdateInfo, ReadingPoint, StreamEvent } from '../shared/types.ts'
import { ROUTES } from '../shared/types.ts'
import { type LayoutNode, legacyRowsToTree, parseTree } from './layout.ts'
import type { BallEdge } from './ball-position.ts'

export const HISTORY_LIMIT = 120

/** One point of a source's history, as the panel frame receives it. */
export type HistoryPoint = ReadingPoint

/** One row of the pre-nesting tiled layout; read only to migrate stored state. */
export interface PanelRowLayout {
  readonly ids: readonly string[]
  readonly weights: readonly number[]
}

/** A viewport position in CSS pixels. */
export interface Point {
  readonly x: number
  readonly y: number
}

export interface DockControl {
  readonly edge: BallEdge
  readonly point: Point
}

export interface DockLayout {
  readonly expanded: boolean
  readonly width: number
  /** Nested card layout; null when there are no panels yet. */
  readonly tree: LayoutNode | null
  /** Floating ball's top-left corner. */
  readonly ball: Point
  /** Attached edge; null is a free ball, absent migrates a legacy position. */
  readonly ballEdge?: BallEdge | null
  /** Where the user last put the expanded window; null opens next to the ball. */
  readonly dock: Point | null
  /** Edge and position along it retained when moving or resizing an attached window. */
  readonly dockControl?: DockControl | null
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
  /** A synchronous stream setup failure; retained until the connection opens. */
  readonly connectionError?: string
  readonly layout: DockLayout
  /** Id of a panel created while this page was open, for a short highlight. */
  readonly fresh: string | undefined
}

const LAYOUT_KEY = 'dsh-pad:layout'
const DEFAULT_WIDTH = 352
export const MIN_WIDTH = 288
export const MAX_WIDTH = 980
export const MIN_PANEL_HEIGHT = 120
export const MAX_PANEL_HEIGHT = 900
/** Bounds for a dock height chosen with its top/bottom edge handles. */
export const MIN_DOCK_HEIGHT = 180
export const MAX_DOCK_HEIGHT = 2000
/** The floating open button: a round ball, not a strip on the edge. */
export const BALL_SIZE = 28
/** Keep at least this much of the ball on screen while dragging / restoring. */
export const BALL_MARGIN = 1
/** Snap inset that puts the ball centre under the header's collapse button
 * (8px window gap + 9px right inset + half the 28px button). */
export const BALL_SNAP_INSET = 31 - BALL_SIZE / 2

function viewportSize(): { width: number, height: number } {
  if (typeof window === 'undefined') return { width: 1440, height: 900 }
  return { width: window.innerWidth, height: window.innerHeight }
}

/** Default floating-ball spot: just inside the right edge, a little above centre. */
function defaultBall(): Point {
  const { width, height } = viewportSize()
  return {
    x: Math.max(BALL_MARGIN, Math.round(width - BALL_SIZE - BALL_SNAP_INSET)),
    y: Math.max(BALL_MARGIN, Math.round(height * 0.42 - BALL_SIZE / 2)),
  }
}

const DEFAULT_LAYOUT: DockLayout = {
  expanded: false,
  width: DEFAULT_WIDTH,
  tree: null,
  ball: defaultBall(),
  dock: null,
  heights: {},
}

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

/**
 * Whether a panel's script must wait for its first readings before it runs.
 *
 * After a dsh restart the Hub has no readings yet, and a script written as
 * `dsh.onData(data => data.sources.metric.value…)` throws on that empty first
 * render: the card then shows a script error, and a top-level throw can even
 * stop the script before it registers its listener, leaving the panel dead.
 * The frame is therefore not created until every declared source has a reading
 * (a failed source still counts — the panel shows the error itself).
 *
 * Panels without direct sources render immediately: a static panel has nothing
 * to wait for, and an agent-refreshed panel keeps its data with the panel.
 * @param definition - the panel's definition.
 * @param data - the data the client has for it right now.
 * @returns true while a declared source has not been read yet.
 */
export function awaitingFirstData(definition: PanelDefinition, data: PanelData): boolean {
  return definition.sources.some(source => !Object.hasOwn(data.sources, source.id) || data.sources[source.id] === undefined)
}

/** Same canonical fields/defaults as the Host's sourcesFingerprint, without crypto. */
function sourceKey(source: PanelSource): string {
  return JSON.stringify(source.kind === 'command'
    ? ['command', source.id, source.command, source.parse, source.intervalSec, source.timeoutMs ?? null]
    : ['http', source.id, source.method ?? 'GET', source.url, Object.entries(source.headers ?? {}).sort(),
        source.body ?? null, source.parse, source.intervalSec, source.timeoutMs ?? null])
}

/** Keep the latest value at each instant, oldest first, without reviving evicted points. */
function mergeHistory(points: readonly HistoryPoint[], minimum = -Infinity): HistoryPoint[] {
  const byTime = new Map<number, HistoryPoint>()
  for (const point of points) {
    const time = typeof point?.at === 'string' ? Date.parse(point.at) : NaN
    if (!Number.isFinite(time) || time < minimum) continue
    byTime.set(time, { value: point.value, at: point.at })
  }
  return [...byTime].sort(([a], [b]) => a - b).slice(-HISTORY_LIMIT).map(([, point]) => point)
}

/**
 * Merge the Host's cached history, including readings missed while disconnected.
 * Local points win timestamp ties; snapshots cannot revive points older than
 * the local window or replace its newer readings.
 * @param store - the client's per-panel, per-source history.
 * @param panel - the panel view, carrying the cached points.
 */
export function seedPanelHistory(store: Map<string, Map<string, HistoryPoint[]>>, panel: PanelView): void {
  if (panel.history === undefined || panel.history === null) return
  for (const { id: sourceId } of panel.definition.sources) {
    const points = panel.history[sourceId]
    if (!Array.isArray(points) || points.length === 0) continue
    let panelHistory = store.get(panel.id)
    const local = panelHistory?.get(sourceId) ?? []
    const clean = mergeHistory([...points, ...local], local.length > 0 ? Date.parse(local[0]!.at) : -Infinity)
    if (clean.length === 0) continue
    if (panelHistory === undefined) {
      panelHistory = new Map()
      store.set(panel.id, panelHistory)
    }
    panelHistory.set(sourceId, clean)
  }
}

function readPoint(raw: unknown): Point | null {
  if (typeof raw !== 'object' || raw === null) return null
  const record = raw as Record<string, unknown>
  const x = record['x']
  const y = record['y']
  if (typeof x !== 'number' || !Number.isFinite(x)) return null
  if (typeof y !== 'number' || !Number.isFinite(y)) return null
  return { x, y }
}

/**
 * Read the ball position, migrating the old `capsuleY` fraction. The ball is
 * kept fully inside the current viewport so it can always be clicked again.
 */
function readBall(raw: unknown, legacy: Record<string, unknown>): Point {
  const point = readPoint(raw)
  if (point !== null) {
    const { width, height } = viewportSize()
    return {
      x: Math.round(Math.min(Math.max(BALL_MARGIN, point.x), Math.max(BALL_MARGIN, width - BALL_SIZE - BALL_MARGIN))),
      y: Math.round(Math.min(Math.max(BALL_MARGIN, point.y), Math.max(BALL_MARGIN, height - BALL_SIZE - BALL_MARGIN))),
    }
  }
  const fraction = legacy['capsuleY']
  if (typeof fraction === 'number' && Number.isFinite(fraction)) {
    const { width, height } = viewportSize()
    const y = Math.min(0.94, Math.max(0.06, fraction))
    return { x: width - BALL_SIZE - BALL_SNAP_INSET, y: Math.round(height * y - BALL_SIZE / 2) }
  }
  return defaultBall()
}

function normalizeDockHeight(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return Math.round(Math.min(MAX_DOCK_HEIGHT, Math.max(MIN_DOCK_HEIGHT, value)))
}

/** Read the old row layout, used only to migrate a stored client state. */
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

/**
 * Validate one persisted layout, migrating the old row list and `capsuleY`.
 * Exported for tests; the client always calls it through `readLayout`.
 */
export function normalizeDockLayout(raw: unknown): DockLayout {
  if (typeof raw !== 'object' || raw === null) {
    return { ...DEFAULT_LAYOUT, ball: defaultBall() }
  }
  const record = raw as Record<string, unknown>
  const rows = readRows(record['rows'])
  const tree = parseTree(record['tree']) ?? (rows.length > 0 ? legacyRowsToTree(rows) : null)
  const dockHeight = normalizeDockHeight(record['dockHeight'])
  const rawControl = record['dockControl'] as { edge?: unknown, point?: unknown } | null | undefined
  const controlPoint = readPoint(rawControl?.point)
  const controlEdge = rawControl?.edge
  const dockControl: DockControl | undefined = controlPoint !== null && (controlEdge === 'left' || controlEdge === 'right' || controlEdge === 'top' || controlEdge === 'bottom')
    ? { edge: controlEdge, point: controlPoint } : undefined
  // Edge-attached windows may be narrower than the normal resize minimum
  // beside desktop controls. Retain that effective width after detaching.
  const width = typeof record['width'] === 'number' && Number.isFinite(record['width'])
    ? Math.min(MAX_WIDTH, Math.max(dockControl === undefined ? MIN_WIDTH : BALL_SIZE, record['width']))
    : DEFAULT_LAYOUT.width
  const rawEdge = record['ballEdge']
  const ballEdge = rawEdge === null || rawEdge === 'left' || rawEdge === 'right' || rawEdge === 'top' || rawEdge === 'bottom'
    ? rawEdge
    : undefined
  return {
    expanded: record['expanded'] === true,
    width,
    tree,
    ball: readBall(record['ball'], record),
    ...(ballEdge === undefined ? {} : { ballEdge }),
    dock: readPoint(record['dock']),
    ...(dockControl === undefined ? {} : { dockControl }),
    heights: readHeights(record['heights']),
    ...(dockHeight === undefined ? {} : { dockHeight }),
  }
}

function readLayout(): DockLayout {
  try {
    return normalizeDockLayout(JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? 'null') as unknown)
  } catch {
    return { ...DEFAULT_LAYOUT, ball: defaultBall() }
  }
}

export class PadClient {
  private snapshot: PadSnapshot = { panels: [], connected: false, loaded: false, layout: readLayout(), fresh: undefined }
  private readonly listeners = new Set<() => void>()
  private readonly history = new Map<string, Map<string, HistoryPoint[]>>()
  private readonly sourceKeys = new Map<string, Map<string, string>>()
  private source: EventSource | undefined
  private watchKey = ''
  private known: Set<string> | undefined
  private freshTimer: ReturnType<typeof setTimeout> | undefined
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined
  private modelCatalog: PanelModelCatalog | undefined
  private started = false

  private readonly onVisibilityChange = (): void => { this.reconnect() }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  readonly getSnapshot = (): PadSnapshot => this.snapshot

  start(): void {
    if (this.started) return
    this.started = true
    if (typeof document !== 'undefined') document.addEventListener?.('visibilitychange', this.onVisibilityChange)
    this.reconnect()
  }

  stop(): void {
    this.started = false
    if (typeof document !== 'undefined') document.removeEventListener?.('visibilitychange', this.onVisibilityChange)
    const source = this.source
    this.source = undefined
    source?.close()
    this.watchKey = ''
    clearTimeout(this.freshTimer)
    clearTimeout(this.reconnectTimer)
    this.reconnectTimer = undefined
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

  /** Store the nested card tree (order, splits and widths). */
  setTree(tree: LayoutNode | null): void {
    this.setLayout({ tree })
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
    const layout = normalizeDockLayout({ ...this.snapshot.layout, ...patch })
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
    if (!this.snapshot.layout.expanded || (typeof document !== 'undefined' && document.visibilityState === 'hidden')) return []
    return this.snapshot.panels.filter(p => !p.collapsed && !p.needsApproval).map(p => p.id)
  }

  /** (Re)open the stream when the watched set changed. */
  private reconnect(): void {
    if (!this.started) return
    const ids = this.watchIds()
    const key = ids.join(',')
    if (this.source !== undefined && key === this.watchKey) return
    clearTimeout(this.reconnectTimer)
    this.reconnectTimer = undefined
    this.watchKey = key
    const previous = this.source
    this.source = undefined
    previous?.close()
    const url = `${routeUrl(ROUTES.stream)}?watch=${encodeURIComponent(key)}`
    let source: EventSource
    try {
      source = new EventSource(url, { withCredentials: true })
    } catch (error) {
      // A constructor failure used to abort plugin activation before the dock
      // was registered. Keep the entrance visible and retry while still owned.
      this.update({ connected: false, connectionError: error instanceof Error ? error.message : String(error) })
      this.scheduleReconnect()
      return
    }
    this.source = source
    source.onopen = () => {
      if (this.source === source) this.update({ connected: true, connectionError: undefined })
    }
    source.onerror = () => {
      if (this.source !== source) return
      // CONNECTING streams retry natively; CLOSED ones (e.g. HTTP 401/404) do not.
      if (source.readyState === 2) {
        this.source = undefined
        source.close()
        this.scheduleReconnect()
      }
      this.update({ connected: false })
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

  private scheduleReconnect(): void {
    if (!this.started || this.reconnectTimer !== undefined) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      this.reconnect()
    }, 3000)
  }

  private receive(event: StreamEvent): void {
    if (event.type === 'panels') {
      for (const panel of event.panels) {
        const keys = new Map(panel.definition.sources.map(source => [source.id, sourceKey(source)]))
        const previous = this.sourceKeys.get(panel.id)
        const history = this.history.get(panel.id)
        if (history !== undefined) {
          for (const id of history.keys()) if (!keys.has(id) || previous?.get(id) !== keys.get(id)) history.delete(id)
        }
        this.sourceKeys.set(panel.id, keys)
        seedPanelHistory(this.history, panel)
        this.record(panel.id, panel.data)
      }
      const ids = new Set(event.panels.map(p => p.id))
      for (const id of this.history.keys()) if (!ids.has(id)) this.history.delete(id)
      for (const id of this.sourceKeys.keys()) if (!ids.has(id)) this.sourceKeys.delete(id)
      const created = this.known === undefined ? undefined : event.panels.find(p => !this.known!.has(p.id))
      this.known = ids
      this.update({ panels: event.panels, loaded: true, connected: true, connectionError: undefined })
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
    const keys = this.sourceKeys.get(panelId)
    if (keys === undefined) return
    let panelHistory = this.history.get(panelId)
    if (panelHistory === undefined) {
      panelHistory = new Map()
      this.history.set(panelId, panelHistory)
    }
    for (const [sourceId, reading] of Object.entries(data.sources)) {
      if (!keys.has(sourceId) || !reading.ok || reading.value === undefined) continue
      const points = panelHistory.get(sourceId) ?? []
      const clean = mergeHistory([...points, { value: reading.value, at: reading.at }], points.length > 0 ? Date.parse(points[0]!.at) : -Infinity)
      if (clean.length > 0) panelHistory.set(sourceId, clean)
    }
  }

  private update(patch: Partial<PadSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch }
    for (const listener of this.listeners) listener()
  }
}
