/** Lifecycle classification for sandboxed panel iframe load events. */

export type FrameLoadKind = 'initial' | 'navigated'

/** Recoveries allowed for one panel definition before the frame is left dead. */
export const MAX_FRAME_RECOVERIES = 3

/**
 * The first load of a generated srcDoc document is the document itself; any
 * subsequent load for the same document instance is an unexpected navigation.
 */
export function classifyFrameLoad(loadsSoFar: number): FrameLoadKind {
  return loadsSoFar <= 0 ? 'initial' : 'navigated'
}

/**
 * A panel that navigates on every load would otherwise remount forever: give
 * each definition a small recovery budget and then stop rebuilding it.
 */
export function shouldRecoverFrame(recoveries: number): boolean {
  return recoveries < MAX_FRAME_RECOVERIES
}
