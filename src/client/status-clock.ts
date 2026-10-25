/** One lazy metadata clock, shared only by visible relative-time labels. */
const listeners = new Set<() => void>()
let timer: ReturnType<typeof setInterval> | undefined
let now = Date.now()

export function statusTime(): number { return now }

export function subscribeStatusTime(listener: () => void): () => void {
  listeners.add(listener)
  if (timer === undefined) {
    now = Date.now()
    timer = setInterval(() => {
      now = Date.now()
      for (const notify of listeners) notify()
    }, 10_000)
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) {
      clearInterval(timer)
      timer = undefined
    }
  }
}

export function subscribeNoStatusTime(): () => void { return () => {} }
