/**
 * dsh-pad, Host half: panel store, data-source polling, background agent
 * refresh, the pad_* tools and the `/api/dsh-pad.*` routes. The browser half
 * (the floating dock) ships as `./client` and is found through the
 * `dsh.client` declaration in package.json.
 */
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-client-connection'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-tools'
import Schema from '@deepseek-ai/schemastery'
import { AgentRefresher } from './host/agent-refresh.ts'
import { DataHub } from './host/hub.ts'
import { ReadingCache } from './host/readings.ts'
import { registerRoutes } from './host/routes.ts'
import { PanelStore } from './host/store.ts'
import { registerTools } from './host/tools.ts'
import { readPluginVersion, UpdateService } from './host/update.ts'

export const name = 'dsh-pad'
export const inject = ['tools', 'connection']

export interface Config {
  /** Where panels are stored. Defaults to `$DSH_HOME/dsh-pad/panels.json`. */
  dataFile?: string
  /** Shortest poll interval for direct sources, in seconds. */
  minIntervalSec: number
  /** Allow panels refreshed by a background agent turn. */
  agentRefresh: boolean
  /** Shortest agent refresh interval, in minutes. */
  minAgentMinutes: number
  /** Upper bound for one background refresh turn, in seconds. */
  agentTimeoutSec: number
  /** Background refresh turns allowed at the same time. */
  agentConcurrency: number
  /** Delay before retrying a failed agent refresh, in minutes. */
  agentRetryMinutes: number
  /** Allow a panel's own buttons to call the panel model via `dsh.run`. */
  interactiveModel: boolean
  /** Upper bound for one `dsh.run` call, in seconds. */
  runTimeoutSec: number
  /** Max output tokens for one `dsh.run` call. */
  runMaxTokens: number
  /** Concurrent `dsh.run` calls allowed for one panel. */
  runConcurrency: number
  /** Check the GitHub release feed in the background. */
  updateCheck: boolean
  /** Hours between automatic update checks. */
  updateCheckHours: number
}

export const Config: Schema<Config> = Schema.object({
  dataFile: Schema.string().description('面板存储文件，默认 $DSH_HOME/dsh-pad/panels.json'),
  minIntervalSec: Schema.natural().min(1).default(2).description('直接数据源的最短刷新间隔（秒）'),
  agentRefresh: Schema.boolean().default(true).description('允许由后台 AI 定时刷新的面板'),
  minAgentMinutes: Schema.natural().min(1).default(15).description('AI 刷新的最短间隔（分钟）'),
  agentTimeoutSec: Schema.natural().min(30).default(300).description('一次 AI 刷新最多用多久（秒）'),
  agentConcurrency: Schema.natural().min(1).default(1).description('同时进行的 AI 刷新数'),
  agentRetryMinutes: Schema.natural().min(1).default(15).description('AI 刷新失败后多久重试（分钟）'),
  interactiveModel: Schema.boolean().default(true).description('允许面板里的按钮通过 dsh.run 调用这张面板的模型'),
  runTimeoutSec: Schema.natural().min(5).max(300).default(120).description('一次 dsh.run 最多用多久（秒）'),
  runMaxTokens: Schema.natural().min(128).default(2048).description('一次 dsh.run 最多生成多少 token'),
  runConcurrency: Schema.natural().min(1).max(8).default(2).description('同一张面板同时进行的 dsh.run 数量'),
  updateCheck: Schema.boolean().default(true).description('启动后在后台检查 dsh-pad 的 GitHub 最新 Release'),
  updateCheckHours: Schema.natural().min(1).max(168).default(6).description('自动检查更新的间隔（小时）'),
})

function defaultDataFile(): string {
  const home = process.env['DSH_HOME'] || join(homedir(), '.dsh')
  return join(home, 'dsh-pad', 'panels.json')
}

/**
 * Host plugin body.
 *
 * The load must never take the Host down: a panel dock is a convenience, and a
 * broken install has to degrade to "no dock" instead of "dsh will not start".
 * Cordis contains activation failures and rolls back the plugin's effects.
 * Report failures to it so a failed dock cannot retain live routes or timers.
 * @param ctx - Host context with `tools` and `connection`.
 * @param config - resolved plugin config.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  try {
    await start(ctx, config)
  } catch (error) {
    console.error('[dsh-pad] 插件启动失败，正在回滚面板坞，dsh 继续启动。在插件目录运行 `node scripts/doctor.mjs` 自检：', error)
    throw error
  }
}

/**
 * Register the store, hub, schedulers, routes and tools.
 * @param ctx - Host context.
 * @param config - resolved plugin config.
 */
async function start(ctx: Context, config: Config): Promise<void> {
  const dataFile = config.dataFile ?? defaultDataFile()
  const store = new PanelStore(dataFile)
  await store.load()

  // The newest reading of every source is kept next to the panels, so a
  // restarted dsh paints the last values instead of waiting for the first poll.
  // Entries of edited or deleted sources are dropped on load and on every store
  // change, and oversized values are never cached.
  const cache = new ReadingCache(join(dirname(dataFile), 'readings.json'))
  const restored = await cache.load(store.list())

  const resolveSecret = async (name: string): Promise<string | undefined> => {
    const credentials = ctx.get('credentials')
    if (credentials !== undefined) {
      try {
        const resolved = await credentials.resolve(name as CredentialRef)
        if (resolved !== undefined) return resolved.value
      } catch {
        // Not a valid reference for the provider; fall back to the process environment.
      }
    }
    return process.env[name]
  }

  let refresher: AgentRefresher | undefined
  const hub = new DataHub(store, resolveSecret, panelId => refresher?.request(panelId), { restored, cache })
  if (config.agentRefresh) {
    refresher = new AgentRefresher(ctx, store, {
      timeoutMs: config.agentTimeoutSec * 1000,
      concurrency: config.agentConcurrency,
      retryMinutes: config.agentRetryMinutes,
      workDir: join(dirname(dataFile), 'refresh'),
    }, panelId => hub.pushData(panelId))
  }

  ctx.effect(() => store.onChange(() => hub.storeChanged()), 'dsh-pad: store observer')
  ctx.effect(() => {
    refresher?.start()
    return () => {
      refresher?.stop()
      hub.dispose()
      cache.dispose()
    }
  }, 'dsh-pad: schedulers')

  const root = fileURLToPath(new URL('../', import.meta.url))
  const update = new UpdateService({
    current: await readPluginVersion(root),
    root,
    enabled: config.updateCheck,
    checkHours: config.updateCheckHours,
  })
  ctx.effect(() => {
    update.start()
    return () => update.dispose()
  }, 'dsh-pad: updater')

  registerRoutes({
    ctx,
    store,
    hub,
    refresher,
    update,
    runOptions: {
      enabled: config.interactiveModel,
      timeoutMs: config.runTimeoutSec * 1000,
      maxTokens: config.runMaxTokens,
      concurrency: config.runConcurrency,
      maxPromptChars: 24_000,
      maxSystemChars: 8_000,
      maxOutputChars: 32_000,
      minIntervalMs: 1000,
    },
  })
  registerTools({
    ctx,
    store,
    hub,
    refresher,
    limits: { minIntervalSec: config.minIntervalSec, minAgentMinutes: config.minAgentMinutes },
    resolveSecret,
  })
}
