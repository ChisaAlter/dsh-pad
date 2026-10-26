/** Bounded incremental history transfer from the dock to a panel iframe. */
import type { HistoryPoint } from './pad-client.ts'

type Histories = Record<string, readonly HistoryPoint[]>

export class HistorySync {
  private readonly sent = new Map<string, Map<string, HistoryPoint>>()

  /** Mark a complete snapshot already embedded/sent with the frame document. */
  reset(histories: Histories): void {
    this.sent.clear()
    for (const [id, points] of Object.entries(histories)) {
      this.sent.set(id, new Map(points.map(point => [point.at, point])))
    }
  }

  /** Only new points cross the frame boundary after its initial snapshot. */
  delta(histories: Histories): Histories {
    const delta: Histories = {}
    for (const id of this.sent.keys()) if (!(id in histories)) this.sent.delete(id)
    for (const [id, points] of Object.entries(histories)) {
      const previous = this.sent.get(id)
      const changed = points.filter(point => {
        const sent = previous?.get(point.at)
        return sent === undefined || (sent !== point && JSON.stringify(sent.value) !== JSON.stringify(point.value))
      })
      if (changed.length > 0) delta[id] = changed
      this.sent.set(id, new Map(points.map(point => [point.at, point])))
    }
    return delta
  }
}
