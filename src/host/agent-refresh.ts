/**
 * Agent refresh: panels with an `agent` block are refreshed by a short
 * background agent turn (like ChisaBot's live panels). The turn gets two
 * scoped tools — `pad_submit_data` and `pad_report_failure` — and is torn
 * down when it goes idle or runs out of time.
 */
import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Json, PanelRecord } from '../shared/types.ts'
import type { PanelStore } from './store.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** A background panel refresh prompt written by dsh-pad. */
    'dsh-pad': { kind: 'dsh-pad', panelId: string }
  }
}

export interface AgentRefreshOptions {
  /** Upper bound for one refresh turn. */
  readonly timeoutMs: number
  /** Refresh turns allowed at the same time. */
  readonly concurrency: number
  /** Delay before retrying a failed refresh, in minutes (capped by the panel interval). */
  readonly retryMinutes: number
  /**
   * Working directory of refresh agents. A dedicated empty directory keeps
   * project instructions out of the turn and groups the refresh session logs.
   */
  readonly workDir: string
}

const CHECK_EVERY_MS = 30_000
const MAX_DATA_BYTES = 256 * 1024

export class AgentRefresher {
  private readonly queue: string[] = []
  /** Panel id → generation of the run that owns it. */
  private readonly running = new Map<string, number>()
  /** In-flight agent handles, so stop() can cancel real work. */
  private readonly active = new Map<string, { readonly generation: number, readonly cancel: () => void }>()
  private timer: ReturnType<typeof setInterval> | undefined
  private generation = 0
  private stopped = true

  constructor(
    private readonly ctx: Context,
    private readonly store: PanelStore,
    private readonly options: AgentRefreshOptions,
    private readonly dataChanged: (panelId: string) => void,
  ) {}

  start(): void {
    if (this.timer !== undefined) return
    this.stopped = false
    this.generation += 1
    // A refresh that was running when the Host stopped never finished.
    for (const panel of this.store.list()) {
      if (panel.agentRun?.status === 'running') {
        void this.store.setAgentRun(panel.id, { ...panel.agentRun, status: 'failed', error: '上次刷新被中断' }).catch(() => {})
      }
    }
    this.timer = setInterval(() => this.scan(), CHECK_EVERY_MS)
    this.scan()
  }

  stop(): void {
    this.stopped = true
    this.generation += 1
    if (this.timer !== undefined) {
      clearInterval(this.timer)
      this.timer = undefined
    }
    this.queue.length = 0
    const active = [...this.active.values()]
    this.active.clear()
    this.running.clear()
    for (const entry of active) {
      try {
        entry.cancel()
      } catch {
        // A handle that has already gone away is fine.
      }
    }
  }

  /** Ask for a refresh now (user pressed refresh, or the model called pad_refresh). */
  request(panelId: string): void {
    if (this.stopped) return
    if (this.running.has(panelId) || this.queue.includes(panelId)) return
    this.queue.push(panelId)
    this.pump()
  }

  isBusy(panelId: string): boolean {
    return this.running.has(panelId) || this.queue.includes(panelId)
  }

  private scan(): void {
    if (this.stopped) return
    const now = Date.now()
    for (const panel of this.store.list()) {
      const next = panel.agentRun?.nextRunAt
      if (panel.definition.agent && next !== undefined && Date.parse(next) <= now) this.request(panel.id)
    }
  }

  private pump(): void {
    if (this.stopped) return
    const generation = this.generation
    while (this.running.size < this.options.concurrency && this.queue.length > 0) {
      const panelId = this.queue.shift()!
      if (this.running.has(panelId)) continue
      const panel = this.store.find(panelId)
      if (panel?.definition.agent == null) continue
      this.running.set(panelId, generation)
      void this.run(panel, generation).catch(() => {
        // run() reports failures as data; this is only a last-resort guard so
        // a rejected store write cannot become an unhandled rejection.
      }).finally(() => {
        if (this.running.get(panelId) === generation) this.running.delete(panelId)
        if (!this.stopped && this.generation === generation) this.pump()
      })
    }
  }

  private async run(panel: PanelRecord, generation: number): Promise<void> {
    if (this.stopped || generation !== this.generation) return
    if (panel.definition.agent == null) return
    const startedAt = new Date().toISOString()
    try {
      await this.store.setAgentRun(panel.id, { ...panel.agentRun, status: 'running', lastRunAt: startedAt })
    } catch {
      return
    }
    if (this.stopped || generation !== this.generation) return

    let outcome: { ok: true } | { ok: false, reason: string } | undefined
    let accepting = true
    let submitted = false
    let handle: Awaited<ReturnType<Context['agents']['create']>> | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    let releaseWait: () => void = () => {}
    const cancelled = new Promise<void>(resolve => { releaseWait = resolve })
    const cancelRun = (reason: string): void => {
      accepting = false
      releaseWait()
      try {
        handle?.agent.cancel({ kind: 'hook', reason })
      } catch {
        // An agent that already stopped still loses permission to submit.
      }
    }
    const panelId = panel.id
    const store = this.store
    const sameDefinition = (): boolean => {
      const current = store.find(panelId)
      return current !== undefined && current.version === panel.version
        && JSON.stringify(current.definition.model) === JSON.stringify(panel.definition.model)
        && current.definition.agent != null
    }
    const currentRun = (): boolean => accepting && !this.stopped && generation === this.generation && sameDefinition()
    const unsubscribe = store.onChange(() => {
      if (!accepting || sameDefinition()) return
      cancelRun('dsh-pad refresh definition changed')
      const current = store.find(panelId)
      // Source/UI/model edits can leave the old run's status behind. Agent
      // instruction/interval edits already install their own new schedule.
      if (current?.definition.agent && current.agentRun?.status === 'running') {
        void store.setAgentRun(panelId, {
          status: 'idle',
          nextRunAt: new Date(Date.now() + current.definition.agent.everyMinutes * 60_000).toISOString(),
          ...(current.agentRun.lastRunAt === undefined ? {} : { lastRunAt: current.agentRun.lastRunAt }),
        }).catch(() => {})
      }
    })
    const assertSubmission = (): void => {
      if (!currentRun()) throw new Error('刷新已停止、结束或定义已变更')
      if (submitted) throw new Error('这一轮已经提交过结果')
    }
    const submit = defineTool({
      name: 'pad_submit_data',
      description: '提交这次刷新取到的面板数据（完整 JSON，结构与上一次一致）。每次刷新只调用一次。',
      parameters: {
        data: { type: 'json', required: true, description: '面板数据，JSON 值；面板脚本读 dsh.data.agent.value' },
      },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      async execute(args) {
        assertSubmission()
        const data = args.data as Json
        if (Buffer.byteLength(JSON.stringify(data), 'utf8') > MAX_DATA_BYTES) throw new Error(`数据超过 ${MAX_DATA_BYTES / 1024}KB，只保留面板要显示的字段`)
        submitted = true
        try {
          await store.setAgentData(panelId, data)
        } catch (error) {
          submitted = false
          throw error
        }
        outcome = { ok: true }
        return '已提交，面板已更新。不需要再做别的。'
      },
    })
    const fail = defineTool({
      name: 'pad_report_failure',
      description: '取不到真实数据时调用，用一句话说明原因（会显示在面板上）。',
      parameters: { reason: { type: 'string', required: true, description: '原因，一句大白话' } },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      async execute(args) {
        assertSubmission()
        submitted = true
        outcome = { ok: false, reason: args.reason.slice(0, 300) }
        return '已记录。'
      },
    })

    try {
      const agents = this.ctx.get('agents')
      if (agents === undefined) throw new Error('这个 dsh 组合没有 agent 服务')
      await mkdir(this.options.workDir, { recursive: true })
      // A panel may name its own model; otherwise use the deployment default
      // like every other bare agent entry point.
      const explicit = panel.definition.model
      const fallback = this.ctx.get('agentDefaultModel')?.currentSelection()
      const selection = explicit ?? fallback
      const modelOptions = selection === undefined
        ? {}
        : {
            provider: selection.provider,
            model: selection.model,
            ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
          }
      // The product tools (web fetch/search, shell, files) come with the agent preset.
      const presets = this.ctx.get('agentPresets')
      const preset = presets === undefined ? undefined : await presets.resolve()
      if (!currentRun()) return
      handle = await agents.create({
        sessionId: `dsh-pad-${panel.id}-${randomUUID().slice(0, 8)}` as SessionId,
        meta: { cwd: this.options.workDir, ...(preset === undefined ? {} : { agentPreset: preset.id }) },
        ...(selection === undefined
          ? {}
          : { agentOptions: modelOptions }),
        setup: async (agentCtx) => {
          if (presets !== undefined && preset !== undefined) await presets.mount(agentCtx, preset.id)
          agentCtx.tools.register(submit)
          agentCtx.tools.register(fail)
        },
      })
      if (!currentRun()) return
      this.active.set(panel.id, {
        generation,
        cancel: () => cancelRun('dsh-pad refresh stopped'),
      })
      const agent = handle.agent
      agent.followup(createUserMessage({
        content: [{ type: 'text', text: refreshPrompt(panel) }],
        source: { kind: 'dsh-pad', panelId: panel.id },
      }))
      const timedOut = await Promise.race([
        agent.whenIdle().then(() => false),
        cancelled.then(() => false),
        new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(true), this.options.timeoutMs) }),
      ])
      clearTimeout(timer)
      if (timedOut) {
        cancelRun('dsh-pad refresh timeout')
        outcome ??= { ok: false, reason: `刷新超时（${Math.round(this.options.timeoutMs / 1000)} 秒）` }
      }
    } catch (error) {
      outcome ??= { ok: false, reason: `刷新出错：${error instanceof Error ? error.message : String(error)}` }
    } finally {
      accepting = false
      clearTimeout(timer)
      unsubscribe()
      if (this.active.get(panel.id)?.generation === generation) this.active.delete(panel.id)
      await handle?.dispose().catch(() => {})
    }

    if (this.stopped || generation !== this.generation || !sameDefinition()) return
    const finished = Date.now()
    const current = this.store.find(panel.id)
    const currentAgent = current?.definition.agent
    if (current === undefined || currentAgent == null) return
    const every = currentAgent.everyMinutes * 60_000
    try {
      if (outcome?.ok) {
        await this.store.setAgentRun(panel.id, { status: 'idle', lastRunAt: startedAt, nextRunAt: new Date(finished + every).toISOString() })
        try {
          this.dataChanged(panel.id)
        } catch {
          // A failing observer must not turn a finished refresh into a failure.
        }
      } else {
        const retry = Math.min(every, this.options.retryMinutes * 60_000)
        await this.store.setAgentRun(panel.id, {
          status: 'failed',
          lastRunAt: startedAt,
          nextRunAt: new Date(finished + retry).toISOString(),
          error: outcome?.reason ?? '这一轮没有提交数据',
        })
      }
    } catch {
      // The run itself finished; a failed state write is retried by scan/start.
    }
  }
}

function refreshPrompt(panel: PanelRecord): string {
  const previous = panel.agentData === undefined ? '（还没有数据）' : JSON.stringify(panel.agentData.value, null, 2).slice(0, 8000)
  return [
    `你正在后台刷新悬浮面板「${panel.definition.title}」的数据。这不是和用户对话，没有人会看到你的回复。`,
    '',
    '刷新说明：',
    panel.definition.agent!.instruction,
    '',
    '上一次提交的数据（新数据必须保持同样的结构和字段名，面板脚本按它渲染）：',
    '```json',
    previous,
    '```',
    '',
    '用你的工具取最新的真实数据，然后调用 pad_submit_data 提交一次完整数据。',
    '取不到就调用 pad_report_failure 说明原因。绝不编造数字。完成后直接结束，不要输出总结。',
  ].join('\n')
}
