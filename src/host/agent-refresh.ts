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
  private readonly running = new Set<string>()
  private timer: ReturnType<typeof setInterval> | undefined

  constructor(
    private readonly ctx: Context,
    private readonly store: PanelStore,
    private readonly options: AgentRefreshOptions,
    private readonly dataChanged: (panelId: string) => void,
  ) {}

  start(): void {
    // A refresh that was running when the Host stopped never finished.
    for (const panel of this.store.list()) {
      if (panel.agentRun?.status === 'running') {
        void this.store.setAgentRun(panel.id, { ...panel.agentRun, status: 'failed', error: '上次刷新被中断' })
      }
    }
    this.timer = setInterval(() => this.scan(), CHECK_EVERY_MS)
    this.scan()
  }

  stop(): void {
    clearInterval(this.timer)
    this.queue.length = 0
  }

  /** Ask for a refresh now (user pressed refresh, or the model called pad_refresh). */
  request(panelId: string): void {
    if (this.running.has(panelId) || this.queue.includes(panelId)) return
    this.queue.push(panelId)
    this.pump()
  }

  isBusy(panelId: string): boolean {
    return this.running.has(panelId) || this.queue.includes(panelId)
  }

  private scan(): void {
    const now = Date.now()
    for (const panel of this.store.list()) {
      const next = panel.agentRun?.nextRunAt
      if (panel.definition.agent && next !== undefined && Date.parse(next) <= now) this.request(panel.id)
    }
  }

  private pump(): void {
    while (this.running.size < this.options.concurrency && this.queue.length > 0) {
      const panelId = this.queue.shift()!
      const panel = this.store.find(panelId)
      if (panel?.definition.agent == null) continue
      this.running.add(panelId)
      void this.run(panel).finally(() => {
        this.running.delete(panelId)
        this.pump()
      })
    }
  }

  private async run(panel: PanelRecord): Promise<void> {
    const agentDef = panel.definition.agent!
    const startedAt = new Date().toISOString()
    await this.store.setAgentRun(panel.id, { ...panel.agentRun, status: 'running', lastRunAt: startedAt })

    let outcome: { ok: true } | { ok: false, reason: string } | undefined
    const panelId = panel.id
    const store = this.store
    const submit = defineTool({
      name: 'pad_submit_data',
      description: '提交这次刷新取到的面板数据（完整 JSON，结构与上一次一致）。每次刷新只调用一次。',
      parameters: {
        data: { type: 'json', required: true, description: '面板数据，JSON 值；面板脚本读 dsh.data.agent.value' },
      },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      async execute(args) {
        const data = args.data as Json
        if (JSON.stringify(data).length > MAX_DATA_BYTES) throw new Error(`数据超过 ${MAX_DATA_BYTES / 1024}KB，只保留面板要显示的字段`)
        await store.setAgentData(panelId, data)
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
        outcome = { ok: false, reason: args.reason.slice(0, 300) }
        return '已记录。'
      },
    })

    let handle: Awaited<ReturnType<Context['agents']['create']>> | undefined
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
      const agent = handle.agent
      agent.followup(createUserMessage({
        content: [{ type: 'text', text: refreshPrompt(panel) }],
        source: { kind: 'dsh-pad', panelId: panel.id },
      }))
      let timer: ReturnType<typeof setTimeout> | undefined
      const timedOut = await Promise.race([
        agent.whenIdle().then(() => false),
        new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(true), this.options.timeoutMs) }),
      ])
      clearTimeout(timer)
      if (timedOut) {
        agent.cancel({ kind: 'hook', reason: 'dsh-pad refresh timeout' })
        outcome ??= { ok: false, reason: `刷新超时（${Math.round(this.options.timeoutMs / 1000)} 秒）` }
      }
    } catch (error) {
      outcome ??= { ok: false, reason: `刷新出错：${error instanceof Error ? error.message : String(error)}` }
    } finally {
      await handle?.dispose().catch(() => {})
    }

    const finished = Date.now()
    const current = this.store.find(panel.id)
    if (current === undefined) return
    const every = (current.definition.agent?.everyMinutes ?? agentDef.everyMinutes) * 60_000
    if (outcome?.ok) {
      await this.store.setAgentRun(panel.id, { status: 'idle', lastRunAt: startedAt, nextRunAt: new Date(finished + every).toISOString() })
      this.dataChanged(panel.id)
    } else {
      const retry = Math.min(every, this.options.retryMinutes * 60_000)
      await this.store.setAgentRun(panel.id, {
        status: 'failed',
        lastRunAt: startedAt,
        nextRunAt: new Date(finished + retry).toISOString(),
        error: outcome?.reason ?? '这一轮没有提交数据',
      })
    }
  }
}

function refreshPrompt(panel: PanelRecord): string {
  const previous = panel.agentData === undefined ? '（还没有数据）' : JSON.stringify(panel.agentData.value, null, 2).slice(0, 8000)
  return [
    `你正在后台刷新右侧面板「${panel.definition.title}」的数据。这不是和用户对话，没有人会看到你的回复。`,
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
