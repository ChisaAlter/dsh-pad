/**
 * Browser routes on dsh's authenticated `/api` channel (Connection applies
 * Host/Origin checks and browser authentication before these run):
 *
 * - GET  /api/dsh-pad.panels — panel list with latest data.
 * - GET  /api/dsh-pad.stream?watch=id,id — server-sent events; polling runs
 *   for the watched panels while the stream is open.
 * - POST /api/dsh-pad.action — user actions from the dock.
 * - GET  /api/dsh-pad.update — latest GitHub release vs the loaded version.
 * - POST /api/dsh-pad.update — `check` or `apply` (downloads the release).
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import { type PanelAction, type PanelModelSelection, ROUTES, type StreamEvent } from '../shared/types.ts'
import type { AgentRefresher } from './agent-refresh.ts'
import type { DataHub, Subscriber } from './hub.ts'
import { assertModel, modelCatalog } from './models.ts'
import { PanelRunner, type PanelRunOptions } from './run.ts'
import { PanelNotFoundError, type PanelStore } from './store.ts'
import type { UpdateService } from './update.ts'

const HEARTBEAT_MS = 20_000

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

function parseModel(value: unknown): PanelModelSelection | null | undefined {
  if (value === null) return null
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  const provider = record['provider']
  const model = record['model']
  const effort = record['reasoningEffort']
  if (typeof provider !== 'string' || provider.trim() === '' || provider.length > 120) return undefined
  if (typeof model !== 'string' || model.trim() === '' || model.length > 200) return undefined
  if (effort !== undefined && (typeof effort !== 'string' || effort.length > 120)) return undefined
  return {
    provider,
    model,
    ...(effort === undefined ? {} : { reasoningEffort: effort }),
  }
}

function parseAction(value: unknown): PanelAction | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const action = value as Record<string, unknown>
  if (typeof action['panelId'] !== 'string') return undefined
  switch (action['op']) {
    case 'refresh':
    case 'delete':
    case 'undo':
      return action as PanelAction
    case 'approve':
      return typeof action['fingerprint'] === 'string' ? action as PanelAction : undefined
    case 'collapse':
      return typeof action['collapsed'] === 'boolean' ? action as PanelAction : undefined
    case 'move':
      return action['delta'] === 1 || action['delta'] === -1 ? action as PanelAction : undefined
    case 'span':
      return action['span'] === 1 || action['span'] === 2 || action['span'] === 3 ? action as PanelAction : undefined
    case 'model': {
      const model = parseModel(action['model'])
      return model === undefined ? undefined : { op: 'model', panelId: action['panelId'], model }
    }
    default:
      return undefined
  }
}

export interface RouteDeps {
  readonly ctx: Context
  readonly store: PanelStore
  readonly hub: DataHub
  readonly refresher: AgentRefresher | undefined
  readonly runOptions?: PanelRunOptions
  readonly update?: UpdateService
}

/**
 * Register the routes; each registration is a Cordis effect removed on unload.
 * @param deps - services.
 */
export function registerRoutes({ ctx, store, hub, runOptions, update }: RouteDeps): void {
  const connection = ctx.connection
  const runner = new PanelRunner(ctx, runOptions)
  const streams = new Set<() => void>()
  ctx.effect(() => () => runner.dispose(), 'dsh-pad: model cleanup')
  ctx.effect(() => () => {
    for (const close of [...streams]) close()
    streams.clear()
  }, 'dsh-pad: stream cleanup')

  ctx.effect(() => connection.fetch.register({
    path: ROUTES.panels,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async () => json({ panels: hub.views() }),
  }), 'dsh-pad: panels route')

  ctx.effect(() => connection.fetch.register({
    path: ROUTES.stream,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const watchParam = new URL(request.url).searchParams.get('watch') ?? ''
      const watch = new Set(watchParam.split(',').map(id => id.trim()).filter(Boolean))
      const encoder = new TextEncoder()
      let cleanup: (() => void) | undefined
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          let open = true
          let unsubscribe: (() => void) | undefined
          let heartbeat: ReturnType<typeof setInterval> | undefined
          const close = (): void => {
            if (!open) return
            open = false
            clearInterval(heartbeat)
            unsubscribe?.()
            streams.delete(close)
            request.signal.removeEventListener('abort', close)
            try {
              controller.close()
            } catch {
              // Already closed by the consumer.
            }
          }
          cleanup = close
          if (request.signal.aborted) {
            close()
            return
          }
          streams.add(close)
          request.signal.addEventListener('abort', close, { once: true })
          const write = (text: string): void => {
            if (!open) return
            try {
              controller.enqueue(encoder.encode(text))
            } catch {
              close()
            }
          }
          const subscriber: Subscriber = {
            watch,
            send: (event: StreamEvent) => write(`data: ${JSON.stringify(event)}\n\n`),
          }
          write('retry: 3000\n\n')
          unsubscribe = hub.subscribe(subscriber)
          if (!open) {
            unsubscribe()
            return
          }
          heartbeat = setInterval(() => write(': ping\n\n'), HEARTBEAT_MS)
        },
        cancel() {
          cleanup?.()
        },
      })
      return new Response(body, {
        headers: {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store',
          'x-accel-buffering': 'no',
        },
      })
    },
  }), 'dsh-pad: stream route')

  ctx.effect(() => connection.fetch.register({
    path: ROUTES.models,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async () => json(await modelCatalog(ctx)),
  }), 'dsh-pad: models route')

  if (update !== undefined) {
    ctx.effect(() => connection.fetch.register({
      path: ROUTES.update,
      methods: ['GET', 'POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        if (request.method === 'GET') {
          const force = new URL(request.url).searchParams.get('force') === '1'
          return json(force ? await update.check(true) : await update.ensure())
        }
        let body: unknown
        try {
          body = await request.json()
        } catch {
          body = undefined
        }
        const action = typeof body === 'object' && body !== null ? (body as Record<string, unknown>)['action'] : undefined
        if (action === 'check') return json(await update.check(true))
        if (action === 'apply') return json(await update.apply())
        return json({ ok: false, error: 'unknown update action' }, 400)
      },
    }), 'dsh-pad: update route')
  }

  ctx.effect(() => connection.fetch.register({
    path: ROUTES.run,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      let body: unknown
      try {
        body = await request.json()
      } catch {
        body = undefined
      }
      if (typeof body !== 'object' || body === null) return json({ ok: false, error: 'bad request' }, 400)
      const record = body as Record<string, unknown>
      const panelId = record['panelId']
      const prompt = record['prompt']
      const system = record['system']
      if (typeof panelId !== 'string' || typeof prompt !== 'string') {
        return json({ ok: false, error: 'panelId 和 prompt 必须是字符串' }, 400)
      }
      if (system !== undefined && typeof system !== 'string') {
        return json({ ok: false, error: 'system 必须是字符串' }, 400)
      }
      const panel = store.find(panelId)
      if (panel === undefined) return json({ ok: false, error: '面板不存在' }, 404)
      const result = await runner.run(panel, prompt, system, request.signal)
      return json(result, result.ok ? 200 : 400)
    },
  }), 'dsh-pad: run route')

  ctx.effect(() => connection.fetch.register({
    path: ROUTES.action,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      let action: PanelAction | undefined
      try {
        action = parseAction(await request.json())
      } catch {
        action = undefined
      }
      if (action === undefined) return json({ ok: false, error: 'bad action' }, 400)
      try {
        switch (action.op) {
          case 'refresh':
            hub.refresh(action.panelId)
            break
          case 'delete':
            await store.remove(action.panelId)
            break
          case 'undo':
            await store.undo(action.panelId)
            break
          case 'approve':
            if (!(await store.approve(action.panelId, action.fingerprint))) {
              return json({ ok: false, error: '数据源已经变了，请重新确认' }, 409)
            }
            break
          case 'collapse':
            await store.setCollapsed(action.panelId, action.collapsed)
            break
          case 'move':
            await store.move(action.panelId, action.delta)
            break
          case 'span':
            await store.setSpan(action.panelId, action.span)
            break
          case 'model':
            if (action.model !== null) await assertModel(ctx, action.model)
            await store.setModel(action.panelId, action.model)
            break
        }
        return json({ ok: true })
      } catch (error) {
        const status = error instanceof PanelNotFoundError ? 404 : 409
        return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, status)
      }
    },
  }), 'dsh-pad: action route')
}
