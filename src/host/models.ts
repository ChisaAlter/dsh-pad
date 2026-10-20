/**
 * The per-panel model picker's Host side: project the live LLM registry into a
 * small catalog, and check a chosen provider/model before it is stored.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { PanelModelCatalog, PanelModelProvider, PanelModelSelection } from '../shared/types.ts'

interface LlmService {
  listProviders(): readonly { readonly id: string, readonly name: string }[]
  listModels(provider: string): Promise<readonly { readonly id: string, readonly name: string, readonly description?: string }[]>
  resolveModelInfo(provider: string, model: string): Promise<{
    readonly reasoning?: {
      readonly efforts: readonly { readonly id: string, readonly name: string }[]
      readonly defaultEffort?: string
    }
  }>
}

interface DefaultModelService {
  currentSelection(): { readonly provider: string, readonly model: string, readonly reasoningEffort?: string } | undefined
}

function llmOf(ctx: Context): LlmService | undefined {
  return ctx.get('llm') as LlmService | undefined
}

function defaultOf(ctx: Context): PanelModelSelection | null {
  const selection = (ctx.get('agentDefaultModel') as DefaultModelService | undefined)?.currentSelection()
  if (selection === undefined) return null
  return {
    provider: selection.provider,
    model: selection.model,
    ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
  }
}

/**
 * Build the model picker catalog from the running LLM registry.
 * @param ctx - Host context.
 * @returns the deployment default plus non-empty provider groups.
 */
export async function modelCatalog(ctx: Context): Promise<PanelModelCatalog> {
  const fallback = defaultOf(ctx)
  const llm = llmOf(ctx)
  if (llm === undefined) return { default: fallback, providers: [] }
  const providers = await Promise.all(llm.listProviders().map(async (provider): Promise<PanelModelProvider | undefined> => {
    try {
      const models = await llm.listModels(provider.id)
      const options = await Promise.all(models.map(async model => {
        let reasoning: { readonly efforts: readonly { readonly id: string, readonly name: string }[], readonly defaultEffort?: string } | undefined
        try {
          reasoning = (await llm.resolveModelInfo(provider.id, model.id)).reasoning
        } catch {
          // Reasoning metadata is optional; the model itself is still selectable.
        }
        return {
          id: model.id,
          name: model.name,
          ...(model.description === undefined ? {} : { description: model.description }),
          ...(reasoning === undefined || reasoning.efforts.length === 0
            ? {}
            : {
                reasoningEfforts: reasoning.efforts.map(effort => ({ id: effort.id, name: effort.name })),
                ...(reasoning.defaultEffort === undefined ? {} : { defaultReasoningEffort: reasoning.defaultEffort }),
              }),
        }
      }))
      return options.length === 0 ? undefined : { id: provider.id, name: provider.name, models: options }
    } catch {
      return undefined
    }
  }))
  return {
    default: fallback,
    providers: providers.filter((provider): provider is PanelModelProvider => provider !== undefined),
  }
}

/**
 * Fail with a model list when a panel's explicit refresh model is not routable.
 * @param ctx - Host context.
 * @param selection - the chosen provider/model.
 */
export async function assertModel(ctx: Context, selection: PanelModelSelection): Promise<void> {
  const llm = llmOf(ctx)
  if (llm === undefined) throw new Error('这个 dsh 组合没有 llm 服务，不能指定面板模型')
  const providers = llm.listProviders()
  if (!providers.some(provider => provider.id === selection.provider)) {
    throw new Error(`没有 provider「${selection.provider}」。可用：${providers.map(provider => provider.id).join(', ') || '无'}`)
  }
  let models: readonly { readonly id: string }[]
  try {
    models = await llm.listModels(selection.provider)
  } catch (error) {
    throw new Error(`读取 provider「${selection.provider}」的模型失败：${error instanceof Error ? error.message : String(error)}`)
  }
  if (!models.some(model => model.id === selection.model)) {
    throw new Error(`provider「${selection.provider}」下没有模型「${selection.model}」。可用：${models.map(model => model.id).join(', ') || '无'}`)
  }
  if (selection.reasoningEffort !== undefined) {
    let reasoning: { readonly efforts: readonly { readonly id: string }[] } | undefined
    try {
      reasoning = (await llm.resolveModelInfo(selection.provider, selection.model)).reasoning
    } catch (error) {
      throw new Error(`读取模型「${selection.model}」的推理强度失败：${error instanceof Error ? error.message : String(error)}`)
    }
    const efforts = reasoning?.efforts ?? []
    if (!efforts.some(effort => effort.id === selection.reasoningEffort)) {
      throw new Error(`模型「${selection.model}」不支持推理强度「${selection.reasoningEffort}」。可用：${efforts.map(effort => effort.id).join(', ') || '无'}`)
    }
  }
}
