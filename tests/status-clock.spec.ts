import { afterEach, describe, expect, it, vi } from 'vitest'
import { statusTime, subscribeStatusTime } from '../src/client/status-clock.ts'

afterEach(() => { vi.useRealTimers() })

describe('relative-time clock', () => {
  it('shares one timer across labels and stops when nobody watches', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-23T12:00:00Z'))
    const a = vi.fn(), b = vi.fn()
    const stopA = subscribeStatusTime(a), stopB = subscribeStatusTime(b)
    try {
      expect(vi.getTimerCount()).toBe(1)
      vi.advanceTimersByTime(10_000)
      expect(a).toHaveBeenCalledOnce()
      expect(b).toHaveBeenCalledOnce()
      expect(statusTime()).toBe(Date.now())
      stopA()
      expect(vi.getTimerCount()).toBe(1)
      stopB()
      expect(vi.getTimerCount()).toBe(0)
    } finally { stopA(); stopB() }
  })
})
