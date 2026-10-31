/**
 * The panel kit: the design primitives every dsh-pad panel gets for free.
 *
 * The frame injects `PANEL_KIT_CSS` before the panel's own stylesheet, so a
 * panel can be built from `pad-*` classes instead of hand-rolled CSS. Every
 * rule reads a `--pad-*` token (see `client/theme.ts`), so light and dark
 * follow the host theme without the panel doing anything.
 *
 * `PANEL_KIT_VISUALS` is the class list the authoring lint treats as "this
 * panel shows something" — keep it in step with the classes below.
 */

/**
 * Class names that count as a visual anchor: a number set large, a meter, a
 * list, a status light, a chart. A panel with none of them is text only.
 */
export const PANEL_KIT_VISUALS = [
  'pad-metric',
  'pad-hero',
  'pad-item',
  'pad-list',
  'pad-meter',
  'pad-bar',
  'pad-spark',
  'pad-chart',
  'pad-status',
  'pad-chip',
  'pad-grid',
] as const

/** Class names the kit defines, for the authoring reference. */
export const PANEL_KIT_CSS = `
/* ── panel kit ───────────────────────────────────────────────────────────
   Composition, type and data primitives. Colour comes only from --pad-*
   tokens; nothing here assumes a background, so it works in both modes. */
.pad-stack{display:flex;flex-direction:column;gap:14px;min-width:0}
.pad-stack.is-tight{gap:7px}
.pad-split{display:flex;align-items:center;justify-content:space-between;gap:10px;min-width:0}
.pad-grid{display:grid;gap:12px 14px;grid-template-columns:repeat(auto-fit,minmax(84px,1fr));min-width:0}
.pad-sep{height:1px;background:var(--pad-border);border:0;margin:0}
.pad-num{font-variant-numeric:tabular-nums;font-feature-settings:"tnum" 1}

.pad-label{display:block;font-size:11px;line-height:1.45;font-weight:500;color:var(--pad-fg-3)}
.pad-title{display:block;font-size:12px;line-height:1.5;font-weight:600;color:var(--pad-fg-2)}
.pad-text{font-size:12.5px;line-height:1.6;color:var(--pad-fg-2);text-wrap:pretty;margin:0}
.pad-muted{color:var(--pad-fg-3)}
.pad-figure{font-size:15px;line-height:1.25;font-weight:600;color:var(--pad-fg);font-variant-numeric:tabular-nums}

/* one number, set large */
.pad-hero{display:flex;flex-direction:column;gap:4px;align-items:flex-start;min-width:0}
.pad-hero .pad-metric-value{font-size:2.6em}
.pad-metric{display:flex;flex-direction:column;gap:3px;min-width:0}
.pad-metric-value{font-size:max(24px,1.85em);line-height:1;font-weight:600;letter-spacing:-.025em;color:var(--pad-fg);font-variant-numeric:tabular-nums;white-space:nowrap}
.pad-metric-value.is-sm{font-size:1.45em}
.pad-metric-value.is-lg{font-size:2.25em}
.pad-unit{font-size:12px;line-height:1;font-weight:500;color:var(--pad-fg-3);margin-left:4px;letter-spacing:0}
.pad-foot{font-size:11px;line-height:1.5;color:var(--pad-fg-3);font-variant-numeric:tabular-nums}
.pad-delta{font-size:11px;line-height:1.5;font-weight:600;font-variant-numeric:tabular-nums}
.pad-delta.is-up{color:var(--pad-ok)}
.pad-delta.is-down{color:var(--pad-danger)}
.pad-delta.is-flat{color:var(--pad-fg-3)}

/* rows: name left, figure right, meter underneath */
.pad-list{display:flex;flex-direction:column;min-width:0}
.pad-item{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:baseline;column-gap:10px;row-gap:5px;padding:8px 0;border-top:1px solid var(--pad-border);min-width:0}
.pad-item:first-child{border-top:0;padding-top:0}
.pad-item:last-child{padding-bottom:0}
.pad-item-name{font-size:12.5px;line-height:1.4;color:var(--pad-fg-2);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pad-item-value{font-size:12.5px;line-height:1.4;font-weight:600;color:var(--pad-fg);font-variant-numeric:tabular-nums;text-align:right;white-space:nowrap}
.pad-item-foot,.pad-item>.pad-meter,.pad-item>.pad-bar{grid-column:1/-1}

/* completion, level, share */
.pad-meter{display:block;height:3px;border-radius:2px;background:var(--pad-bg-2);overflow:hidden}
.pad-meter>i{display:block;height:100%;border-radius:inherit;background:var(--pad-accent);transition:width .35s ease}
.pad-bar{display:block;height:7px;border-radius:4px;background:var(--pad-bg-2);overflow:hidden}
.pad-bar>i{display:block;height:100%;border-radius:inherit;background:var(--pad-accent);transition:width .35s ease}
.pad-meter.is-ok>i,.pad-bar.is-ok>i{background:var(--pad-ok)}
.pad-meter.is-warn>i,.pad-bar.is-warn>i{background:var(--pad-warn)}
.pad-meter.is-danger>i,.pad-bar.is-danger>i{background:var(--pad-danger)}

/* trend line and any inline svg */
.pad-spark{display:block;line-height:0;min-width:0}
.pad-chart{display:block;width:100%;min-width:0}
.pad-spark>svg,.pad-chart>svg{display:block;width:100%;height:auto;overflow:visible}

/* state: a dot and a word, never an emoji */
.pad-status{display:inline-flex;align-items:center;gap:5px;font-size:11.5px;line-height:1.5;color:var(--pad-fg-2);white-space:nowrap}
.pad-status::before{content:"";flex:none;width:6px;height:6px;border-radius:50%;background:var(--pad-fg-3)}
.pad-status.is-ok::before{background:var(--pad-ok)}
.pad-status.is-warn::before{background:var(--pad-warn)}
.pad-status.is-danger::before{background:var(--pad-danger)}
.pad-status.is-live::before{animation:pad-pulse 1.9s ease-in-out infinite}
@keyframes pad-pulse{50%{opacity:.3}}

.pad-chip{display:inline-flex;align-items:center;gap:4px;padding:0 6px;border-radius:999px;background:var(--pad-bg-2);font-size:11px;line-height:18px;color:var(--pad-fg-2);font-variant-numeric:tabular-nums;white-space:nowrap}
.pad-chip.is-ok{color:var(--pad-ok)}
.pad-chip.is-warn{color:var(--pad-warn)}
.pad-chip.is-danger{color:var(--pad-danger)}

.pad-action{display:inline-flex;align-items:center;gap:4px;height:22px;padding:0 9px;border:1px solid var(--pad-border);border-radius:999px;background:transparent;color:var(--pad-fg-2);font:inherit;font-size:11.5px;cursor:pointer}
.pad-action:hover{background:var(--pad-bg-2);color:var(--pad-fg)}
.pad-action:focus-visible{outline:2px solid var(--pad-accent);outline-offset:2px}
.pad-action[disabled]{opacity:.45;cursor:progress}

.pad-empty{padding:10px 0;font-size:12px;line-height:1.6;color:var(--pad-fg-3)}
.pad-alert{position:relative;padding-left:9px;font-size:11.5px;line-height:1.55;color:var(--pad-danger)}
.pad-alert::before{content:"";position:absolute;left:0;top:2px;bottom:2px;width:2px;border-radius:1px;background:currentColor;opacity:.75}

@media (prefers-reduced-motion:reduce){
  .pad-meter>i,.pad-bar>i{transition:none}
  .pad-status.is-live::before{animation:none}
}
`
