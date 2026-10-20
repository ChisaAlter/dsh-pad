/**
 * Validation of model-authored panel definitions. Every problem is reported
 * at once, in words the model can act on, so one retry can fix them all.
 */
import type { AgentRefresh, PanelDefinition, PanelModelSelection, PanelSource, SourceParse } from './types.ts'

export interface Limits {
  /** Shortest poll interval for direct sources. */
  readonly minIntervalSec: number
  /** Shortest agent refresh interval. */
  readonly minAgentMinutes: number
}

export const MAX_SOURCES = 8
export const MAX_CODE_BYTES = 200_000
export const MAX_TITLE = 40
const SOURCE_ID = /^[a-z][a-z0-9_]{0,31}$/
const PARSES: readonly SourceParse[] = ['text', 'json', 'lines']

export class PanelValidationError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`面板定义有 ${problems.length} 处问题：\n- ${problems.join('\n- ')}`)
    this.name = 'PanelValidationError'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function intIn(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
}

function checkSource(raw: unknown, index: number, limits: Limits, problems: string[]): PanelSource | undefined {
  const at = `sources[${index}]`
  if (!isRecord(raw)) {
    problems.push(`${at} 必须是对象`)
    return undefined
  }
  const { id, kind, parse, intervalSec, timeoutMs } = raw
  const before = problems.length
  if (typeof id !== 'string' || !SOURCE_ID.test(id)) problems.push(`${at}.id 必须是小写字母开头的标识符（a-z0-9_，≤32 字符）`)
  if (typeof parse !== 'string' || !PARSES.includes(parse as SourceParse)) problems.push(`${at}.parse 只能是 text / json / lines`)
  if (!intIn(intervalSec, limits.minIntervalSec, 86_400)) problems.push(`${at}.intervalSec 必须是 ${limits.minIntervalSec}–86400 的整数`)
  if (timeoutMs !== undefined && !intIn(timeoutMs, 500, 60_000)) problems.push(`${at}.timeoutMs 必须是 500–60000 的整数`)
  const common = {
    id: id as string,
    parse: parse as SourceParse,
    intervalSec: intervalSec as number,
    ...(timeoutMs === undefined ? {} : { timeoutMs: timeoutMs as number }),
  }
  if (kind === 'command') {
    const { command } = raw
    if (typeof command !== 'string' || command.trim() === '' || command.length > 2000) {
      problems.push(`${at}.command 必须是非空字符串（≤2000 字符）`)
    }
    return problems.length === before ? { ...common, kind, command: command as string } : undefined
  }
  if (kind === 'http') {
    const { url, method, headers, body } = raw
    let parsed: URL | undefined
    try {
      parsed = typeof url === 'string' ? new URL(url) : undefined
    } catch {
      parsed = undefined
    }
    if (parsed === undefined || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
      problems.push(`${at}.url 必须是 http(s) 网址`)
    }
    if (method !== undefined && method !== 'GET' && method !== 'POST') problems.push(`${at}.method 只能是 GET / POST`)
    if (headers !== undefined) {
      if (!isRecord(headers) || Object.keys(headers).length > 20 || Object.values(headers).some(v => typeof v !== 'string')) {
        problems.push(`${at}.headers 必须是字符串到字符串的对象（≤20 项）`)
      }
    }
    if (body !== undefined && (typeof body !== 'string' || body.length > 20_000)) problems.push(`${at}.body 必须是字符串（≤20000 字符）`)
    if (problems.length !== before) return undefined
    return {
      ...common,
      kind,
      url: url as string,
      ...(method === undefined ? {} : { method: method as 'GET' | 'POST' }),
      ...(headers === undefined ? {} : { headers: headers as Record<string, string> }),
      ...(body === undefined ? {} : { body: body as string }),
    }
  }
  problems.push(`${at}.kind 只能是 command / http`)
  return undefined
}

function checkAgent(raw: unknown, limits: Limits, problems: string[]): AgentRefresh | null | undefined {
  if (raw === undefined) return undefined
  if (raw === null) return null
  if (!isRecord(raw)) {
    problems.push('agent 必须是对象或 null')
    return undefined
  }
  const { instruction, everyMinutes } = raw
  const before = problems.length
  if (typeof instruction !== 'string' || instruction.trim() === '' || instruction.length > 4000) {
    problems.push('agent.instruction 必须是非空字符串（≤4000 字符）')
  }
  if (!intIn(everyMinutes, limits.minAgentMinutes, 10_080)) {
    problems.push(`agent.everyMinutes 必须是 ${limits.minAgentMinutes}–10080 的整数`)
  }
  return problems.length === before ? { instruction: instruction as string, everyMinutes: everyMinutes as number } : undefined
}

/**
 * Check the panel's own model selection.
 * @param raw - candidate `model` field.
 * @param problems - problem accumulator.
 * @returns the normalized selection, or undefined when absent/invalid.
 */
function checkModel(raw: unknown, problems: string[]): PanelModelSelection | undefined {
  if (raw === undefined || raw === null) return undefined
  if (!isRecord(raw)) {
    problems.push('model 必须是 { provider, model, reasoningEffort? } 或 null')
    return undefined
  }
  const before = problems.length
  const provider = raw['provider']
  const id = raw['model']
  const effort = raw['reasoningEffort']
  if (typeof provider !== 'string' || provider.trim() === '' || provider.length > 120) {
    problems.push('model.provider 必须是非空字符串（≤120 字符）')
  }
  if (typeof id !== 'string' || id.trim() === '' || id.length > 200) {
    problems.push('model.model 必须是非空字符串（≤200 字符）')
  }
  if (effort !== undefined && (typeof effort !== 'string' || effort.length > 120)) {
    problems.push('model.reasoningEffort 必须是字符串（≤120 字符）')
  }
  return problems.length === before
    ? {
        provider: provider as string,
        model: id as string,
        ...(effort === undefined ? {} : { reasoningEffort: effort as string }),
      }
    : undefined
}

/**
 * Check a complete definition.
 * @param raw - candidate definition, typically a merge of stored fields and tool arguments.
 * @param limits - deployment limits.
 * @returns the normalized definition.
 * @throws {PanelValidationError} listing every problem.
 */
export function validateDefinition(raw: Record<string, unknown>, limits: Limits): PanelDefinition {
  const problems: string[] = []
  const { title, icon, html, css, script, height, sources, agent, model } = raw
  if (typeof title !== 'string' || title.trim() === '' || [...title].length > MAX_TITLE) {
    problems.push(`title 必须是 1–${MAX_TITLE} 字的字符串`)
  }
  if (icon !== undefined && (typeof icon !== 'string' || [...icon].length > 4)) problems.push('icon 只能是一个 emoji')
  for (const [key, value] of [['html', html], ['css', css], ['script', script]] as const) {
    if (typeof value !== 'string') problems.push(`${key} 必须是字符串（可以为空）`)
  }
  const codeBytes = [html, css, script].reduce<number>(
    (sum, part) => sum + (typeof part === 'string' ? new TextEncoder().encode(part).length : 0), 0)
  if (codeBytes > MAX_CODE_BYTES) problems.push(`html + css + script 合计不能超过 ${MAX_CODE_BYTES} 字节（现在 ${codeBytes}）`)
  if (height !== 'auto' && !intIn(height, 60, 1200)) problems.push('height 必须是 "auto" 或 60–1200 的整数像素')

  const checkedSources: PanelSource[] = []
  if (!Array.isArray(sources)) {
    problems.push('sources 必须是数组（没有数据源就传 []）')
  } else {
    if (sources.length > MAX_SOURCES) problems.push(`sources 最多 ${MAX_SOURCES} 个`)
    sources.forEach((source, index) => {
      const checked = checkSource(source, index, limits, problems)
      if (checked !== undefined) checkedSources.push(checked)
    })
    const ids = checkedSources.map(source => source.id)
    const duplicate = ids.find((id, index) => ids.indexOf(id) !== index)
    if (duplicate !== undefined) problems.push(`sources 里的 id「${duplicate}」重复了`)
  }
  const checkedAgent = checkAgent(agent, limits, problems)
  const checkedModel = checkModel(model, problems)

  if (problems.length > 0) throw new PanelValidationError(problems)
  return {
    title: (title as string).trim(),
    ...(icon === undefined || icon === '' ? {} : { icon: icon as string }),
    html: html as string,
    css: css as string,
    script: script as string,
    height: height as number | 'auto',
    sources: checkedSources,
    ...(checkedModel === undefined ? {} : { model: checkedModel }),
    ...(checkedAgent === undefined ? {} : { agent: checkedAgent }),
  }
}
