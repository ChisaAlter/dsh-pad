/** Bounds for source JSON before it enters caches, streams or the browser. */
import type { Json } from '../shared/types.ts'

/** Leave ample stack space for the panel/data/history envelopes around a value. */
export const MAX_SOURCE_JSON_DEPTH = 64
/** Bound broad structures as well as deeply nested ones. */
export const MAX_SOURCE_JSON_NODES = 100_000

/**
 * Validate iteratively: JSON.parse accepts nesting that JSON.stringify cannot
 * serialize safely. This also rejects unsafe values from older reading caches.
 * @param value - parsed source JSON.
 * @throws when the value exceeds the source structure limits or is not JSON.
 */
export function assertSourceJson(value: unknown): asserts value is Json {
  const pending: Array<{ value: unknown, depth: number }> = [{ value, depth: 1 }]
  let nodes = 1
  while (pending.length > 0) {
    const current = pending.pop()!
    const child = current.value
    if (child === null || typeof child === 'string' || typeof child === 'boolean') continue
    if (typeof child === 'number' && Number.isFinite(child)) continue
    if (typeof child !== 'object' || child === null) throw new Error('输出包含不支持的 JSON 值')
    if (current.depth > MAX_SOURCE_JSON_DEPTH) throw new Error(`JSON 嵌套超过 ${MAX_SOURCE_JSON_DEPTH} 层，请先筛选数据`)
    const children = Object.values(child)
    nodes += children.length
    if (nodes > MAX_SOURCE_JSON_NODES) throw new Error(`JSON 节点超过 ${MAX_SOURCE_JSON_NODES} 个，请先筛选数据`)
    for (const value of children) pending.push({ value, depth: current.depth + 1 })
  }
}
