/** Bounded incremental history transfer from the dock to a panel iframe. */
import type { HistoryPoint } from './pad-client.ts'

type Histories = Record<string, readonly HistoryPoint[]>

export class HistorySync {
  private readonly sent = new Map<string, string>()

  /** Mark a complete snapshot already embedded/sent with the frame document. */
  reset(histories: Histories): void {
    this.sent.clear()
    for (const [id, points] of Object.entries(histories)) {
      const last = points.at(-1)
      if (last !== undefined) this.sent.set(id, last.at)
    }
  }

  /** Only new points cross the frame boundary after its initial snapshot. */
  delta(histories: Histories): Histories {
    const delta: Histories = {}
    for (const [id, points] of Object.entries(histories)) {
      const last = points.at(-1)
      const previous = this.sent.get(id)
      if (last === undefined || last.at === previous) continue
      const index = previous === undefined ? -1 : points.findIndex(point => point.at === previous)
      delta[id] = points.slice(index + 1)
      this.sent.set(id, last.at)
    }
    return delta
  }
}
