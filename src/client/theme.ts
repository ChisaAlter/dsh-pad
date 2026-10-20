/**
 * The panel iframe has an opaque origin and cannot read dsh's stylesheets, so
 * the dock snapshots the resolved theme tokens it needs and hands them to the
 * frame as `--pad-*` variables. The snapshot is re-taken when the document's
 * theme attributes change.
 */

/** Fallbacks per mode, used while the theme's own tokens are not resolvable yet. */
const FALLBACK = {
  light: { fg: '#1f2329', fg2: '#545a63', fg3: '#8a9099', bg: '#ffffff', bg2: 'rgba(0,0,0,.06)', border: 'rgba(0,0,0,.1)' },
  dark: { fg: '#e9e9ec', fg2: '#b7b9bf', fg3: '#8e9198', bg: '#232326', bg2: 'rgba(255,255,255,.08)', border: 'rgba(255,255,255,.14)' },
} as const

/** `--pad-*` variable → dsh token it follows, and the fallback key it uses. */
const TOKENS: ReadonlyArray<readonly [string, string, keyof typeof FALLBACK['light']]> = [
  ['--pad-fg', '--dsw-alias-label-primary', 'fg'],
  ['--pad-fg-2', '--dsw-alias-label-secondary', 'fg2'],
  ['--pad-fg-3', '--dsw-alias-label-tertiary', 'fg3'],
  ['--pad-bg', '--dsw-alias-bg-layer-1', 'bg'],
  ['--pad-bg-2', '--dsw-alias-interactive-bg-hover', 'bg2'],
  ['--pad-border', '--dsw-alias-border-l1', 'border'],
  ['--pad-accent', '--dsw-alias-brand-primary', 'fg'],
  ['--pad-ok', '--dsw-alias-state-success-primary', 'fg'],
  ['--pad-warn', '--dsw-alias-state-warn-primary', 'fg'],
  ['--pad-danger', '--dsw-alias-state-error-primary', 'fg'],
]

/** Tokens whose own fallback is a colour, not the text colour. */
const CUSTOM_FALLBACK: Readonly<Record<string, readonly [string, string]>> = {
  '--pad-accent': ['#4d6bfe', '#7c93ff'],
  '--pad-ok': ['#22a06b', '#3ddc97'],
  '--pad-warn': ['#d97706', '#f5a524'],
  '--pad-danger': ['#e5484d', '#ff6369'],
}

export interface ThemeSnapshot {
  readonly mode: 'light' | 'dark'
  /** A `:root { … }` rule for the frame. */
  readonly css: string
}

/** Relative luminance of a CSS color string, or undefined if it can't be parsed. */
function luminance(color: string): number | undefined {
  const match = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(color)
  if (match === null) return undefined
  const [r, g, b] = [match[1], match[2], match[3]].map(v => Number(v) / 255) as [number, number, number]
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/**
 * Read the current theme from an element inside dsh's themed tree.
 *
 * Fallbacks are picked for the mode the element already renders in, so a
 * snapshot taken before the theme's stylesheets apply still produces legible
 * panels instead of dark text on a dark card.
 * @param element - any element that inherits dsh's theme variables.
 * @returns the snapshot.
 */
export function readTheme(element: Element): ThemeSnapshot {
  const style = getComputedStyle(element)
  const fg = luminance(style.color)
  const mode = fg !== undefined && fg > 0.5 ? 'dark' : 'light'
  const fallback = FALLBACK[mode]
  const lines: string[] = []
  for (const [name, token, key] of TOKENS) {
    const custom = CUSTOM_FALLBACK[name]
    const missing = custom === undefined ? fallback[key] : mode === 'dark' ? custom[1] : custom[0]
    const value = style.getPropertyValue(token).trim() || missing
    lines.push(`${name}:${value};`)
  }
  lines.push(`--pad-font:${style.fontFamily || 'system-ui, sans-serif'};`)
  lines.push('--pad-mono:ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;')
  lines.push('--pad-radius:8px;')
  lines.push(`color-scheme:${mode};`)
  return { mode, css: `:root{${lines.join('')}}` }
}

/**
 * Watch for theme changes on the document root and body.
 * @param onChange - called (debounced to a frame) after a relevant attribute changed.
 * @returns the disconnect function.
 */
export function watchTheme(onChange: () => void): () => void {
  let frame = 0
  const schedule = (): void => {
    cancelAnimationFrame(frame)
    frame = requestAnimationFrame(onChange)
  }
  const observer = new MutationObserver(schedule)
  const options = { attributes: true, attributeFilter: ['class', 'style', 'data-theme', 'data-color-scheme'] }
  observer.observe(document.documentElement, options)
  if (document.body) observer.observe(document.body, options)
  const media = matchMedia('(prefers-color-scheme: dark)')
  media.addEventListener('change', schedule)
  // Stylesheets can land after the dock mounted without touching these
  // attributes, so retry a few times while the page settles.
  const timers = [setTimeout(schedule, 250), setTimeout(schedule, 1000), setTimeout(schedule, 2500)]
  return () => {
    observer.disconnect()
    media.removeEventListener('change', schedule)
    for (const timer of timers) clearTimeout(timer)
    cancelAnimationFrame(frame)
  }
}
