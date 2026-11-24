/** Pure helpers for validating and serializing per-panel UI state. */

export const STATE_PREFIX = 'dsh-pad:state:'
export const MAX_STATE_CHARS = 64 * 1024

const UNSAFE_STATE_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

/** Reject keys that could mutate Object.prototype or shadow object internals. */
export function isSafeStateKey(key: string): boolean {
  return !UNSAFE_STATE_KEYS.has(key)
}

/** Parse persisted state JSON; anything other than a plain object becomes `{}`. */
export function parsePanelState(raw: string | null): Record<string, unknown> {
  if (raw === null) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {}
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  const state: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(parsed)) {
    if (!isSafeStateKey(key)) continue
    state[key] = value
  }
  return state
}

/** Serialize panel state safely; returns `undefined` on stringify failure or overflow. */
export function encodePanelState(state: Record<string, unknown>): string | undefined {
  try {
    const text = JSON.stringify(state)
    return typeof text === 'string' && text.length <= MAX_STATE_CHARS ? text : undefined
  } catch {
    return undefined
  }
}
