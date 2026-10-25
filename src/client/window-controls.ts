/** Keep floating UI clear of the desktop shell's always-on-top window buttons. */
import type { Point } from './pad-client.ts'

export interface WindowControls {
  readonly left: number
  readonly top: number
  readonly right: number
  readonly bottom: number
}

export interface Viewport {
  readonly width: number
  readonly height: number
  readonly controls?: WindowControls
}

export const WINDOW_CONTROL_GAP = 8
const CONTROLS_ID = 'dshd-shell-controls'

export function readViewport(): Viewport {
  const viewport = { width: window.innerWidth, height: window.innerHeight }
  const controls = document.getElementById(CONTROLS_ID)
  if (controls !== null) {
    const rect = controls.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0 || getComputedStyle(controls).visibility === 'hidden') return viewport
    return { ...viewport, controls: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom } }
  }
  // The shell can publish these insets before inserting its controls. Plain
  // web pages and macOS native controls do not reserve this right-hand corner.
  if (document.documentElement.dataset.platform === 'darwin') return viewport
  const style = getComputedStyle(document.documentElement)
  const width = Number.parseFloat(style.getPropertyValue('--dshd-wco-controls'))
  const height = Number.parseFloat(style.getPropertyValue('--dshd-wco-caption'))
  return width > 0 && height > 0
    ? { ...viewport, controls: { left: viewport.width - width, top: 0, right: viewport.width, bottom: height } }
    : viewport
}

/** The shell injects controls asynchronously and can hide them in fullscreen. */
export function watchViewport(update: () => void): () => void {
  let controls: HTMLElement | null = null
  const attributes = new MutationObserver(update)
  const resize = new ResizeObserver(update)
  const attach = (): void => {
    const next = document.getElementById(CONTROLS_ID)
    if (next === controls) return
    controls = next
    attributes.disconnect()
    resize.disconnect()
    attributes.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class', 'data-platform'] })
    if (controls !== null) {
      attributes.observe(controls, { attributes: true, attributeFilter: ['style', 'class', 'hidden'] })
      resize.observe(controls)
    }
    update()
  }
  attributes.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class', 'data-platform'] })
  const insertion = new MutationObserver(records => {
    if (records.some(record => [...record.addedNodes, ...record.removedNodes].some(node =>
      node instanceof Element && (node.id === CONTROLS_ID || node.querySelector(`#${CONTROLS_ID}`) !== null)))) attach()
  })
  insertion.observe(document.documentElement, { childList: true, subtree: true })
  window.addEventListener('resize', update)
  attach()
  update()
  return () => {
    attributes.disconnect()
    resize.disconnect()
    insertion.disconnect()
    window.removeEventListener('resize', update)
  }
}

export function overlapsWindowControls(point: Point, width: number, height: number, controls?: WindowControls): boolean {
  return controls !== undefined
    && point.x < controls.right + WINDOW_CONTROL_GAP && point.x + width > controls.left - WINDOW_CONTROL_GAP
    && point.y < controls.bottom + WINDOW_CONTROL_GAP && point.y + height > controls.top - WINDOW_CONTROL_GAP
}

/** Minimum top for a dock that extends under the right-hand window controls. */
export function dockSafeTop(x: number, width: number, viewport: Viewport, margin: number): number {
  const controls = viewport.controls
  return controls !== undefined && x < controls.right + WINDOW_CONTROL_GAP && x + width > controls.left - WINDOW_CONTROL_GAP
    ? Math.max(margin, Math.ceil(controls.bottom + WINDOW_CONTROL_GAP)) : margin
}

/** Move a ball out by the shortest available axis, retaining an attached edge. */
export function avoidWindowControls(point: Point, size: number, viewport: Viewport, margin: number, along?: 'horizontal' | 'vertical'): Point {
  const controls = viewport.controls
  if (controls === undefined || !overlapsWindowControls(point, size, size, controls)) return point
  const left = Math.floor(controls.left - WINDOW_CONTROL_GAP - size)
  const below = Math.ceil(controls.bottom + WINDOW_CONTROL_GAP)
  const canMoveLeft = left >= margin
  const canMoveDown = below + size <= viewport.height - margin
  if (canMoveLeft && (along === 'horizontal' || !canMoveDown || (along !== 'vertical' && point.x - left < below - point.y))) {
    return { x: left, y: point.y }
  }
  if (canMoveDown) return { x: point.x, y: below }
  return point
}
