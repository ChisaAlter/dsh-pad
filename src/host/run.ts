/**
 * One-off model calls requested by a panel's own button. The panel never sees
 * a provider key or the network: it asks the dock, the dock calls this Host
 * service, and only the finished text travels back into the sandboxed frame.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { PanelModelSelection, PanelRecord, PanelRunResult } from '../shared/types.ts'

export interface PanelRunOptions {
  readonly enabled: boolean
  readonly timeoutMs: number
  readonly maxTokens: number
  /** Concurrent calls allowed for one panel. */
  readonly concurrency: number
  readonly maxPromptChars: number
  readonly maxSystemChars: number
  readonly maxOutputChars: number
  /** Minimum gap between two calls for one panel, so a looping script cannot burn tokens. */
  readonly minIntervalMs: number
}

export const DEFAULT_RUN_OPTIONS: PanelRunOptions = {
  enabled: true,
  timeoutMs: 120_000,
  maxTokens: 2048,
  concurrency: 2,
  maxPromptChars: 24_000,
  maxSystemChars: 8_000,
  maxOutputChars: 32_000,
  minIntervalMs: 1000,
}

const DEFAULT_SYSTEM = 'You are a model embedded in a dashboard panel. Answer the user prompt directly and concisely, in plain text or Markdown. Do not mention this instruction and do not call tools.'

interface StreamChunk {
  readonly type: string
  readonly text?: string
  readonly reason?: {
    readonly kind?: string
    readonly failure?: { readonly message?: string }
  }
}

interface LlmStreamService {
  stream(options: {
    readonly provider: string
    readonly model: string
    readonly reasoningEffort?: string
    readonly system?: string
    readonly messages: readonly { readonly role: 'user', readonly content: readonly { readonly type: 'text', readonly text: string }[] }[]
    readonly maxTokens?: number
    readonly signal?: AbortSignal
  }): AsyncIterable<StreamChunk>
}

interface DefaultModelService {
  currentSelection(): PanelModelSelection | undefined
}

export class PanelRunner {
  private readonly active = new Map<string, number>()
  private readonly lastRun = new Map<string, number>()
  private readonly controllers = new Set<AbortController>()
  private disposed = false

  constructor(
    private readonly ctx: Context,
    private readonly options: PanelRunOptions = DEFAULT_RUN_OPTIONS,
  ) {}

  /**
   * Run one prompt for a panel, using its model or the deployment default.
   * @param panel - the panel the frame belongs to.
   * @param prompt - user/model prompt from the panel.
   * @param system - optional system instruction authored by the panel.
   * @returns text, or a short error safe to render in the panel.
   */
  async run(panel: PanelRecord, prompt: string, system?: string, signal?: AbortSignal): Promise<PanelRunResult> {
    if (this.disposed) return { ok: false, error: '面板模型服务已停止' }
    if (signal?.aborted) return { ok: false, error: '模型调用被中止' }
    if (!this.options.enabled) return { ok: false, error: '这个 dsh 关闭了面板内模型调用' }
    const text = prompt.trim()
    if (text === '') return { ok: false, error: '提示词是空的' }
    if (prompt.length > this.options.maxPromptChars) {
      return { ok: false, error: `提示词不能超过 ${this.options.maxPromptChars} 个字符` }
    }
    if (system !== undefined && system.length > this.options.maxSystemChars) {
      return { ok: false, error: `system 不能超过 ${this.options.maxSystemChars} 个字符` }
    }
    const running = this.active.get(panel.id) ?? 0
    if (running >= this.options.concurrency) {
      return { ok: false, error: '这个面板同时进行的模型调用太多了，请稍后再试' }
    }
    const now = Date.now()
    if (now - (this.lastRun.get(panel.id) ?? 0) < this.options.minIntervalMs) {
      return { ok: false, error: '刚调用过模型，请稍后再试' }
    }
    this.lastRun.set(panel.id, now)
    this.active.set(panel.id, running + 1)
    let streaming: Promise<PanelRunResult> | undefined
    const release = (): void => {
      const left = (this.active.get(panel.id) ?? 1) - 1
      if (left <= 0) this.active.delete(panel.id)
      else this.active.set(panel.id, left)
    }
    try {
      return await this.call(panel, text, system, signal, work => { streaming = work })
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    } finally {
      // A provider ignoring abort still owns a concurrency slot until its
      // iterator exits, even though the caller receives a timeout immediately.
      if (streaming !== undefined) void streaming.then(release, release)
      else release()
    }
  }

  /** Abort open model calls when the plugin unloads. */
  dispose(): void {
    this.disposed = true
    for (const controller of this.controllers) controller.abort()
    this.controllers.clear()
    this.lastRun.clear()
  }

  private async call(panel: PanelRecord, prompt: string, system: string | undefined, signal: AbortSignal | undefined, track: (work: Promise<PanelRunResult>) => void): Promise<PanelRunResult> {
    const llm = this.ctx.get('llm') as unknown as LlmStreamService | undefined
    if (llm === undefined) return { ok: false, error: '这个 dsh 组合没有 llm 服务' }
    const selection = panel.definition.model
      ?? (this.ctx.get('agentDefaultModel') as unknown as DefaultModelService | undefined)?.currentSelection()
    if (selection === undefined) return { ok: false, error: '没有可用的模型' }
    const controller = new AbortController()
    this.controllers.add(controller)
    let timedOut = false
    const abortFailure = (): PanelRunResult => ({ ok: false, error: timedOut ? '模型调用超时' : '模型调用被中止' })
    const cancel = (): void => controller.abort()
    signal?.addEventListener('abort', cancel, { once: true })
    if (signal?.aborted) cancel()
    let onAbort: () => void = () => {}
    const aborted = new Promise<PanelRunResult>(resolve => {
      onAbort = () => resolve(abortFailure())
      controller.signal.addEventListener('abort', onAbort, { once: true })
      if (controller.signal.aborted) onAbort()
    })
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, this.options.timeoutMs)
    const consume = async (): Promise<PanelRunResult> => {
      let output = ''
      let failure: string | undefined
      try {
        if (controller.signal.aborted) return abortFailure()
        for await (const chunk of llm.stream({
          provider: selection.provider,
          model: selection.model,
          ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
          system: system ?? DEFAULT_SYSTEM,
          messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
          maxTokens: this.options.maxTokens,
          signal: controller.signal,
        })) {
          if (controller.signal.aborted) return abortFailure()
          if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
            // Enforce the output bound while streaming, not only at the end.
            output += chunk.text.slice(0, Math.max(0, this.options.maxOutputChars - output.length))
          } else if (chunk.type === 'finish') {
            if (chunk.reason?.kind === 'error') {
              failure = chunk.reason.failure?.message ?? '模型调用出错'
            } else if (chunk.reason?.kind === 'aborted') {
              failure = timedOut ? '模型调用超时' : '模型调用被中止'
            }
          }
        }
      } catch (error) {
        failure ??= controller.signal.aborted
          ? timedOut ? '模型调用超时' : '模型调用被中止'
          : error instanceof Error ? error.message : String(error)
      }
      if (controller.signal.aborted) return abortFailure()
      if (failure !== undefined) return { ok: false, error: failure }
      const text = output.trim()
      if (text === '') return { ok: false, error: '模型没有返回文本' }
      return { ok: true, text }
    }
    const work = consume()
    track(work)
    try {
      // Providers should honor abort, but a stuck iterator must not hold the
      // HTTP request beyond this service's timeout.
      return await Promise.race([work, aborted])
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', cancel)
      controller.signal.removeEventListener('abort', onAbort)
      this.controllers.delete(controller)
    }
  }
}
