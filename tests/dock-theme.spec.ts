import { afterEach, describe, expect, it, vi } from 'vitest'
import { detectMode, readTheme } from '../src/client/theme.ts'
import { DOCK_CSS } from '../src/client/styles.ts'

interface NodeSpec {
  attrs?: Record<string, string>
  className?: string
  color?: string
  colorScheme?: string
  background?: string
}

/** A page whose html/body carry the given attributes and computed styles. */
function page(rootSpec: NodeSpec, bodySpec: NodeSpec): { element: Element } {
  const styleFor = new Map<Element, NodeSpec>()
  const make = (spec: NodeSpec): Element => {
    const node = {
      getAttribute: (name: string): string | null => spec.attrs?.[name] ?? null,
      className: spec.className ?? '',
    } as unknown as Element
    styleFor.set(node, spec)
    return node
  }
  const documentElement = make(rootSpec)
  const body = make(bodySpec)
  vi.stubGlobal('getComputedStyle', (el: Element) => {
    const spec = styleFor.get(el) ?? {}
    return {
      color: spec.color ?? '',
      colorScheme: spec.colorScheme ?? 'normal',
      backgroundColor: spec.background ?? '',
      fontFamily: '',
      getPropertyValue: () => '',
    }
  })
  const element = { ownerDocument: { documentElement, body } } as unknown as Element
  return { element }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('detectMode', () => {
  it('believes an explicit theme marker on the document root', () => {
    const { element } = page({ attrs: { 'data-theme': 'deepseek.dark' } }, {})
    expect(detectMode(element)).toBe('dark')
  })

  it('reads a dark class on body', () => {
    const { element } = page({}, { className: 'app dark' })
    expect(detectMode(element)).toBe('dark')
  })

  it('prefers an explicit marker over the used color-scheme', () => {
    const { element } = page({ attrs: { 'data-color-scheme': 'light' }, colorScheme: 'dark' }, {})
    expect(detectMode(element)).toBe('light')
  })

  it('uses the used color-scheme when no marker exists', () => {
    const { element } = page({ colorScheme: 'dark' }, { color: 'rgb(31, 35, 41)' })
    expect(detectMode(element)).toBe('dark')
  })

  it('falls back to the page text colour, not the dock token', () => {
    // The dock paints its own text from a light fallback; reading that element
    // would make every dark app answer "light".
    const { element } = page({}, { color: 'rgb(233, 233, 236)' })
    expect(detectMode(element)).toBe('dark')
  })

  it('stays light when nothing says otherwise', () => {
    const { element } = page({}, { color: 'rgb(31, 35, 41)' })
    expect(detectMode(element)).toBe('light')
  })

  it('reads a painted dark page background as dark mode', () => {
    const { element } = page({ background: 'rgb(16, 18, 22)' }, { background: 'rgb(16, 18, 22)', color: 'rgb(0, 0, 0)' })
    expect(detectMode(element)).toBe('dark')
  })

  it('ignores a transparent page background', () => {
    const { element } = page({ background: 'rgba(0, 0, 0, 0)' }, { background: 'rgba(0, 0, 0, 0)', color: 'rgb(31, 35, 41)' })
    expect(detectMode(element)).toBe('light')
  })

  it('keeps the element colour as the last resort before the OS preference', () => {
    vi.stubGlobal('getComputedStyle', () => ({ color: 'rgb(233, 233, 236)', colorScheme: 'normal' }))
    expect(detectMode({} as Element)).toBe('dark')
  })
})

describe('theme snapshot', () => {
  it('builds the dark palette when the page is dark', () => {
    const { element } = page({ attrs: { 'data-theme': 'dark' } }, {})
    const snapshot = readTheme(element)
    expect(snapshot.mode).toBe('dark')
    expect(snapshot.css).toContain('--pad-fg:#e9e9ec')
    expect(snapshot.css).toContain('body{color-scheme:dark}')
    expect(/:root\{([^}]*)\}/.exec(snapshot.css)?.[1] ?? '').not.toContain('color-scheme')
  })
})

describe('dock surfaces', () => {
  it('carries a dark palette the dock switches to by attribute', () => {
    // Hard values on purpose: a missing (or light) --dsw-* alias must never be
    // able to turn a dark dock white again.
    expect(DOCK_CSS).toContain('.dshpad-root[data-mode=dark]')
    expect(DOCK_CSS).toMatch(/\[data-mode=dark\]\{[^}]*--dshpad-surface:#232326/)
    expect(DOCK_CSS).toMatch(/\[data-mode=dark\]\{[^}]*--dshpad-fg:#e9e9ec/)
    expect(DOCK_CSS).not.toMatch(/\[data-mode=dark\]\{[^}]*--dshpad-surface:var\(/)
  })

  it('keeps the dock mostly opaque so panel text holds its contrast', () => {
    expect(DOCK_CSS).toContain('var(--dshpad-surface) 88%')
    expect(DOCK_CSS).not.toContain('var(--dshpad-surface) 70%')
  })

  it('paints a card on an opaque surface instead of stacking alpha', () => {
    // Two translucent layers over a desktop backdrop are what turned panels
    // pale; the tint is composited onto the surface instead.
    expect(DOCK_CSS).toMatch(/\.dshpad-card\{[^}]*background-color:var\(--dshpad-surface\)/)
    expect(DOCK_CSS).toMatch(/\.dshpad-card\{[^}]*background-image:linear-gradient\(var\(--dshpad-card-tint\)/)
  })

  it('paints the frame with the surface instead of leaving it transparent', () => {
    // A transparent iframe inside the dock's compositing layer came up blank in
    // Electron: the element needs an opaque background of its own.
    expect(DOCK_CSS).toMatch(/\.dshpad-frame\{[^}]*background:var\(--dshpad-surface\)/)
    expect(DOCK_CSS).not.toMatch(/\.dshpad-frame\{[^}]*background:transparent/)
  })
})
