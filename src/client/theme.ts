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
  /**
   * The frame's token sheet: a `:root { … }` block for the `--pad-*` values,
   * plus the mode's `color-scheme` scoped to `body` (never `:root`).
   */
  readonly css: string
}

/** Relative luminance of a CSS color string, or undefined if it can't be parsed. */
function luminance(color: string): number | undefined {
  const value = color.trim()
  if (value === '') return undefined
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value)
  if (hex !== null) {
    const raw = hex[1] ?? ''
    const h = raw.length === 3 ? raw.replace(/./g, c => c + c) : raw
    const r = Number.parseInt(h.slice(0, 2), 16) / 255
    const g = Number.parseInt(h.slice(2, 4), 16) / 255
    const b = Number.parseInt(h.slice(4, 6), 16) / 255
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
  }
  const match = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(value)
  if (match === null) return undefined
  const [r, g, b] = [match[1], match[2], match[3]].map(v => Number(v) / 255) as [number, number, number]
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** Luminance of a background that is actually painted (alpha ≥ half), else undefined. */
function sheetLuminance(color: string): number | undefined {
  const alpha = /^rgba\([^)]*?[,/]\s*([\d.]+)\s*\)$/.exec(color.trim())
  if (alpha !== null && Number(alpha[1]) < 0.5) return undefined
  return luminance(color)
}

/** The mode a marker string names, when it names exactly one. */
function markerMode(text: string): 'light' | 'dark' | undefined {
  const value = text.toLowerCase()
  const dark = /\bdark\b/.test(value)
  const light = /\blight\b/.test(value)
  return dark === light ? undefined : dark ? 'dark' : 'light'
}

/** `getComputedStyle` that answers `{}` instead of throwing when there is no DOM. */
function styleOf(element: Element | null | undefined): CSSStyleDeclaration | undefined {
  if (element === null || element === undefined) return undefined
  try {
    return getComputedStyle(element)
  } catch {
    return undefined
  }
}

/**
 * Which mode the host is rendering in.
 *
 * The dock sets its own `color` from a token with a light fallback, so the
 * dock's own computed colour cannot be trusted — when dsh's `--dsw-*` aliases
 * do not resolve, every component falls back to the light palette and the
 * dock would answer "light" inside a dark app. Read, in order: an explicit
 * theme marker on html/body, the used `color-scheme`, the page's own text
 * colour, then the OS preference.
 * @param element - an element inside the themed tree (used as the last resort).
 * @returns the mode to build the frame's tokens for.
 */
export function detectMode(element: Element): 'light' | 'dark' {
  const doc = element.ownerDocument
  const roots = [doc?.documentElement, doc?.body]
  for (const root of roots) {
    if (root === null || root === undefined) continue
    const marker = `${root.getAttribute('data-color-scheme') ?? ''} ${root.getAttribute('data-theme') ?? ''} ${typeof root.className === 'string' ? root.className : ''}`
    const named = markerMode(marker)
    if (named !== undefined) return named
  }
  const scheme = markerMode(styleOf(doc?.documentElement)?.colorScheme ?? '')
  if (scheme !== undefined) return scheme
  // A painted page background is the clearest statement of the mode.
  for (const root of roots) {
    const painted = sheetLuminance(styleOf(root)?.backgroundColor ?? '')
    if (painted !== undefined) return painted > 0.5 ? 'light' : 'dark'
  }
  const text = luminance(styleOf(doc?.body ?? element)?.color ?? '')
  if (text !== undefined) return text > 0.5 ? 'dark' : 'light'
  if (typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches) return 'dark'
  return 'light'
}

/**
 * Read the current theme from an element inside dsh's themed tree.
 *
 * The mode is derived from the text colour the host actually resolved, because
 * that ink is what the panel will be painted in: light ink means a dark surface,
 * always. Reading the mode from anything else lets the two disagree — which is
 * exactly how a panel ends up with pale text on a white card.
 *
 * Surfaces ignore the host's own background tokens: `--dsw-alias-bg-layer-*`
 * resolve to nothing (or to white) in this app, so the mode's own surface is the
 * only value that can be trusted to match the ink.
 * @param element - any element that inherits dsh's theme variables.
 * @returns the snapshot.
 */
export function readTheme(element: Element): ThemeSnapshot {
  const style = getComputedStyle(element)
  const ink = style.getPropertyValue('--dsw-alias-label-primary').trim()
  const inkLuminance = luminance(ink)
  // No resolvable ink means nothing to compare against: fall back to structure.
  const mode = inkLuminance === undefined
    ? detectMode(element)
    : inkLuminance > 0.5 ? 'dark' : 'light'
  const fallback = FALLBACK[mode]
  const lines: string[] = []
  for (const [name, token, key] of TOKENS) {
    const custom = CUSTOM_FALLBACK[name]
    const modeValue = custom === undefined ? fallback[key] : mode === 'dark' ? custom[1] : custom[0]
    // Surfaces come from the mode; ink and accents follow the host when present.
    const followsHost = name !== '--pad-bg' && name !== '--pad-bg-2' && name !== '--pad-border'
    const hostValue = followsHost ? style.getPropertyValue(token).trim() : ''
    lines.push(`${name}:${hostValue === '' ? modeValue : hostValue};`)
  }
  lines.push(`--pad-font:${style.fontFamily || 'system-ui, sans-serif'};`)
  lines.push('--pad-mono:ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;')
  lines.push('--pad-radius:8px;')
  // `color-scheme` is set on body, never on :root: a root-level scheme makes
  // the browser paint the frame's canvas opaque (black in dark mode), and the
  // panel then sits on a slab instead of over the dock's translucent card.
  return { mode, css: `:root{${lines.join('')}}body{color-scheme:${mode}}` }
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
