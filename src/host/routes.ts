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
import { type PanelAction, type PanelModelSelection, type PanelView, type ReadingPoint, ROUTES, type StreamEvent } from '../shared/types.ts'
import type { AgentRefresher } from './agent-refresh.ts'
import type { DataHub, Subscriber } from './hub.ts'
import { assertModel, modelCatalog } from './models.ts'
import { PanelRunner, type PanelRunOptions } from './run.ts'
import { PanelNotFoundError, type PanelStore } from './store.ts'
import type { UpdateService } from './update.ts'

const HEARTBEAT_MS = 20_000
/** Total encoded backlog, including the frame held inside ReadableStream. */
export const MAX_SSE_QUEUED_BYTES = 8 * 1024 * 1024
export const SSE_STALL_MS = 30_000
/** Maximum concurrent SSE clients; exceeding it evicts the oldest stream. */
export const MAX_SSE_STREAMS = 32

interface SseFrame {
  readonly key: string
  readonly bytes: Uint8Array
}

function trimSnapshotHistoryToBudget(
  panels: readonly PanelView[],
  budget: number,
  encoder: TextEncoder,
): Uint8Array | undefined {
  const hasHistory = panels.some(panel => Object.values(panel.history).some(points => points.length > 0))
  if (!hasHistory) return undefined
  const barePanels = panels.map(panel => ({ ...panel, history: {} }))
  const bareBytes = encoder.encode(`data: ${JSON.stringify({ type: 'panels', panels: barePanels })}\n\n`)
  if (bareBytes.byteLength > budget) return undefined
  const remaining = budget - bareBytes.byteLength
  interface Cursor {
    readonly panelIndex: number
    readonly sourceId: string
    readonly points: readonly ReadingPoint[]
    nextFromEnd: number
    kept: ReadingPoint[]
    overhead: number
  }
  const cursors: Cursor[] = []
  for (let i = 0; i < panels.length; i += 1) {
    for (const [sourceId, points] of Object.entries(panels[i]!.history)) {
      if (points.length === 0) continue
      cursors.push({
        panelIndex: i,
        sourceId,
        points,
        nextFromEnd: points.length - 1,
        kept: [],
        overhead: encoder.encode(`${JSON.stringify(sourceId)}:[],`).byteLength,
      })
    }
  }
  let used = 0
  let progress = true
  while (progress) {
    progress = false
    for (const cursor of cursors) {
      if (cursor.nextFromEnd < 0) continue
      const point = cursor.points[cursor.nextFromEnd]!
      const cost = (cursor.kept.length === 0 ? cursor.overhead : 1) + encoder.encode(JSON.stringify(point)).byteLength
      if (used + cost <= remaining) {
        cursor.kept.push(point)
        cursor.nextFromEnd -= 1
        used += cost
        progress = true
      } else {
        cursor.nextFromEnd = -1
      }
    }
  }
  const trimmedPanels = barePanels.map(panel => ({ ...panel, history: {} as Record<string, readonly ReadingPoint[]> }))
  for (const cursor of cursors) {
    if (cursor.kept.length > 0) {
      trimmedPanels[cursor.panelIndex]!.history[cursor.sourceId] = cursor.kept.reverse()
    }
  }
  const trimmedBytes = encoder.encode(`data: ${JSON.stringify({ type: 'panels', panels: trimmedPanels })}\n\n`)
  return trimmedBytes.byteLength <= budget ? trimmedBytes : bareBytes
}

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
  readonly runner?: PanelRunner
  readonly update?: UpdateService
  readonly maxSseStreams?: number
}

/**
 * Register the routes; each registration is a Cordis effect removed on unload.
 * @param deps - services.
 */
export function registerRoutes({ ctx, store, hub, runOptions, runner: providedRunner, update, maxSseStreams = MAX_SSE_STREAMS }: RouteDeps): void {
  const connection = ctx.connection
  const runner = providedRunner ?? new PanelRunner(ctx, runOptions)
  const streams = new Set<() => void>()
  const sharedEncoder = new TextEncoder()
  const encodedEvents = new WeakMap<StreamEvent, Uint8Array>()
  const retryBytes = sharedEncoder.encode('retry: 3000\n\n')
  const heartbeatBytes = sharedEncoder.encode(': ping\n\n')
  const encodeSseEvent = (event: StreamEvent): Uint8Array => {
    let bytes = encodedEvents.get(event)
    if (bytes === undefined) {
      bytes = sharedEncoder.encode(`data: ${JSON.stringify(event)}\n\n`)
      encodedEvents.set(event, bytes)
    }
    return bytes
  }
  if (providedRunner === undefined) {
    ctx.effect(() => () => runner.dispose(), 'dsh-pad: model cleanup')
  }
  let knownPanelIds = new Set(store.list().map(panel => panel.id))
  ctx.effect(() => store.onChange(() => {
    const current = new Set(store.list().map(panel => panel.id))
    for (const id of knownPanelIds) {
      if (!current.has(id)) runner.forgetPanel(id)
    }
    knownPanelIds = current
  }), 'dsh-pad: runner panel cleanup')
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
      const limit = Math.max(1, maxSseStreams)
      let cleanup: (() => void) | undefined
      let drain: (() => void) | undefined
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          let open = true
          let unsubscribe: (() => void) | undefined
          let heartbeat: ReturnType<typeof setInterval> | undefined
          let stalled: ReturnType<typeof setTimeout> | undefined
          let queuedBytes = 0
          let streamBytes = 0
          const queue: SseFrame[] = []
          const close = (error?: Error): void => {
            if (!open) return
            open = false
            clearInterval(heartbeat)
            clearTimeout(stalled)
            queue.length = 0
            queuedBytes = 0
            streamBytes = 0
            unsubscribe?.()
            streams.delete(cleanup!)
            request.signal.removeEventListener('abort', cleanup!)
            try {
              // Erroring also discards the stream's internal queue on overflow.
              if (error !== undefined) controller.error(error)
              else controller.close()
            } catch {
              // Already closed by the consumer.
            }
          }
          cleanup = () => close()
          if (request.signal.aborted) {
            close()
            return
          }
          while (streams.size >= limit) {
            const oldest = streams.values().next().value
            if (oldest === undefined) break
            oldest()
          }
          streams.add(cleanup)
          request.signal.addEventListener('abort', cleanup, { once: true })
          const updateStall = (): void => {
            if (!open) return
            if (queue.length === 0 && (controller.desiredSize ?? 0) > 0) {
              clearTimeout(stalled)
              stalled = undefined
            } else if (stalled === undefined) {
              stalled = setTimeout(() => close(new Error('SSE 消费过慢，请重新连接')), SSE_STALL_MS)
            }
          }
          drain = (): void => {
            if (!open) return
            try {
              // highWaterMark 1 retains at most one frame inside ReadableStream;
              // account for it in the same byte budget as the coalescing queue.
              if ((controller.desiredSize ?? 0) > 0) streamBytes = 0
              while (queue.length > 0 && (controller.desiredSize ?? 0) > 0) {
                const frame = queue.shift()!
                queuedBytes -= frame.bytes.byteLength
                controller.enqueue(frame.bytes)
                streamBytes = (controller.desiredSize ?? 0) > 0 ? 0 : frame.bytes.byteLength
                clearTimeout(stalled)
                stalled = undefined
              }
              updateStall()
            } catch {
              close()
            }
          }
          const writeBytes = (key: string, bytes: Uint8Array): void => {
            if (!open) return
            const previous = queue.findIndex(frame => frame.key === key)
            if (previous >= 0) queuedBytes -= queue.splice(previous, 1)[0]!.bytes.byteLength
            if ((controller.desiredSize ?? 0) > 0) streamBytes = 0
            if (streamBytes + queuedBytes + bytes.byteLength > MAX_SSE_QUEUED_BYTES) {
              close(new Error('SSE 积压超过上限，请重新连接'))
              return
            }
            queue.push({ key, bytes })
            queuedBytes += bytes.byteLength
            drain?.()
          }
          const subscriber: Subscriber = {
            watch,
            close: () => close(new Error('SSE 推送失败，请重新连接')),
            send: (event: StreamEvent) => {
              if (!open) return
              try {
                // A new full snapshot supersedes every queued data update.
                let bytes = encodeSseEvent(event)
                if (event.type === 'panels') {
                  queue.length = 0
                  queuedBytes = 0
                  if ((controller.desiredSize ?? 0) > 0) streamBytes = 0
                  const budget = MAX_SSE_QUEUED_BYTES - streamBytes
                  if (bytes.byteLength > budget) {
                    const trimmed = trimSnapshotHistoryToBudget(event.panels, budget, sharedEncoder)
                    if (trimmed !== undefined) bytes = trimmed
                  }
                }
                writeBytes(event.type === 'data' ? `data:${event.panelId}` : 'panels', bytes)
              } catch {
                close(new Error('SSE 数据无法序列化，请重新连接'))
              }
            },
          }
          writeBytes('retry', retryBytes)
          unsubscribe = hub.subscribe(subscriber)
          if (!open) {
            unsubscribe()
            return
          }
          heartbeat = setInterval(() => writeBytes('heartbeat', heartbeatBytes), HEARTBEAT_MS)
        },
        pull() {
          drain?.()
        },
        cancel() {
          cleanup?.()
        },
      }, { highWaterMark: 1 })
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
            runner.forgetPanel(action.panelId)
            break
          case 'undo':
            await store.undo(action.panelId)
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
