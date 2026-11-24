/**
 * Panel persistence: one JSON file under the dsh home, rewritten atomically
 * (temp file + rename) on every change. Writes are serialized; reads come from
 * the in-memory copy loaded once at start.
 */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { AgentRunState, Json, PanelDefinition, PanelModelSelection, PanelRecord, PanelSource, SourceParse } from '../shared/types.ts'
import { assertPanelData } from '../shared/validate.ts'
import { assertSourceJson } from './source-json.ts'

export const MAX_PANELS = 32

const RETRYABLE_RENAME_CODES = new Set(['EPERM', 'EACCES', 'EBUSY'])
const RENAME_RETRY_DELAYS_MS = [20, 60, 150, 300]
const PARSES = new Set<SourceParse>(['text', 'json', 'lines'])

/**
 * Atomically write a UTF-8 file via a unique temporary sibling and rename,
 * retrying transient Windows file-lock errors (`EPERM`/`EACCES`/`EBUSY`) and
 * always removing the temporary file if the rename does not succeed.
 */
export async function atomicWriteFile(file: string, content: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`
  let renamed = false
  try {
    await writeFile(temp, content, 'utf8')
    for (let attempt = 0; ; attempt += 1) {
      try {
        await rename(temp, file)
        renamed = true
        return
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code === undefined || !RETRYABLE_RENAME_CODES.has(code) || attempt >= RENAME_RETRY_DELAYS_MS.length) {
          throw error
        }
        await new Promise(resolve => setTimeout(resolve, RENAME_RETRY_DELAYS_MS[attempt]))
      }
    }
  } finally {
    if (!renamed) await unlink(temp).catch(() => {})
  }
}

interface StoreFile {
  readonly version: 1
  readonly panels: readonly PanelRecord[]
}

export interface CreateOrUpdateOptions {
  readonly data?: Json | undefined
  /** Optional synchronous guard/lint hook invoked inside the transaction when creating or changing the definition. */
  readonly beforeWrite?: (existing: PanelRecord | undefined) => void
}

export interface CreateOrUpdateResult {
  readonly status: 'created' | 'updated' | 'unchanged'
  readonly panel: PanelRecord
  readonly dataUpdated: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Read a stored card span, defaulting to one column. */
function clampSpan(value: unknown): 1 | 2 | 3 {
  return value === 2 || value === 3 ? value : 1
}

function clampPositiveInt(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.max(1, Math.floor(value))
}

function normalizeSource(raw: unknown): PanelSource | undefined {
  if (!isRecord(raw)) return undefined
  const { id, kind, parse, intervalSec, timeoutMs } = raw
  if (typeof id !== 'string' || id.trim() === '') return undefined
  if (typeof parse !== 'string' || !PARSES.has(parse as SourceParse)) return undefined
  const clampedInterval = clampPositiveInt(intervalSec, 1)
  const validTimeout = typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0
    ? Math.floor(timeoutMs)
    : undefined
  const common = {
    id,
    parse: parse as SourceParse,
    intervalSec: clampedInterval,
    ...(validTimeout === undefined ? {} : { timeoutMs: validTimeout }),
  }
  if (kind === 'command') {
    if (typeof raw['command'] !== 'string' || raw['command'].trim() === '') return undefined
    return { ...common, kind: 'command', command: raw['command'] }
  }
  if (kind === 'http') {
    const { url, method, headers, body } = raw
    if (typeof url !== 'string') return undefined
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return undefined
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined
    if (method !== undefined && method !== 'GET' && method !== 'POST') return undefined
    let normalizedHeaders: Record<string, string> | undefined
    if (headers !== undefined) {
      if (!isRecord(headers)) return undefined
      normalizedHeaders = {}
      for (const [k, v] of Object.entries(headers)) {
        if (typeof v !== 'string') return undefined
        normalizedHeaders[k] = v
      }
    }
    if (body !== undefined && typeof body !== 'string') return undefined
    return {
      ...common,
      kind: 'http',
      url,
      ...(method === undefined ? {} : { method }),
      ...(normalizedHeaders === undefined ? {} : { headers: normalizedHeaders }),
      ...(body === undefined ? {} : { body }),
    }
  }
  return undefined
}

function normalizeModel(raw: unknown): PanelModelSelection | undefined {
  if (!isRecord(raw)) return undefined
  const { provider, model, reasoningEffort } = raw
  if (typeof provider !== 'string' || provider.trim() === '') return undefined
  if (typeof model !== 'string' || model.trim() === '') return undefined
  if (reasoningEffort !== undefined && typeof reasoningEffort !== 'string') return undefined
  return {
    provider,
    model,
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
  }
}

function normalizeDefinition(raw: unknown): PanelDefinition | undefined {
  if (!isRecord(raw)) return undefined
  const { title, icon, html, css, script, height, sources, model, agent } = raw
  if (typeof title !== 'string' || title.trim() === '') return undefined
  if (typeof html !== 'string' || typeof css !== 'string' || typeof script !== 'string') return undefined
  if (height !== 'auto' && (typeof height !== 'number' || !Number.isFinite(height) || height <= 0)) return undefined
  if (!Array.isArray(sources)) return undefined
  const normalizedSources: PanelSource[] = []
  for (const item of sources) {
    const checked = normalizeSource(item)
    if (checked === undefined) return undefined
    normalizedSources.push(checked)
  }
  let normalizedAgent: PanelDefinition['agent']
  if (agent === null) {
    normalizedAgent = null
  } else if (agent !== undefined) {
    if (!isRecord(agent) || typeof agent['instruction'] !== 'string' || agent['instruction'].trim() === '') return undefined
    normalizedAgent = {
      instruction: agent['instruction'],
      everyMinutes: clampPositiveInt(agent['everyMinutes'], 15),
    }
  }
  const normalizedModel = normalizeModel(model)
  return {
    title,
    ...(typeof icon === 'string' && icon !== '' ? { icon } : {}),
    html,
    css,
    script,
    height,
    sources: normalizedSources,
    ...(normalizedModel === undefined ? {} : { model: normalizedModel }),
    ...(normalizedAgent === undefined ? {} : { agent: normalizedAgent }),
  }
}

function normalizeAgentData(raw: unknown): PanelRecord['agentData'] | undefined {
  if (!isRecord(raw) || typeof raw['at'] !== 'string') return undefined
  try {
    assertSourceJson(raw['value'])
  } catch {
    return undefined
  }
  return { value: raw['value'] as Json, at: raw['at'] }
}

function normalizeAgentRun(raw: unknown): AgentRunState | undefined {
  if (!isRecord(raw)) return undefined
  const { status, lastRunAt, nextRunAt, error } = raw
  if (status !== 'idle' && status !== 'running' && status !== 'failed') return undefined
  return {
    status,
    ...(typeof lastRunAt === 'string' ? { lastRunAt } : {}),
    ...(typeof nextRunAt === 'string' ? { nextRunAt } : {}),
    ...(typeof error === 'string' ? { error } : {}),
  }
}

/**
 * Validate and normalize one persisted panel record, stripping legacy fields
 * such as `approvedSources` and clamping source `intervalSec` to >= 1.
 */
function normalizeRecord(raw: unknown): PanelRecord | undefined {
  if (!isRecord(raw)) return undefined
  const { id, version, position, collapsed, span, createdAt, updatedAt, definition, previous, agentData, agentRun } = raw
  if (typeof id !== 'string' || id.trim() === '') return undefined
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) return undefined
  if (typeof position !== 'number' || !Number.isFinite(position)) return undefined
  if (typeof createdAt !== 'string' || typeof updatedAt !== 'string') return undefined
  const normalizedDef = normalizeDefinition(definition)
  if (normalizedDef === undefined) return undefined
  const normalizedPrev = previous === undefined ? undefined : normalizeDefinition(previous)
  const normalizedData = agentData === undefined ? undefined : normalizeAgentData(agentData)
  const normalizedRun = agentRun === undefined ? undefined : normalizeAgentRun(agentRun)
  return {
    id,
    version,
    position,
    collapsed: typeof collapsed === 'boolean' ? collapsed : false,
    span: clampSpan(span),
    createdAt,
    updatedAt,
    definition: normalizedDef,
    ...(normalizedPrev === undefined ? {} : { previous: normalizedPrev }),
    ...(normalizedData === undefined ? {} : { agentData: normalizedData }),
    ...(normalizedRun === undefined ? {} : { agentRun: normalizedRun }),
  }
}

/**
 * Fingerprint of what a panel runs on the Host: the readings cache key and the
 * hub's run identity for a source. Editing html, css or script keeps it;
 * touching any source changes it.
 * @param sources - the definition's sources.
 * @returns a hex digest, or `''` when there is nothing to run.
 */
export function sourcesFingerprint(sources: readonly PanelSource[]): string {
  if (sources.length === 0) return ''
  const canonical = sources.map(source => source.kind === 'command'
    ? ['command', source.id, source.command, source.parse, source.intervalSec, source.timeoutMs ?? null]
    : ['http', source.id, source.method ?? 'GET', source.url, Object.entries(source.headers ?? {}).sort(),
        source.body ?? null, source.parse, source.intervalSec, source.timeoutMs ?? null])
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex').slice(0, 24)
}

export class PanelNotFoundError extends Error {
  constructor(readonly panelId: string) {
    super(`没有 id 为「${panelId}」的面板，先用 pad_list 查看现有面板`)
    this.name = 'PanelNotFoundError'
  }
}

export class PanelStore {
  private panels: PanelRecord[] = []
  private writing: Promise<void> = Promise.resolve()
  private readonly listeners = new Set<() => void>()

  constructor(private readonly file: string) {}

  /** Load the file; a missing file is an empty store, a corrupt one is kept aside. */
  async load(): Promise<void> {
    let text: string
    try {
      text = await readFile(this.file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    try {
      const parsed = JSON.parse(text) as Partial<StoreFile>
      if (!isRecord(parsed) || !Array.isArray(parsed.panels)) {
        throw new Error('panels.json 缺少 panels 数组')
      }
      const seen = new Set<string>()
      const valid: PanelRecord[] = []
      let skipped = 0
      for (const raw of parsed.panels) {
        const record = normalizeRecord(raw)
        if (record === undefined || seen.has(record.id)) {
          skipped += 1
          continue
        }
        seen.add(record.id)
        valid.push(record)
      }
      if (skipped > 0) {
        console.warn(`[dsh-pad] 加载 ${this.file} 时跳过了 ${skipped} 条损坏或重复的面板记录`)
      }
      this.panels = valid.sort((a, b) => a.position - b.position)
    } catch {
      await rename(this.file, `${this.file}.corrupt-${Date.now()}`)
      this.panels = []
    }
  }

  /** @returns a listener disposer; listeners run after every committed change. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  list(): readonly PanelRecord[] {
    return this.panels
  }

  get(id: string): PanelRecord {
    const panel = this.panels.find(p => p.id === id)
    if (panel === undefined) throw new PanelNotFoundError(id)
    return panel
  }

  find(id: string): PanelRecord | undefined {
    return this.panels.find(p => p.id === id)
  }

  async create(definition: PanelDefinition, data?: Json): Promise<PanelRecord> {
    const result = await this.createOrUpdate(definition, { data })
    return result.panel
  }

  /**
   * Create a panel or update an existing panel with the same title inside one
   * serialized transaction, eliminating TOCTOU between duplicate detection,
   * capacity check, validation/lint and persistence.
   */
  async createOrUpdate(definition: PanelDefinition, options: CreateOrUpdateOptions = {}): Promise<CreateOrUpdateResult> {
    const { data, beforeWrite } = options
    return this.transaction(async () => {
      const existing = this.panels.find(p => p.definition.title === definition.title)
      if (existing !== undefined && JSON.stringify(existing.definition) === JSON.stringify(definition)) {
        if (data !== undefined) {
          assertPanelData(data)
          if (!existing.definition.agent) {
            throw new Error(`面板「${existing.definition.title}」没有 AI 刷新，data 只适用于有 agent 的面板`)
          }
          const updated: PanelRecord = { ...existing, agentData: { value: data, at: new Date().toISOString() } }
          await this.replace(updated)
          return { status: 'unchanged', panel: updated, dataUpdated: true }
        }
        return { status: 'unchanged', panel: existing, dataUpdated: false }
      }
      if (data !== undefined) {
        assertPanelData(data)
        if (!definition.agent) {
          throw new Error(`面板「${definition.title}」没有 AI 刷新，data 只适用于有 agent 的面板`)
        }
      }
      if (existing === undefined && this.panels.length >= MAX_PANELS) {
        throw new Error(`最多只能创建 ${MAX_PANELS} 张面板，请先删除不需要的面板`)
      }
      beforeWrite?.(existing)
      if (existing !== undefined) {
        const panel = await this.replaceDefinition(existing, definition, data)
        return { status: 'updated', panel, dataUpdated: data !== undefined }
      }
      const now = new Date().toISOString()
      const panel: PanelRecord = {
        id: `p_${randomUUID().slice(0, 8)}`,
        version: 1,
        position: this.panels.length === 0 ? 0 : Math.max(...this.panels.map(p => p.position)) + 1,
        collapsed: false,
        span: 1,
        createdAt: now,
        updatedAt: now,
        definition,
        ...(data === undefined ? {} : { agentData: { value: data, at: now } }),
        ...(definition.agent ? { agentRun: { status: 'idle', nextRunAt: nextRun(definition, now) } } : {}),
      }
      await this.commit([...this.panels, panel])
      return { status: 'created', panel, dataUpdated: data !== undefined }
    })
  }

  async update(id: string, definition: PanelDefinition, data?: Json): Promise<PanelRecord> {
    return this.updateDefinition(id, () => definition, data)
  }

  /** Apply a synchronous, validated edit to the latest committed definition. */
  async updateDefinition(id: string, edit: (current: PanelRecord) => PanelDefinition, data?: Json): Promise<PanelRecord> {
    return this.transaction(() => {
      const current = this.get(id)
      const nextDef = edit(current)
      if (data !== undefined) {
        assertPanelData(data)
        if (!nextDef.agent) {
          throw new Error(`面板「${nextDef.title}」没有 AI 刷新，data 只适用于有 agent 的面板`)
        }
      }
      return this.replaceDefinition(current, nextDef, data)
    })
  }

  async undo(id: string): Promise<PanelRecord> {
    return this.transaction(async () => {
      const current = this.get(id)
      if (current.previous === undefined) throw new Error('这个面板没有可以撤销的修改')
      const { previous: _dropped, ...rest } = current
      const previous = current.previous
      const now = new Date().toISOString()
      const scheduleChanged = JSON.stringify(current.definition.agent ?? null) !== JSON.stringify(previous.agent ?? null)
      const next: PanelRecord = {
        ...rest,
        version: current.version + 1,
        updatedAt: now,
        definition: previous,
        ...(scheduleChanged
          ? { agentRun: previous.agent ? { status: 'idle' as const, nextRunAt: nextRun(previous, now) } : undefined }
          : {}),
      }
      await this.replace(next)
      return next
    })
  }

  async remove(id: string): Promise<void> {
    return this.transaction(async () => {
      this.get(id)
      await this.commit(this.panels.filter(p => p.id !== id))
    })
  }

  async setCollapsed(id: string, collapsed: boolean): Promise<void> {
    return this.transaction(() => this.replace({ ...this.get(id), collapsed }))
  }

  /** Set how many grid columns one card wants. */
  async setSpan(id: string, span: 1 | 2 | 3): Promise<void> {
    return this.transaction(() => this.replace({ ...this.get(id), span: clampSpan(span) }))
  }

  async move(id: string, delta: -1 | 1): Promise<void> {
    return this.transaction(async () => {
      const ordered = [...this.panels]
      const index = ordered.findIndex(p => p.id === id)
      if (index < 0) throw new PanelNotFoundError(id)
      const target = index + delta
      if (target < 0 || target >= ordered.length) return
      const [moved] = ordered.splice(index, 1)
      ordered.splice(target, 0, moved!)
      await this.commit(ordered.map((p, position) => ({ ...p, position })))
    })
  }

  /** The optional guard is checked inside the transaction, before publishing data. */
  async setAgentData(id: string, value: Json, matches?: (current: PanelRecord) => boolean): Promise<boolean> {
    return this.transaction(async () => {
      const current = this.get(id)
      if (matches !== undefined && !matches(current)) return false
      await this.replace({ ...current, agentData: { value, at: new Date().toISOString() } })
      return true
    })
  }

  /**
   * Set or clear one panel's model. The panel version stays put: this is a
   * routing choice, not an edit that should reload the frame. The model is
   * used by the AI refresh and by one-off `dsh.run` calls from the panel.
   * @param id - panel id.
   * @param model - provider/model to use, or null to follow the default.
   */
  async setModel(id: string, model: PanelModelSelection | null): Promise<void> {
    return this.transaction(() => {
      const current = this.get(id)
      const definition: PanelDefinition = { ...current.definition }
      if (model === null) delete (definition as { model?: PanelModelSelection }).model
      else (definition as { model?: PanelModelSelection }).model = model
      return this.replace({ ...current, updatedAt: new Date().toISOString(), definition })
    })
  }

  /** Update a run only while it still owns the panel's state. Missing panels are a no-op. */
  async setAgentRun(
    id: string,
    run: AgentRunState | ((current: PanelRecord) => AgentRunState),
    matches?: (current: PanelRecord) => boolean,
  ): Promise<boolean> {
    return this.transaction(async () => {
      const current = this.find(id)
      if (current === undefined || (matches !== undefined && !matches(current))) return false
      await this.replace({ ...current, agentRun: typeof run === 'function' ? run(current) : run })
      return true
    })
  }

  private async replaceDefinition(current: PanelRecord, definition: PanelDefinition, data?: Json): Promise<PanelRecord> {
    const now = new Date().toISOString()
    const scheduleChanged = JSON.stringify(current.definition.agent ?? null) !== JSON.stringify(definition.agent ?? null)
    const next: PanelRecord = {
      ...current,
      version: current.version + 1,
      updatedAt: now,
      definition,
      previous: current.definition,
      ...(data === undefined ? {} : { agentData: { value: data, at: now } }),
      ...(scheduleChanged
        ? { agentRun: definition.agent ? { status: 'idle' as const, nextRunAt: nextRun(definition, now) } : undefined }
        : {}),
    }
    await this.replace(next)
    return next
  }

  /** Queue the read/modify/write together; a failed mutation never poisons the next one. */
  private transaction<T>(mutation: () => Promise<T>): Promise<T> {
    const work = this.writing.then(mutation)
    this.writing = work.then(() => {}, () => {})
    return work
  }

  private async replace(next: PanelRecord): Promise<void> {
    await this.commit(this.panels.map(p => (p.id === next.id ? next : p)))
  }

  /** Called only by a transaction. Readers and observers see committed snapshots. */
  private async commit(panels: PanelRecord[]): Promise<void> {
    const ordered = [...panels].sort((a, b) => a.position - b.position)
    const snapshot: StoreFile = { version: 1, panels: ordered }
    await atomicWriteFile(this.file, `${JSON.stringify(snapshot, null, 2)}\n`)
    this.panels = ordered
    for (const listener of this.listeners) {
      try {
        listener()
      } catch {
        // A failing observer must not undo a committed write.
      }
    }
  }
}

/** First agent refresh: one interval after the definition was written. */
function nextRun(definition: PanelDefinition, from: string): string | undefined {
  if (!definition.agent) return undefined
  return new Date(Date.parse(from) + definition.agent.everyMinutes * 60_000).toISOString()
}
