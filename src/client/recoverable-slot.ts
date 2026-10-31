/** Keep a dock integration alive across delayed setup and renderer retirement. */
import type { Context } from '@deepseek-ai/cordis'
import type { StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'

const RETRY_MS = 3000
const MAX_RETRY_MS = 60_000

/**
 * `slots.inject` follows declaration lifetimes, but permanently retires its
 * controller if delayed setup throws. A renderer error can also abdicate a list
 * entry while leaving it in `entries()`. Own these two recoveries explicitly;
 * keep the normal synchronous activation failure/rollback contract intact.
 */
export function recoverableSlot(ctx: Context, key: 'shell.overlay' | 'conversation.input.overlay', id: string, register: () => () => void): void {
  ctx.effect(() => {
    let activated = false
    let stopped = false
    let declared = false
    let disposeEntry: (() => void) | undefined
    let entry: StoredEntry | undefined
    let retry: ReturnType<typeof setTimeout> | undefined
    let failures = 0

    const cancelRetry = (): void => {
      clearTimeout(retry)
      retry = undefined
    }
    const release = (): void => {
      const dispose = disposeEntry
      disposeEntry = undefined
      entry = undefined
      dispose?.()
    }
    const schedule = (error: unknown): void => {
      if (stopped || !declared || retry !== undefined) return
      const delay = Math.min(MAX_RETRY_MS, RETRY_MS * 2 ** Math.min(failures++, 5))
      console.error(`[dsh-pad] ${key} 入口暂时不可用，${delay / 1000} 秒后重试：`, error)
      retry = setTimeout(() => {
        retry = undefined
        if (stopped || !declared) return
        release()
        install()
      }, delay)
    }
    const install = (): void => {
      try {
        disposeEntry = register()
        entry = ctx.slots.entries(key).find(candidate => candidate.options.id === id)
      } catch (error) {
        // A synchronous boot failure must still reach Cordis diagnostics.
        if (!activated) throw error
        schedule(error)
      }
    }
    const disposeInjection = ctx.slots.inject(key, () => {
      declared = true
      failures = 0
      install()
      return () => {
        declared = false
        cancelRetry()
        release()
      }
    })
    activated = true
    const unsubscribe = ctx.slots.onEntryError((slot, registration, error, info) => {
      if (slot === key && registration === entry && info.abdicated) schedule(error)
    })
    return () => {
      stopped = true
      cancelRetry()
      unsubscribe()
      disposeInjection()
      release()
    }
  }, `dsh-pad: recover ${key}`)
}
