import { describe, expect, it } from 'vitest'
import { HistorySync } from '../src/client/history-sync.ts'

const point = (n: number) => ({ at: `2026-10-23T12:00:${String(n).padStart(2, '0')}.000Z`, value: n })

describe('incremental iframe history transfer', () => {
  it('does not resend a history snapshot embedded in the frame', () => {
    const sync = new HistorySync()
    const histories = { a: [point(1), point(2)] }
    sync.reset(histories)
    expect(sync.delta(histories)).toEqual({})
  })

  it('transfers only new points and preserves sources that did not change', () => {
    const sync = new HistorySync()
    sync.reset({ a: [point(1)], b: [point(2)] })
    expect(sync.delta({ a: [point(1), point(3), point(4)], b: [point(2)] })).toEqual({ a: [point(3), point(4)] })
    expect(sync.delta({ a: [point(1), point(3), point(4)], b: [point(2)] })).toEqual({})
  })

  it('sends backfilled points even when the latest timestamp is unchanged', () => {
    const sync = new HistorySync()
    sync.reset({ a: [point(1), point(3)] })
    expect(sync.delta({ a: [point(1), point(2), point(3)] })).toEqual({ a: [point(2)] })
    expect(sync.delta({ a: [point(1), point(2), point(3)] })).toEqual({})
  })

  it('sends a replacement value with the same timestamp only once', () => {
    const sync = new HistorySync()
    sync.reset({ a: [point(1)] })
    const changed = { a: [{ ...point(1), value: 9 }] }
    expect(sync.delta(changed)).toEqual(changed)
    expect(sync.delta(changed)).toEqual({})
  })

  it('resynchronizes a bounded ring when its previous point has expired', () => {
    const sync = new HistorySync()
    sync.reset({ a: [point(1)] })
    expect(sync.delta({ a: [point(9), point(10)] })).toEqual({ a: [point(9), point(10)] })
  })
})
