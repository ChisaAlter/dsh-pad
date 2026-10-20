/**
 * Panel persistence: one JSON file under the dsh home, rewritten atomically
 * (temp file + rename) on every change. Writes are serialized; reads come from
 * the in-memory copy loaded once at start.
 */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { AgentRunState, Json, PanelDefinition, PanelModelSelection, PanelRecord, PanelSource } from '../shared/types.ts'

interface StoreFile {
  readonly version: 1
  readonly panels: readonly PanelRecord[]
}

/** Read a stored card span, defaulting to one column. */
function clampSpan(value: unknown): 1 | 2 | 3 {
  return value === 2 || value === 3 ? value : 1
}

/**
 * Fingerprint of what a panel runs on the Host. Editing html, css or script
 * keeps it; touching any source changes it and withdraws the user's approval.
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

  constructor(private readonly file: string, private readonly autoApprove: boolean) {}

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
      const parsed = JSON.parse(text) as StoreFile
      this.panels = [...parsed.panels]
        .sort((a, b) => a.position - b.position)
        .map(panel => ({ ...panel, span: clampSpan(panel.span) }))
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

  /** Whether the panel's current sources may run. */
  approved(panel: PanelRecord): boolean {
    const fingerprint = sourcesFingerprint(panel.definition.sources)
    return fingerprint === '' || panel.approvedSources === fingerprint
  }

  async create(definition: PanelDefinition, data?: Json): Promise<PanelRecord> {
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
      ...(this.autoApprove ? { approvedSources: sourcesFingerprint(definition.sources) } : {}),
      ...(data === undefined ? {} : { agentData: { value: data, at: now } }),
      ...(definition.agent ? { agentRun: { status: 'idle', nextRunAt: nextRun(definition, now) } } : {}),
    }
    await this.commit([...this.panels, panel])
    return panel
  }

  async update(id: string, definition: PanelDefinition, data?: Json): Promise<PanelRecord> {
    const current = this.get(id)
    const now = new Date().toISOString()
    const scheduleChanged = JSON.stringify(current.definition.agent ?? null) !== JSON.stringify(definition.agent ?? null)
    const next: PanelRecord = {
      ...current,
      version: current.version + 1,
      updatedAt: now,
      definition,
      previous: current.definition,
      ...(this.autoApprove ? { approvedSources: sourcesFingerprint(definition.sources) } : {}),
      ...(data === undefined ? {} : { agentData: { value: data, at: now } }),
      ...(scheduleChanged
        ? { agentRun: definition.agent ? { status: 'idle' as const, nextRunAt: nextRun(definition, now) } : undefined }
        : {}),
    }
    await this.replace(next)
    return next
  }

  async undo(id: string): Promise<PanelRecord> {
    const current = this.get(id)
    if (current.previous === undefined) throw new Error('这个面板没有可以撤销的修改')
    const { previous: _dropped, ...rest } = current
    const next: PanelRecord = { ...rest, version: current.version + 1, updatedAt: new Date().toISOString(), definition: current.previous }
    await this.replace(next)
    return next
  }

  async remove(id: string): Promise<void> {
    this.get(id)
    await this.commit(this.panels.filter(p => p.id !== id))
  }

  async approve(id: string, fingerprint: string): Promise<boolean> {
    const current = this.get(id)
    if (sourcesFingerprint(current.definition.sources) !== fingerprint) return false
    await this.replace({ ...current, approvedSources: fingerprint })
    return true
  }

  async setCollapsed(id: string, collapsed: boolean): Promise<void> {
    await this.replace({ ...this.get(id), collapsed })
  }

  /** Set how many grid columns one card wants. */
  async setSpan(id: string, span: 1 | 2 | 3): Promise<void> {
    await this.replace({ ...this.get(id), span: clampSpan(span) })
  }

  async move(id: string, delta: -1 | 1): Promise<void> {
    const ordered = [...this.panels]
    const index = ordered.findIndex(p => p.id === id)
    if (index < 0) throw new PanelNotFoundError(id)
    const target = index + delta
    if (target < 0 || target >= ordered.length) return
    const [moved] = ordered.splice(index, 1)
    ordered.splice(target, 0, moved!)
    await this.commit(ordered.map((p, position) => ({ ...p, position })))
  }

  async setAgentData(id: string, value: Json): Promise<void> {
    await this.replace({ ...this.get(id), agentData: { value, at: new Date().toISOString() } })
  }

  /**
   * Set or clear one panel's model. The panel version stays put: this is a
   * routing choice, not an edit that should reload the frame. The model is
   * used by the AI refresh and by one-off `dsh.run` calls from the panel.
   * @param id - panel id.
   * @param model - provider/model to use, or null to follow the default.
   */
  async setModel(id: string, model: PanelModelSelection | null): Promise<void> {
    const current = this.get(id)
    const definition: PanelDefinition = { ...current.definition }
    if (model === null) delete (definition as { model?: PanelModelSelection }).model
    else (definition as { model?: PanelModelSelection }).model = model
    await this.replace({ ...current, updatedAt: new Date().toISOString(), definition })
  }

  async setAgentRun(id: string, run: AgentRunState): Promise<void> {
    const current = this.find(id)
    if (current !== undefined) await this.replace({ ...current, agentRun: run })
  }

  private async replace(next: PanelRecord): Promise<void> {
    await this.commit(this.panels.map(p => (p.id === next.id ? next : p)))
  }

  private async commit(panels: PanelRecord[]): Promise<void> {
    this.panels = panels.sort((a, b) => a.position - b.position)
    const snapshot: StoreFile = { version: 1, panels: this.panels }
    const write = this.writing.then(async () => {
      await mkdir(dirname(this.file), { recursive: true })
      const temp = `${this.file}.${process.pid}.tmp`
      await writeFile(temp, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8')
      await rename(temp, this.file)
    })
    this.writing = write.catch(() => {})
    await write
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
