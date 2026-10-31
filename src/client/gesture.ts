/** One owned pointer gesture: cancellation never commits an unfinished edit. */
export interface GestureStart {
  readonly pointerId: number
  readonly currentTarget: Element
}

export interface GestureHandlers {
  readonly move?: (event: PointerEvent) => void
  readonly end: (event: PointerEvent) => void
  readonly cancel: () => void
}

/** React-free so the same lifecycle guards serve dock and iframe resize handles. */
export class PointerGestures {
  private active: (() => void) | undefined

  /** End any previous gesture before acquiring this pointer and its listeners. */
  start(event: GestureStart, handlers: GestureHandlers): void {
    this.cancel()
    const target = event.currentTarget
    const doc = target.ownerDocument ?? document
    const win = doc.defaultView
    if (doc.visibilityState === 'hidden') {
      handlers.cancel()
      return
    }
    const pointerId = event.pointerId
    let live = true
    const finish = (pointer?: PointerEvent): void => {
      if (!live) return
      live = false
      if (this.active === cancel) this.active = undefined
      doc.removeEventListener('pointermove', move)
      doc.removeEventListener('pointerup', up)
      doc.removeEventListener('pointercancel', cancelled)
      doc.removeEventListener('lostpointercapture', lostCapture)
      doc.removeEventListener('visibilitychange', visibility)
      target.removeEventListener('lostpointercapture', cancelled)
      win?.removeEventListener('blur', cancel)
      // Remove lost-capture supervision before releasing our own capture.
      try {
        if (target.hasPointerCapture?.(pointerId)) target.releasePointerCapture(pointerId)
      } catch {
        // Detached/synthetic elements need no release; listeners are already gone.
      }
      if (pointer === undefined) handlers.cancel()
      else handlers.end(pointer)
    }
    const cancel = (): void => finish()
    const move = (pointer: PointerEvent): void => {
      if (pointer.pointerId === pointerId) handlers.move?.(pointer)
    }
    const up = (pointer: PointerEvent): void => {
      if (pointer.pointerId === pointerId) finish(pointer)
    }
    const cancelled = (pointer: Event): void => {
      if ((pointer as PointerEvent).pointerId === pointerId) cancel()
    }
    // A removed capture target may dispatch lostpointercapture on its document.
    const lostCapture = (pointer: Event): void => {
      if (pointer.target === doc || pointer.target === target) cancelled(pointer)
    }
    const visibility = (): void => {
      if (doc.visibilityState === 'hidden') cancel()
    }
    this.active = cancel
    doc.addEventListener('pointermove', move)
    doc.addEventListener('pointerup', up)
    doc.addEventListener('pointercancel', cancelled)
    doc.addEventListener('lostpointercapture', lostCapture)
    doc.addEventListener('visibilitychange', visibility)
    target.addEventListener('lostpointercapture', cancelled)
    win?.addEventListener('blur', cancel)
    try {
      target.setPointerCapture(pointerId)
    } catch {
      // Synthetic or already released pointers still use document supervision.
    }
  }

  /** Idempotent; called when the owner hides, unmounts or starts another gesture. */
  cancel(): void {
    this.active?.()
  }
}
