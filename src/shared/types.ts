/**
 * Panel model shared by the Host half, the browser half and the panel iframe.
 * Everything here is JSON: it crosses the `/api/dsh-pad.*` routes as is.
 */

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

/** How a source's raw output is presented to the panel script. */
export type SourceParse = 'text' | 'json' | 'lines'

/** Runs a shell command on the Host machine. */
export interface CommandSource {
  readonly id: string
  readonly kind: 'command'
  /** Passed to the platform shell (`/bin/sh -c` or `cmd.exe /d /s /c`). */
  readonly command: string
  readonly parse: SourceParse
  /** Poll interval while the panel is on screen. */
  readonly intervalSec: number
  readonly timeoutMs?: number
}

/** Fetches a URL from the Host. Header values may hold `{{env:NAME}}` secret references. */
export interface HttpSource {
  readonly id: string
  readonly kind: 'http'
  readonly url: string
  readonly method?: 'GET' | 'POST'
  readonly headers?: Readonly<Record<string, string>>
  readonly body?: string
  readonly parse: SourceParse
  readonly intervalSec: number
  readonly timeoutMs?: number
}

export type PanelSource = CommandSource | HttpSource

/** One exact provider/model route used for a panel's AI refresh. */
export interface PanelModelSelection {
  readonly provider: string
  readonly model: string
  /** Provider-owned reasoning effort id; omitted keeps the model's default. */
  readonly reasoningEffort?: string
}

/** A panel refreshed by a background agent turn instead of (or besides) direct sources. */
export interface AgentRefresh {
  /** What the refresh agent should do: the question, where the data comes from, the data shape to submit. */
  readonly instruction: string
  readonly everyMinutes: number
}

/** What the model authors. */
export interface PanelDefinition {
  readonly title: string
  /** One emoji shown before the title. */
  readonly icon?: string
  readonly html: string
  readonly css: string
  readonly script: string
  /** Fixed iframe height in px, or `auto` to follow the content (capped by the client). */
  readonly height: number | 'auto'
  readonly sources: readonly PanelSource[]
  /** This panel's model, for its AI refresh and for one-off calls from the panel. Omitted follows the default. */
  readonly model?: PanelModelSelection
  readonly agent?: AgentRefresh | null
}

export type AgentRunStatus = 'idle' | 'running' | 'failed'

export interface AgentRunState {
  readonly status: AgentRunStatus
  readonly lastRunAt?: string
  readonly nextRunAt?: string
  readonly error?: string
}

/** One stored panel. */
export interface PanelRecord {
  readonly id: string
  readonly version: number
  readonly position: number
  readonly collapsed: boolean
  /** How many grid columns this card wants; clamped by the dock's current column count. */
  readonly span: 1 | 2 | 3
  readonly createdAt: string
  readonly updatedAt: string
  readonly definition: PanelDefinition
  /** The definition before the last edit, for undo. */
  readonly previous?: PanelDefinition
  /**
   * Fingerprint of the sources the user allowed to run. Sources only run when
   * it equals the fingerprint of the current definition's sources.
   */
  readonly approvedSources?: string
  /** Latest data submitted by the model (in chat or by an agent refresh). */
  readonly agentData?: { readonly value: Json, readonly at: string }
  readonly agentRun?: AgentRunState
}

/** One source's latest reading. */
export interface SourceReading {
  readonly ok: boolean
  readonly value?: Json
  readonly error?: string
  /** ISO time of the reading. */
  readonly at: string
  readonly durationMs?: number
}

/** The data the panel script sees. */
export interface PanelData {
  readonly sources: Readonly<Record<string, SourceReading>>
  readonly agent: { readonly value: Json, readonly at: string } | null
}

/** One point of a source's recent history, oldest first. */
export interface ReadingPoint {
  readonly value: Json
  readonly at: string
}

/** A panel as the browser half renders it. */
export interface PanelView {
  readonly id: string
  readonly version: number
  readonly position: number
  readonly collapsed: boolean
  readonly span: 1 | 2 | 3
  readonly updatedAt: string
  readonly definition: PanelDefinition
  readonly canUndo: boolean
  /** Sources wait for the user's approval before running. */
  readonly needsApproval: boolean
  /** Fingerprint of the current sources; echoed back by the `approve` action. */
  readonly fingerprint: string
  readonly agentRun: AgentRunState | null
  readonly data: PanelData
  /**
   * Points of the last session kept on disk, per source id; a fresh page starts
   * with these so `dsh.history()` has a trend before the first poll comes back.
   */
  readonly history: Readonly<Record<string, readonly ReadingPoint[]>>
}

/** One model advertised for the per-panel AI refresh picker. */
export interface PanelModelOption {
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly reasoningEfforts?: readonly { readonly id: string, readonly name: string }[]
  readonly defaultReasoningEffort?: string
}

/** One provider group in the model picker. */
export interface PanelModelProvider {
  readonly id: string
  readonly name: string
  readonly models: readonly PanelModelOption[]
}

/** What the dock fetches to render its model picker. */
export interface PanelModelCatalog {
  /** Deployment default, used when a panel has no model of its own. */
  readonly default: PanelModelSelection | null
  readonly providers: readonly PanelModelProvider[]
}

/** Result of one `dsh.run` call from a panel. */
export interface PanelRunResult {
  readonly ok: boolean
  readonly text?: string
  readonly error?: string
}

/** Why the updater has (or has not) found a newer release. */
export type PadUpdateReason =
  | 'disabled'
  | 'unchecked'
  | 'up-to-date'
  | 'available'
  | 'source'
  | 'applied'
  | 'error'

/** Update state shown by the dock; replacing files is a separate click. */
export interface PadUpdateInfo {
  readonly current: string
  readonly latest?: string
  readonly available: boolean
  readonly canApply: boolean
  readonly reason: PadUpdateReason
  readonly url?: string
  readonly notes?: string
  readonly checkedAt?: string
  readonly error?: string
  /** Version written to disk; it takes effect after dsh restarts. */
  readonly applied?: string
  readonly requiresRestart?: boolean
}

/** Result of checking or applying an update. */
export interface PadUpdateResponse {
  readonly ok: boolean
  readonly update: PadUpdateInfo
  readonly error?: string
}

/** Server-sent events on `/api/dsh-pad.stream`. */
export type StreamEvent =
  | { readonly type: 'panels', readonly panels: readonly PanelView[] }
  | { readonly type: 'data', readonly panelId: string, readonly data: PanelData }

/** POST bodies on `/api/dsh-pad.action`. */
export type PanelAction =
  | { readonly op: 'refresh', readonly panelId: string }
  | { readonly op: 'delete', readonly panelId: string }
  | { readonly op: 'undo', readonly panelId: string }
  | { readonly op: 'approve', readonly panelId: string, readonly fingerprint: string }
  | { readonly op: 'collapse', readonly panelId: string, readonly collapsed: boolean }
  | { readonly op: 'move', readonly panelId: string, readonly delta: -1 | 1 }
  | { readonly op: 'span', readonly panelId: string, readonly span: 1 | 2 | 3 }
  | { readonly op: 'model', readonly panelId: string, readonly model: PanelModelSelection | null }

export const ROUTES = {
  panels: '/api/dsh-pad.panels',
  stream: '/api/dsh-pad.stream',
  action: '/api/dsh-pad.action',
  models: '/api/dsh-pad.models',
  run: '/api/dsh-pad.run',
  update: '/api/dsh-pad.update',
} as const
