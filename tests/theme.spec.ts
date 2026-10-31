import { afterEach, describe, expect, it, vi } from 'vitest'
import { readTheme } from '../src/client/theme.ts'

/** `readTheme` only asks `getComputedStyle` for the element, so any node will do. */
const element = {} as unknown as Element

/** Answer `getComputedStyle` like the dsh theme tree would. */
function stubStyle(color: string, tokens: Record<string, string> = {}, fontFamily = 'Inter, sans-serif'): void {
  vi.stubGlobal('getComputedStyle', () => ({
    color,
    fontFamily,
    getPropertyValue: (name: string): string => tokens[name] ?? '',
  }))
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('theme snapshot', () => {
  it('reads the mode from a hex ink token, which is what this host emits', () => {
    // dsh hands the label token back as hex. Reading only rgb() left the mode
    // undefined, the guess fell to "light", and a light ink landed on a white
    // card: pale text on white.
    stubStyle('rgb(0, 0, 0)', { '--dsw-alias-label-primary': '#f9fafb' })
    const theme = readTheme(element)
    expect(theme.mode).toBe('dark')
    expect(theme.css).toContain('--pad-fg:#f9fafb')
    expect(theme.css).toContain('--pad-bg:#232326')
  })

  it('keeps the surface in the ink mode when the host exposes a light background', () => {
    stubStyle('rgb(0, 0, 0)', {
      '--dsw-alias-label-primary': '#f9fafb',
      '--dsw-alias-bg-layer-1': '#ffffff',
    })
    const theme = readTheme(element)
    expect(theme.mode).toBe('dark')
    // The white bg token would put light ink on white; the mode's own surface wins.
    expect(theme.css).toContain('--pad-bg:#232326')
    expect(theme.css).not.toContain('--pad-bg:#ffffff')
  })

  it('reads dark from a light-on-dark foreground colour', () => {
    stubStyle('rgb(233, 233, 236)')
    expect(readTheme(element).mode).toBe('dark')
  })

  it('reads light from a dark foreground colour', () => {
    stubStyle('rgb(31, 35, 41)')
    expect(readTheme(element).mode).toBe('light')
  })

  it('maps the host tokens onto --pad-* names', () => {
    stubStyle('rgb(31, 35, 41)', {
      '--dsw-alias-label-primary': '#101010',
      '--dsw-alias-label-tertiary': '#909090',
      '--dsw-alias-brand-primary': '#123456',
    })
    const { css } = readTheme(element)
    expect(css).toContain('--pad-fg:#101010')
    expect(css).toContain('--pad-fg-3:#909090')
    expect(css).toContain('--pad-accent:#123456')
  })

  it('falls back to the light palette when the host exposes no tokens', () => {
    stubStyle('rgb(31, 35, 41)')
    const { css } = readTheme(element)
    expect(css).toContain('--pad-fg:#1f2329')
    expect(css).toContain('--pad-accent:#4d6bfe')
    expect(css).toContain('--pad-radius:8px')
    expect(css).toContain('--pad-font:Inter, sans-serif')
  })

  it('falls back to the dark palette on a dark host', () => {
    stubStyle('rgb(233, 233, 236)')
    expect(readTheme(element).css).toContain('--pad-accent:#7c93ff')
  })

  it('keeps color-scheme off :root so the iframe canvas stays transparent', () => {
    // A root-level scheme makes the browser paint the frame's canvas opaque,
    // which puts every panel on a slab instead of over the card.
    const modes = [['rgb(31, 35, 41)', 'light'], ['rgb(233, 233, 236)', 'dark']] as const
    for (const [color, mode] of modes) {
      stubStyle(color)
      const { css } = readTheme(element)
      expect(/:root\{([^}]*)\}/.exec(css)?.[1] ?? '').not.toContain('color-scheme')
      expect(css).toContain(`body{color-scheme:${mode}}`)
    }
  })
})
