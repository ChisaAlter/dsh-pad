/**
 * The document a panel's iframe runs: the host theme tokens, the base styles,
 * the design kit, the panel's own CSS, its HTML, then the frame runtime and the
 * panel's script.
 *
 * Kept apart from `PanelFrame.tsx` so the document can be built — and asserted
 * on — without a browser: the kit is injected here, and a regression that drops
 * it would quietly take the whole design system out of every panel.
 *
 * Stylesheet order is the contract: theme → base → kit → the panel's own CSS.
 * A panel may override a kit rule; nothing else may override a panel.
 */
import { FRAME_RUNTIME } from './frame-runtime.ts'
import { PANEL_KIT_CSS } from '../shared/kit.ts'
import type { Json, PanelData, PanelView } from '../shared/types.ts'
import type { ThemeSnapshot } from './theme.ts'

const CSP = "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:"

const BASE_CSS = `*,*::before,*::after{box-sizing:border-box}
html,body{margin:0;padding:0;background:transparent;color:var(--pad-fg);font:13px/1.45 var(--pad-font);-webkit-font-smoothing:antialiased}
html[data-height=auto]{overflow-x:hidden;overflow-y:auto}
body{padding:2px 0 4px}
a{color:var(--pad-accent);text-decoration:none}
a:hover{text-decoration:underline dotted;text-underline-offset:3px}
::-webkit-scrollbar{width:6px;height:6px}::-webkit-scrollbar-thumb{background:var(--pad-border);border-radius:3px}`

/** One point of a source's trend, as the panel script sees it. */
export interface DocHistoryPoint {
  readonly at: string
  readonly value: Json
}

export interface FrameDocumentInput {
  readonly view: PanelView
  readonly token: string
  readonly theme: ThemeSnapshot
  readonly data: PanelData
  readonly histories: Readonly<Record<string, readonly DocHistoryPoint[]>>
  /** UI state the panel saved through `dsh.state`, restored on load. */
  readonly state: Readonly<Record<string, unknown>>
  readonly lang: string
  /** Height the user dragged the card to; a set height means the frame does not auto-size. */
  readonly viewHeight?: number
}

/**
 * Build the panel document.
 * @param input - panel, token, theme, data and saved state.
 * @returns a self-contained HTML document for `srcDoc`.
 */
export function frameDocument({ view, token, theme, data, histories, state, lang, viewHeight }: FrameDocumentInput): string {
  const { definition } = view
  const init = JSON.stringify({ data, histories, state, lang }).replace(/</g, '\\u003c')
  const css = definition.css.replace(/<\/style/gi, '<\\/style')
  const script = definition.script.replace(/<\/script/gi, '<\\/script')
  return `<!doctype html>
<html data-token="${token}" data-mode="${theme.mode}" data-height="${definition.height === 'auto' && viewHeight === undefined ? 'auto' : 'fixed'}" lang="${lang}">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${CSP}">
<style id="pad-theme">${theme.css}</style>
<style>${BASE_CSS}</style>
<style id="pad-kit">${PANEL_KIT_CSS}</style>
<style>${css}</style>
<script type="application/json" id="pad-init">${init}</script>
</head>
<body>
${definition.html}
<script>${FRAME_RUNTIME}</script>
<script>${script}
//# sourceURL=dsh-pad/${view.id}.js</script>
</body>
</html>`
}
