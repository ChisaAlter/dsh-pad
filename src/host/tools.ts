/**
 * Model-facing tools: the conversation creates, inspects, edits and removes
 * panels through these. New or changed data sources are put to the user
 * through dsh's own approval prompt; a declined or unavailable prompt leaves
 * the panel waiting for approval in the dock instead.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-user-approval'
import { type ToolRunContext, defineTool } from '@deepseek-ai/dsh-tools'
import type { Json, PanelDefinition, PanelRecord, PanelSource } from '../shared/types.ts'
import { type Limits, PanelValidationError, validateDefinition } from '../shared/validate.ts'
import type { AgentRefresher } from './agent-refresh.ts'
import { PANEL_GUIDE } from './guide.ts'
import type { DataHub } from './hub.ts'
import { assertModel, modelCatalog } from './models.ts'
import { type SecretResolver, runSource } from './sources.ts'
import { type PanelStore, sourcesFingerprint } from './store.ts'

export interface ToolDeps {
  readonly ctx: Context
  readonly store: PanelStore
  readonly hub: DataHub
  readonly refresher: AgentRefresher | undefined
  readonly limits: Limits
  readonly autoApprove: boolean
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

function describeSources(sources: readonly PanelSource[]): string {
  return sources.map(source => source.kind === 'command'
    ? `• [${source.id}] 每 ${source.intervalSec} 秒运行命令：${source.command}`
    : `• [${source.id}] 每 ${source.intervalSec} 秒请求：${source.method ?? 'GET'} ${source.url}`).join('\n')
}

function panelSummary(panel: PanelRecord, store: PanelStore, refresher: AgentRefresher | undefined, hub: DataHub): Json {
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
    waitingForApproval: !store.approved(panel),
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

  async function askToRun(exec: ToolRunContext, toolName: string, title: string, sources: readonly PanelSource[]): Promise<boolean> {
    if (sources.length === 0 || deps.autoApprove) return true
    const approval = ctx.get('approval')
    if (approval === undefined || exec.agent === undefined) return false
    const reason = `面板「${title}」要在这台机器上运行：\n${describeSources(sources)}`
    const outcome = await approval.request({
      agent: exec.agent,
      toolName,
      callId: exec.callId,
      reason,
      displayReason: { en: `Panel "${title}" wants to run on this machine:\n${describeSources(sources)}`, zh: reason },
      signal: exec.signal,
    })
    return outcome === 'allowed-once'
  }

  function readingsReport(readings: readonly { id: string, ok: boolean, value?: Json, error?: string }[]): string[] {
    return readings.map(r => r.ok ? `- ${r.id}: ✓ ${sample(r.value)}` : `- ${r.id}: ✗ ${r.error}`)
  }

  async function firstReadings(panel: PanelRecord): Promise<string[]> {
    if (panel.definition.sources.length === 0) return []
    if (!store.approved(panel)) {
      return ['数据源还没被允许运行：已在面板上显示「允许运行」，用户点了之后才会开始取数。告诉用户这一点。']
    }
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

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'pad_list',
    description: '列出悬浮面板坞里的所有面板（id、标题、数据源、最近的错误、AI 刷新状态）。改面板、修面板前先调用。',
    parameters: {},
    output: textOutput,
    isConcurrencySafe: () => true,
    async execute() {
      const panels = store.list().map(p => panelSummary(p, store, refresher, hub))
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
    description: '试跑一个数据源（不保存），返回真实输出。写面板脚本前先用它看清输出格式。需要用户允许。',
    parameters: { source: { ...sourceItem, required: true } },
    output: textOutput,
    async execute(args, exec) {
      const probe = validate({ title: 'test', html: '', css: '', script: '', height: 'auto', sources: [{ intervalSec: limits.minIntervalSec, ...(args.source as Record<string, unknown>) }] })
      const source = probe.sources[0]!
      if (!(await askToRun(exec, 'pad_test_source', '试跑数据源', [source]))) throw new Error('用户没有允许运行这个数据源')
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
    name: 'pad_create',
    description: `在悬浮面板坞里新建一张面板。\n\n${PANEL_GUIDE}`,
    parameters: {
      title: { type: 'string', required: true, description: '简短标题（≤40 字）' },
      icon: { type: 'string', description: '一个 emoji' },
      html: { type: 'string', required: true, description: '面板 body 内的 HTML' },
      css: { type: 'string', description: '面板样式，用 --pad-* 变量' },
      script: { type: 'string', description: '面板脚本，用 dsh.onData 渲染' },
      height: { oneOf: [{ type: 'string', enum: ['auto'] }, { type: 'integer' }], description: '"auto"（默认，跟随内容）或固定像素高度' },
      sources: { type: 'array', items: sourceItem, description: '直接数据源（可以为空）' },
      model: modelSelection,
      agent: agentBlock,
      data: { type: 'json', description: 'AI 刷新面板的第一版数据（你刚取到的真实数据）' },
    },
    output: textOutput,
    async execute(args, exec) {
      const definition = validate({ css: '', script: '', height: 'auto', sources: [], ...args })
      if (definition.model) await assertModel(ctx, definition.model)
      const duplicate = store.list().find(p => p.definition.title === definition.title)
      let panel = await store.create(definition, args.data as Json | undefined)
      if (!store.approved(panel) && await askToRun(exec, 'pad_create', definition.title, definition.sources)) {
        await store.approve(panel.id, sourcesFingerprint(definition.sources))
        panel = store.get(panel.id)
      }
      const lines = [`已创建面板 ${panel.id}「${definition.title}」，已经出现在悬浮面板坞。`]
      if (duplicate) lines.push(`注意：已有同名面板 ${duplicate.id}，如果是重复创建请用 pad_delete 删掉一张。`)
      lines.push(...await firstReadings(panel))
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
    },
    output: textOutput,
    async execute(args, exec) {
      const current = store.get(args.id)
      const { id, data, ...fields } = args
      const changesDefinition = Object.keys(fields).length > 0
      if (!changesDefinition) {
        if (data === undefined) throw new Error('没有要改的字段')
        await store.setAgentData(id, data as Json)
        hub.pushData(id)
        return `已更新面板「${current.definition.title}」的数据。`
      }
      const definition = validate({ ...current.definition, ...fields })
      if (definition.model) await assertModel(ctx, definition.model)
      let panel = await store.update(id, definition, data as Json | undefined)
      if (!store.approved(panel) && await askToRun(exec, 'pad_update', definition.title, definition.sources)) {
        await store.approve(panel.id, sourcesFingerprint(definition.sources))
        panel = store.get(panel.id)
      }
      const sourcesChanged = sourcesFingerprint(current.definition.sources) !== sourcesFingerprint(definition.sources)
      return [
        `已更新面板 ${panel.id}「${definition.title}」（版本 ${panel.version}）。`,
        ...(sourcesChanged ? await firstReadings(panel) : []),
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
