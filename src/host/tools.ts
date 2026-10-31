/**
 * Model-facing tools: the conversation creates, inspects, edits and removes
 * panels through these. A panel's data sources belong to that panel, so a
 * create or update that carries sources runs them at once and reports the
 * first readings; nothing waits for a separate confirmation.
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Json, PanelDefinition, PanelRecord } from '../shared/types.ts'
import { type Limits, PanelValidationError, validateDefinition } from '../shared/validate.ts'
import type { AgentRefresher } from './agent-refresh.ts'
import { PANEL_GUIDE, PANEL_TOPICS, panelManual, type PanelTopic } from './guide.ts'
import type { DataHub } from './hub.ts'
import { formatLint, lintPanel } from './lint.ts'
import { assertModel, modelCatalog } from './models.ts'
import { type SecretResolver, runSource } from './sources.ts'
import { type PanelStore, sourcesFingerprint } from './store.ts'

export interface ToolDeps {
  readonly ctx: Context
  readonly store: PanelStore
  readonly hub: DataHub
  readonly refresher: AgentRefresher | undefined
  readonly limits: Limits
  readonly resolveSecret: SecretResolver
}

const SAMPLE_CHARS = 1500

const sourceItem = {
  type: 'object',
  additionalProperties: true,
  description: '数据源。command：{ id, kind:"command", command, parse, intervalSec, timeoutMs? }；http：{ id, kind:"http", url, method?, headers?, body?, parse, intervalSec, timeoutMs? }',
  properties: {
    id: { type: 'string', description: '小写标识符，脚本里用 dsh.data.sources[id] 读取' },
    kind: { type: 'string', enum: ['command', 'http'] },
    command: { type: 'string', description: 'kind=command：在用户本机执行的 shell 命令' },
    url: { type: 'string', description: 'kind=http：请求地址，可含 {{env:NAME}}' },
    method: { type: 'string', enum: ['GET', 'POST'] },
    headers: { type: 'object', additionalProperties: true, description: '请求头，值可含 {{env:NAME}} 密钥引用' },
    body: { type: 'string' },
    parse: { type: 'string', enum: ['json', 'lines', 'text'], description: '输出怎么交给脚本：json 解析 / 按行拆成数组 / 原文' },
    intervalSec: { type: 'integer', description: '面板打开时的刷新间隔（秒）' },
    timeoutMs: { type: 'integer' },
  },
} as const

const modelSelection = {
  type: 'object',
  additionalProperties: false,
  description: '这张面板使用的模型（AI 刷新和面板内 dsh.run 都用它）：{ provider, model, reasoningEffort? }；不传则跟随全局默认模型。先用 pad_models 查看可选值。',
  properties: {
    provider: { type: 'string', required: true, description: 'provider id，例如 magpie、stepfun' },
    model: { type: 'string', required: true, description: '该 provider 下的模型 id' },
    reasoningEffort: { type: 'string', description: '可选：该模型支持的推理强度 id' },
  },
} as const

const agentBlock = {
  type: 'object',
  additionalProperties: true,
  description: 'AI 刷新（可选）：{ instruction, everyMinutes }。数据只能靠搜索/读网页/推理得到时才用。',
  properties: {
    instruction: { type: 'string', description: '后台刷新时要做什么：取什么、去哪里取、提交的数据结构' },
    everyMinutes: { type: 'integer', description: '刷新间隔（分钟）' },
  },
} as const

const textOutput = {
  schema: { type: 'string' },
  render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
} as const

function sample(value: Json | undefined): string {
  const text = JSON.stringify(value) ?? 'null'
  return text.length > SAMPLE_CHARS ? `${text.slice(0, SAMPLE_CHARS)}…（共 ${text.length} 字符，已截断）` : text
}

function panelSummary(panel: PanelRecord, refresher: AgentRefresher | undefined, hub: DataHub): Json {
  const view = hub.views().find(v => v.id === panel.id)
  return {
    id: panel.id,
    title: panel.definition.title,
    icon: panel.definition.icon ?? null,
    version: panel.version,
    sources: panel.definition.sources.map(s => ({
      id: s.id,
      kind: s.kind,
      what: s.kind === 'command' ? s.command : `${s.method ?? 'GET'} ${s.url}`,
      intervalSec: s.intervalSec,
      lastError: view?.data.sources[s.id]?.ok === false ? view.data.sources[s.id]!.error ?? null : null,
    })),
    agent: panel.definition.agent
      ? {
          everyMinutes: panel.definition.agent.everyMinutes,
          status: refresher?.isBusy(panel.id) ? 'running' : panel.agentRun?.status ?? 'idle',
          lastError: panel.agentRun?.error ?? null,
          nextRunAt: panel.agentRun?.nextRunAt ?? null,
        }
      : null,
  }
}

/**
 * Register the pad_* tools.
 * @param deps - services and limits.
 */
export function registerTools(deps: ToolDeps): void {
  const { ctx, store, hub, refresher, limits, resolveSecret } = deps

  function readingsReport(readings: readonly { id: string, ok: boolean, value?: Json, error?: string }[]): string[] {
    return readings.map(r => r.ok ? `- ${r.id}: ✓ ${sample(r.value)}` : `- ${r.id}: ✗ ${r.error}`)
  }

  async function firstReadings(panel: PanelRecord): Promise<string[]> {
    if (panel.definition.sources.length === 0) return []
    const readings = await hub.runAll(panel.id)
    return ['数据源读数：', ...readingsReport(readings)]
  }

  function validate(raw: Record<string, unknown>): PanelDefinition {
    try {
      return validateDefinition(raw, limits)
    } catch (error) {
      if (error instanceof PanelValidationError) throw new Error(error.message)
      throw error
    }
  }

  /**
   * Enforce the glance contract on a definition the model just wrote.
   *
   * Errors refuse the write: a wall of text is not a panel, and reporting it
   * after the card is on screen leaves the user with the thing they complained
   * about. Warnings ride along with the successful result instead.
   * @param definition - the definition about to be stored.
   * @param plain - the user explicitly asked for a text card; skip the gate.
   * @returns advisory lines for the tool result.
   */
  function lintNotes(definition: PanelDefinition, plain: boolean): string[] {
    const issues = lintPanel(definition)
    const errors = issues.filter(issue => issue.severity === 'error')
    if (errors.length > 0 && !plain) {
      throw new Error(`面板排版不合格，没有写入：\n${formatLint(errors)}\n\n按 pad_guide(topic="recipes") 里的配方改成「一个主数字 + 几行数据」再提交；如果用户明确只要一张文字卡片（便签、引用、说明），传 plain: true 跳过这项检查。`)
    }
    if (errors.length > 0) {
      // plain is the user's call, not the model's: say in the transcript that
      // the check was skipped, so a bad layout cannot disappear quietly.
      return [`已按 plain 跳过排版检查，仍有 ${errors.length} 处问题（${errors.map(issue => issue.rule).join('、')}）。只有在用户确实只想要一张便签时才这样做。`]
    }
    const warnings = formatLint(issues)
    return warnings === '' ? [] : ['排版建议（不阻塞，顺手改掉更好）：', warnings]
  }

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'pad_list',
    description: '列出悬浮面板坞里的所有面板（id、标题、数据源、最近的错误、AI 刷新状态）。改面板、修面板前先调用。',
    parameters: {},
    output: textOutput,
    isConcurrencySafe: () => true,
    async execute() {
      const panels = store.list().map(p => panelSummary(p, refresher, hub))
      return panels.length === 0 ? '还没有面板。' : JSON.stringify(panels, null, 2)
    },
  })), 'dsh-pad: pad_list')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'pad_get',
    description: '读取一张面板的完整定义（html / css / script / sources / agent）和最新数据，修改面板前用。',
    parameters: { id: { type: 'string', required: true, description: '面板 id' } },
    output: textOutput,
    isConcurrencySafe: () => true,
    async execute(args) {
      const panel = store.get(args.id)
      const view = hub.views().find(v => v.id === panel.id)
      const data = view?.data
      return JSON.stringify({
        id: panel.id,
        definition: panel.definition,
        latest: {
          sources: Object.fromEntries(Object.entries(data?.sources ?? {}).map(([id, r]) => [id, r.ok ? { ok: true, value: sample(r.value) } : { ok: false, error: r.error ?? '' }])),
          agent: panel.agentData ? sample(panel.agentData.value) : null,
        },
      }, null, 2)
    },
  })), 'dsh-pad: pad_get')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'pad_test_source',
    description: '试跑一个数据源（不保存），返回真实输出。写面板脚本前先用它看清输出格式。',
    parameters: { source: { ...sourceItem, required: true } },
    output: textOutput,
    async execute(args, exec) {
      const probe = validate({ title: 'test', html: '', css: '', script: '', height: 'auto', sources: [{ intervalSec: limits.minIntervalSec, ...(args.source as Record<string, unknown>) }] })
      const source = probe.sources[0]!
      const reading = await runSource(source, resolveSecret, exec.signal)
      return reading.ok ? `✓ 用时 ${reading.durationMs}ms，输出：\n${sample(reading.value)}` : `✗ ${reading.error}`
    },
  })), 'dsh-pad: pad_test_source')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'pad_models',
    description: '列出可用于这张面板的 provider / 模型 / 推理强度，以及当前全局默认模型。给面板顶层 model 选值时先调用它。',
    parameters: {},
    output: textOutput,
    isConcurrencySafe: () => true,
    async execute() {
      return JSON.stringify(await modelCatalog(ctx), null, 2)
    },
  })), 'dsh-pad: pad_models')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'pad_guide',
    description: '悬浮面板的编写手册：版式（layout）、kit 类名（kit）、完整可跑的 html + script 配方（recipes）、取数方式（data）、面板里的 dsh API（api）、提交前自检（check）。写面板或改版面之前先调用，默认返回全部。',
    parameters: {
      topic: {
        type: 'string',
        enum: [...PANEL_TOPICS],
        description: '只看其中一节；不传返回全部。改版面看 layout + recipes，接数据看 data，写脚本看 api + kit。',
      },
    },
    output: textOutput,
    isConcurrencySafe: () => true,
    async execute(args) {
      return panelManual((args.topic ?? 'all') as PanelTopic)
    },
  })), 'dsh-pad: pad_guide')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'pad_create',
    description: `在悬浮面板坞里新建一张面板。\n\n${PANEL_GUIDE}`,
    parameters: {
      title: { type: 'string', required: true, description: '简短标题（≤40 字）' },
      icon: { type: 'string', description: '一个 emoji' },
      html: { type: 'string', required: true, description: '面板 body 内的 HTML，优先用 pad-* 类' },
      css: { type: 'string', description: '面板样式，用 --pad-* 变量' },
      script: { type: 'string', description: '面板脚本，用 dsh.onData 渲染' },
      height: { oneOf: [{ type: 'string', enum: ['auto'] }, { type: 'integer' }], description: '"auto"（默认，跟随内容）或固定像素高度' },
      sources: { type: 'array', items: sourceItem, description: '直接数据源（可以为空）' },
      model: modelSelection,
      agent: agentBlock,
      data: { type: 'json', description: 'AI 刷新面板的第一版数据（你刚取到的真实数据）' },
      plain: { type: 'boolean', description: '用户明确只要一张文字卡片（便签、引用、说明）时传 true，跳过排版检查' },
    },
    output: textOutput,
    async execute(args) {
      const definition = validate({ css: '', script: '', height: 'auto', sources: [], ...args })
      if (definition.model) await assertModel(ctx, definition.model)
      // A repeated pad_create for a title that already exists is almost
      // always the same request replayed in another session; minting a second
      // record leaves the dock with confusing duplicates. Reuse the existing
      // panel instead and refresh its definition, so the caller sees the new
      // design without multiplying cards. Identical calls are pure no-ops.
      const duplicate = store.list().find(p => p.definition.title === definition.title)
      if (duplicate && JSON.stringify(duplicate.definition) === JSON.stringify(definition)) {
        // The definition is identical, so the call itself is a no-op — but a
        // replayed create may still carry fresh seed data. Apply it like the
        // data-only path of pad_update instead of dropping it silently.
        const lines = [`面板 ${duplicate.id}「${definition.title}」已存在，定义相同，没有新建。`]
        if (args.data !== undefined) {
          await store.setAgentData(duplicate.id, args.data as Json)
          hub.pushData(duplicate.id)
          lines.push('已把这次提交的 data 更新到面板上。')
        }
        lines.push(`要改内容请用 pad_update 传 id；要并排再放一张请先给新面板换个标题。`)
        return lines.join('\n')
      }
      const notes = lintNotes(definition, args.plain === true)
      const panel = duplicate
        ? await store.update(duplicate.id, definition, args.data as Json | undefined)
        : await store.create(definition, args.data as Json | undefined)
      const lines = duplicate
        ? [`已有同名面板 ${panel.id}「${definition.title}」，已把内容更新为这次提交的版本（版本 ${panel.version}），没有新建重复面板。`]
        : [`已创建面板 ${panel.id}「${definition.title}」，已经出现在悬浮面板坞。`]
      lines.push(...await firstReadings(panel))
      lines.push(...notes)
      if (definition.agent && args.data === undefined) lines.push('提醒：AI 刷新面板没有交第一版 data，面板在第一次后台刷新前是空的。最好现在取一次真实数据，用 pad_update 的 data 补上。')
      return lines.join('\n')
    },
  })), 'dsh-pad: pad_create')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'pad_update',
    description: '修改已有面板：只传要改的字段，其余保持不变（model 传对象替换这张面板的模型，传 null 跟随默认；agent 传对象时整体替换，agent 传 null 表示取消 AI 刷新）。也可以只传 data 更新 AI 刷新面板的数据。改动后用户可以在面板菜单里撤销。',
    parameters: {
      id: { type: 'string', required: true, description: '面板 id' },
      title: { type: 'string' },
      icon: { type: 'string' },
      html: { type: 'string' },
      css: { type: 'string' },
      script: { type: 'string' },
      height: { oneOf: [{ type: 'string', enum: ['auto'] }, { type: 'integer' }] },
      sources: { type: 'array', items: sourceItem, description: '传了就整体替换数据源列表' },
      model: { oneOf: [modelSelection, { type: 'null' }] },
      agent: { oneOf: [agentBlock, { type: 'null' }] },
      data: { type: 'json', description: '新的 AI 刷新数据' },
      plain: { type: 'boolean', description: '用户明确只要一张文字卡片时传 true，跳过排版检查' },
    },
    output: textOutput,
    async execute(args) {
      const current = store.get(args.id)
      const { id, data, plain, ...fields } = args
      const changesDefinition = Object.keys(fields).length > 0
      if (!changesDefinition) {
        if (data === undefined) throw new Error('没有要改的字段')
        // A panel without agent refresh never reads agentData — writing it
        // would silently discard the payload. Reject so the caller notices.
        await store.setAgentData(id, data as Json, latest => {
          if (!latest.definition.agent) throw new Error(`面板「${latest.definition.title}」没有 AI 刷新，data 只适用于有 agent 的面板`)
          return true
        })
        hub.pushData(id)
        return `已更新面板「${current.definition.title}」的数据。`
      }
      const candidate = validate({ ...current.definition, ...fields })
      if (candidate.model) await assertModel(ctx, candidate.model)
      // Model lookup is asynchronous. Merge only the requested fields into the
      // latest committed definition after it returns, inside the store transaction.
      let notes: string[] = []
      let sourcesChanged = false
      const panel = await store.updateDefinition(id, latest => {
        const definition = validate({ ...latest.definition, ...fields })
        const editedLayout = definition.html !== latest.definition.html
          || definition.css !== latest.definition.css
          || definition.script !== latest.definition.script
        notes = editedLayout ? lintNotes(definition, plain === true) : []
        sourcesChanged = sourcesFingerprint(latest.definition.sources) !== sourcesFingerprint(definition.sources)
        return definition
      }, data as Json | undefined)
      return [
        `已更新面板 ${panel.id}「${panel.definition.title}」（版本 ${panel.version}）。`,
        ...(sourcesChanged ? await firstReadings(panel) : []),
        ...notes,
      ].join('\n')
    },
  })), 'dsh-pad: pad_update')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'pad_refresh',
    description: '立即刷新一张面板：直接数据源会马上重跑并返回读数；AI 刷新面板会排进后台刷新。用户说面板坏了 / 过期时，修完后用它验证。',
    parameters: { id: { type: 'string', required: true, description: '面板 id' } },
    output: textOutput,
    async execute(args) {
      const panel = store.get(args.id)
      const lines: string[] = []
      if (panel.definition.agent) {
        refresher?.request(panel.id)
        lines.push(refresher ? '已安排后台 AI 刷新，完成后面板会自动更新。' : '这个 dsh 没有 agent 服务，AI 刷新不可用。')
      }
      lines.push(...await firstReadings(panel))
      return lines.join('\n') || '这张面板没有数据源。'
    },
  })), 'dsh-pad: pad_refresh')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'pad_delete',
    description: '删除一张面板（用户明确要删时才用）。',
    parameters: { id: { type: 'string', required: true, description: '面板 id' } },
    output: textOutput,
    async execute(args) {
      const panel = store.get(args.id)
      await store.remove(args.id)
      return `已删除面板「${panel.definition.title}」。`
    },
  })), 'dsh-pad: pad_delete')
}
