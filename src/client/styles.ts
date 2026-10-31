/**
 * Dock styles. Injected once as `<style data-plugin="dsh-pad">` by the client
 * plugin and removed on unload. Colors, elevation and radii come from dsh's
 * semantic `--dsw-*` tokens (with fallbacks for older themes).
 */
export const DOCK_CSS = `
.dshpad-root{position:fixed;top:0;right:0;width:0;height:0;z-index:9000;
  --dshpad-fg:var(--dsw-alias-label-primary,#1f2329);
  --dshpad-fg-2:var(--dsw-alias-label-secondary,#545a63);
  --dshpad-fg-3:var(--dsw-alias-label-tertiary,#8a9099);
  --dshpad-surface:var(--dsw-alias-bg-layer-1,#fff);
  --dshpad-hover:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05));
  --dshpad-border:var(--dsw-alias-border-l1,rgba(0,0,0,.08));
  --dshpad-accent:var(--dsw-alias-brand-primary,#4d6bfe);
  --dshpad-danger:var(--dsw-alias-state-error-primary,#e5484d);
  --dshpad-warn:var(--dsw-alias-state-warn-primary,#d97706);
  --dshpad-ball-hi:color-mix(in srgb,var(--dshpad-surface) 90%,var(--dshpad-fg) 10%);
  --dshpad-card-tint:color-mix(in srgb,var(--dsw-alias-settings-card-fill,transparent) 55%,transparent);
  --dshpad-ease:cubic-bezier(.22,.8,.24,1);
  color:var(--dshpad-fg)}
/* When dsh's --dsw-* aliases do not resolve (or resolve to a light surface in
   a dark theme), every var() above lands on the light fallback and the dock
   turns white inside a dark app. The dock reports the mode it detected, and a
   dark mode gets a dark palette outright: a missing token must never be able to
   make a dark dock light. */
.dshpad-root[data-mode=dark]{
  --dshpad-fg:#e9e9ec;
  --dshpad-fg-2:#b7b9bf;
  --dshpad-fg-3:#8e9198;
  --dshpad-surface:#232326;
  --dshpad-hover:rgba(255,255,255,.08);
  --dshpad-border:rgba(255,255,255,.14);
  --dshpad-accent:#7c93ff;
  --dshpad-danger:#ff6369;
  --dshpad-warn:#f5a524;
  --dshpad-card-tint:rgba(255,255,255,.035)}
.dshpad-root svg{width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round}
.dshpad-root circle{fill:currentColor;stroke:none}
.dshpad-root button{font:inherit;color:inherit}
.dshpad-root.dshpad-recovery-root{width:min(340px,calc(100vw - 24px));height:auto;top:64px;right:12px}
.dshpad-recovery{display:flex;align-items:center;flex-wrap:wrap;gap:8px;padding:12px;border-radius:12px;background:var(--dshpad-surface);color:var(--dshpad-fg);box-shadow:inset 0 0 0 1px var(--dshpad-border);font:13px/18px system-ui,sans-serif;pointer-events:auto}
.dshpad-recovery strong{flex-basis:100%;overflow-wrap:anywhere}
.dshpad-recovery button{padding:4px 8px;border:1px solid var(--dshpad-border);border-radius:6px;background:var(--dshpad-hover);cursor:pointer}
.dshpad-recovery details{width:100%;font-size:12px;color:var(--dshpad-fg-2)}
.dshpad-recovery pre{margin:6px 0 0;white-space:pre-wrap;overflow-wrap:anywhere}

.dshpad-root #dshpad-ball{position:fixed!important;display:grid;place-items:center;width:28px!important;height:28px!important;padding:0!important;border:0!important;border-radius:0!important;background:none!important;box-shadow:none!important;clip-path:none!important;cursor:grab;touch-action:none;user-select:none;-webkit-user-select:none;-webkit-app-region:no-drag;overflow:visible!important;
  opacity:1!important;pointer-events:auto!important}
.dshpad-root .dshpad-ball-disc{display:block;width:28px!important;height:28px!important;overflow:visible;filter:drop-shadow(0 5px 14px rgba(0,0,0,.24))}
.dshpad-root .dshpad-ball-disc .dshpad-ball-fill{fill:url(#dshpad-ball-surface)!important;fill-opacity:1;stroke:var(--dsw-alias-border-l1,var(--dshpad-border))!important;stroke-width:1!important;transition:stroke .15s}
.dshpad-root .dshpad-ball-disc .dshpad-ball-stop-a{stop-color:var(--dshpad-ball-hi)!important}
.dshpad-root .dshpad-ball-disc .dshpad-ball-stop-b{stop-color:var(--dshpad-surface)!important}
.dshpad-root #dshpad-ball:active,.dshpad-root #dshpad-ball.is-dragging{cursor:grabbing}
.dshpad-root #dshpad-ball:focus-visible{outline:none}
.dshpad-root #dshpad-ball:focus-visible .dshpad-ball-fill{stroke:var(--dshpad-fg)!important;stroke-width:2!important}

/* One visible star for both states: it stays exactly where the ball / the
   header button is, while the surface around it cross-fades. */
.dshpad-root .dshpad-star-anchor{position:fixed;display:grid;place-items:center;width:28px;height:28px;pointer-events:none!important;z-index:3;color:var(--dshpad-fg-2)}
.dshpad-root .dshpad-star-anchor *{pointer-events:none!important}
.dshpad-root .dshpad-star-anchor svg{display:block;width:28px!important;height:28px!important;overflow:visible}
.dshpad-root .dshpad-star-anchor path{fill:currentColor!important;stroke:none!important}
.dshpad-root .dshpad-star-anchor.is-arrow path{fill:none!important;stroke:currentColor!important;stroke-width:1.8!important}
.dshpad-root:has(#dshpad-ball:hover) .dshpad-star-anchor,
.dshpad-root:has(.dshpad-collapse:hover) .dshpad-star-anchor{color:var(--dshpad-fg)}
.dshpad-root .dshpad-ball-transition{position:fixed;display:grid;place-items:center;width:28px;height:28px;pointer-events:none;z-index:2}
.dshpad-root .dshpad-ball-transition.is-opening{animation:dshpad-ball-out .2s var(--dshpad-ease) forwards}

.dshpad-collapse{position:absolute!important;top:2px!important;right:9px!important;display:grid;place-items:center;width:28px!important;height:28px!important;min-width:0!important;min-height:0!important;padding:0!important;border:0!important;border-radius:9px!important;box-sizing:border-box!important;cursor:pointer;touch-action:none;user-select:none;pointer-events:auto!important;
  background:transparent!important;color:var(--dshpad-fg-2)!important;transition:background-color .18s}
.dshpad-collapse.is-attached{left:var(--dshpad-control-x)!important;top:var(--dshpad-control-y)!important;right:auto!important;z-index:4;-webkit-app-region:no-drag}
.dshpad-collapse.is-attached:disabled{pointer-events:none!important}
.dshpad-collapse:hover{background:var(--dshpad-hover)!important}
.dshpad-collapse svg{display:block;width:28px!important;height:28px!important}
.dshpad-collapse-star{visibility:hidden}

.dshpad-dock{position:fixed;left:8px;top:52px;max-height:calc(100vh - 16px);max-width:calc(100vw - 16px);pointer-events:auto;display:flex;flex-direction:column;
  background:color-mix(in srgb, var(--dshpad-surface) 88%, transparent);border:0;border-radius:var(--dsw-radius-xl,16px);box-shadow:var(--dsw-elevation-panel,0 8px 28px rgba(0,0,0,.14));
  -webkit-backdrop-filter:blur(26px) saturate(1.45);backdrop-filter:blur(26px) saturate(1.45);
  font-size:13px;line-height:18px;animation:dshpad-dock-in .18s var(--dshpad-ease)}
.dshpad-dock.is-attached{border-radius:12px;max-height:calc(100vh - 2px)}
.dshpad-dock.is-attached .dshpad-dock-head{padding-left:var(--dshpad-head-left);padding-right:var(--dshpad-head-right)}
.dshpad-dock.is-attached-left.has-control-gutter .dshpad-list{margin-left:28px}
.dshpad-dock.is-attached-right.has-control-gutter .dshpad-list{margin-right:28px}
.dshpad-dock.is-attached-left.has-control-gutter>.dshpad-update,.dshpad-dock.is-attached-left.has-control-gutter>.dshpad-banner{margin-left:34px}
.dshpad-dock.is-attached-right.has-control-gutter>.dshpad-update,.dshpad-dock.is-attached-right.has-control-gutter>.dshpad-banner{margin-right:34px}
.dshpad-dock.is-attached-top .dshpad-dock-head{flex:none;margin-top:28px}
.dshpad-dock.is-attached-bottom .dshpad-dock-foot{height:32px}
.dshpad-dock.is-attached-bottom .dshpad-dock-foot::after{display:none}
/* Corner-constrained docks can be narrower than a normal panel. Wrap their
   actions inside the safe area rather than overflowing into window buttons. */
.dshpad-dock.is-narrow{overflow:clip}
.dshpad-dock.is-narrow .dshpad-dock-head{height:auto;min-height:32px;flex-wrap:wrap;justify-content:flex-end}
.dshpad-dock.is-narrow .dshpad-grip,.dshpad-dock.is-narrow .dshpad-spacer{display:none}
.dshpad-dock.is-narrow.is-attached-top .dshpad-dock-head,.dshpad-dock.is-narrow.is-attached-bottom .dshpad-dock-head{padding:2px}
.dshpad-dock.is-closing{animation:dshpad-dock-out .16s var(--dshpad-ease) forwards;pointer-events:none}
.dshpad-dock.is-closing .dshpad-collapse{pointer-events:none!important}
.dshpad-resize{position:absolute;left:-3px;top:16px;bottom:16px;width:7px;cursor:ew-resize;touch-action:none;z-index:2}
.dshpad-resize::after{content:"";position:absolute;left:3px;top:50%;width:2px;height:36px;margin-top:-18px;border-radius:1px;background:var(--dshpad-border);opacity:0;transition:opacity .15s}
.dshpad-resize:hover::after,.dshpad-resize:active::after{opacity:1}

.dshpad-dock-head{display:flex;align-items:center;gap:2px;height:32px;padding:0 42px 0 4px;flex:none;cursor:grab;touch-action:none;user-select:none;-webkit-user-select:none}
.dshpad-dock.is-moving .dshpad-dock-head{cursor:grabbing}
.dshpad-grip{flex:none;width:10px;height:14px;margin-right:2px;color:var(--dshpad-fg-3);opacity:.5;
  background-image:radial-gradient(circle,currentColor 1px,transparent 1.2px);background-size:5px 5px;background-position:0 2px;transition:opacity .15s}
.dshpad-dock-head:hover .dshpad-grip{opacity:.9}
.dshpad-dock-edge{position:absolute;left:4px;right:102px;height:6px;z-index:3;cursor:ns-resize;touch-action:none}
.dshpad-dock-edge.is-top{top:0}
.dshpad-dock-edge::after{content:"";position:absolute;left:0;right:0;top:50%;height:2px;margin-top:-1px;border-radius:1px;background:var(--dshpad-border);opacity:0;transition:opacity .15s}
.dshpad-dock-edge:hover::after{opacity:.9}
.dshpad-dock-foot{flex:none;height:14px;display:grid;place-items:center;cursor:ns-resize;touch-action:none;user-select:none}
.dshpad-dock-foot::after{content:"";width:36px;height:3px;border-radius:2px;background:var(--dshpad-border);opacity:.75;transition:opacity .15s,background-color .15s}
.dshpad-dock-foot:hover::after{opacity:1;background:var(--dshpad-fg-3)}
.dshpad-spacer{flex:1}

.dshpad-icon-btn{flex:none;display:grid;place-items:center;width:28px;height:28px;padding:0;border:0;border-radius:8px;background:transparent;color:var(--dshpad-fg-2)!important;cursor:pointer;transition:background-color .15s,color .15s}
.dshpad-icon-btn:hover:not(:disabled),.dshpad-icon-btn.is-active{background:var(--dshpad-hover);color:var(--dshpad-fg)!important}
.dshpad-icon-btn:disabled{opacity:.4;cursor:default}
.dshpad-update{flex:none;margin:0 6px 5px;padding:8px 9px;border-radius:11px;background-color:var(--dshpad-surface);background-image:linear-gradient(var(--dshpad-card-tint),var(--dshpad-card-tint));
  box-shadow:inset 0 0 0 .5px var(--dshpad-border);font-size:12px}
.dshpad-update-head{display:flex;align-items:center;justify-content:space-between;gap:6px}
.dshpad-update-close{display:grid;place-items:center;width:22px;height:22px;padding:0;border:0;border-radius:6px;background:transparent;color:var(--dshpad-fg-3);cursor:pointer}
.dshpad-update-close:hover{background:var(--dshpad-hover);color:var(--dshpad-fg)}
.dshpad-update-text{margin:5px 0 0;color:var(--dshpad-fg-2);line-height:1.45}
.dshpad-update-text.is-error{color:var(--dshpad-danger)}
.dshpad-update-text.is-ok{color:var(--dsw-alias-state-success-primary,#16a34a)}
.dshpad-update-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:7px}
.dshpad-update-primary{padding:4px 10px;border:0;border-radius:7px;background:var(--dshpad-accent);color:#fff;font-size:12px;cursor:pointer}
.dshpad-update-primary:disabled{opacity:.55;cursor:default}
.dshpad-update-secondary{padding:3px 8px;border:0;border-radius:7px;background:transparent;color:var(--dshpad-fg-2);font-size:12px;cursor:pointer}
.dshpad-update-secondary:hover{background:var(--dshpad-hover);color:var(--dshpad-fg)}
.dshpad-update-link{color:var(--dshpad-accent);text-decoration:none;font-size:12px}
.dshpad-update-link:hover{text-decoration:underline}
.dshpad-root :focus-visible{outline:2px solid var(--dshpad-accent);outline-offset:1px}

.dshpad-banner{margin:0 6px 4px;padding:4px 5px;border-radius:8px;background:var(--dsw-alias-state-warn-tertiary,rgba(217,119,6,.1));color:var(--dsw-alias-state-warn-label,var(--dshpad-fg));font-size:12px;flex:none}

.dshpad-list{flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain;scrollbar-gutter:stable;padding:1px 5px 6px;position:relative}
.dshpad-rows{display:flex;flex-direction:column;gap:4px;min-width:0}
.dshpad-split{min-width:0;min-height:0}
.dshpad-split.is-row{display:grid;align-items:stretch}
.dshpad-split.is-col{display:flex;flex-direction:column;gap:4px}
.dshpad-pane{display:flex;flex-direction:column;min-width:0;min-height:0}
.dshpad-pane>.dshpad-card{width:100%}
.dshpad-root-drop{display:grid;place-items:center;min-height:58px;margin-top:2px;border:1.5px dashed color-mix(in srgb,var(--dshpad-accent) 55%, transparent);border-radius:12px;background:color-mix(in srgb,var(--dshpad-accent) 8%, transparent);color:var(--dshpad-accent);font-size:12px;pointer-events:none}
.dshpad-splitter{position:relative;min-height:24px;cursor:col-resize;touch-action:none;z-index:1;border-radius:3px;background:transparent}
.dshpad-splitter::before{content:"";position:absolute;top:0;bottom:0;left:50%;width:1px;transform:translateX(-50%);border-radius:1px;background:var(--dshpad-fg-3);opacity:.42;transition:background-color .15s,opacity .15s}
.dshpad-splitter:hover::before,.dshpad-splitter:active::before{background:var(--dshpad-fg-3);opacity:.68}

.dshpad-card{position:relative;min-width:0;border-radius:12px;background-color:var(--dshpad-surface);background-image:linear-gradient(var(--dshpad-card-tint),var(--dshpad-card-tint));box-shadow:inset 0 0 0 .5px var(--dsw-alias-settings-card-stroke,var(--dshpad-border));animation:dshpad-fade .24s ease-out}
.dshpad-card.is-dragging{opacity:.45}
.dshpad-card.is-drop-target{box-shadow:inset 0 0 0 2px var(--dshpad-accent),0 8px 24px rgba(0,0,0,.12)}
.dshpad-card.is-drop-left::after,.dshpad-card.is-drop-right::after,.dshpad-card.is-drop-top::after,.dshpad-card.is-drop-bottom::after,.dshpad-card.is-drop-center::after{content:"";position:absolute;z-index:3;pointer-events:none;border-radius:12px;background:color-mix(in srgb,var(--dshpad-accent) 14%, transparent)}
.dshpad-card.is-drop-left::after{inset:0 52% 0 0;border-right:2px solid var(--dshpad-accent);border-radius:12px 0 0 12px}
.dshpad-card.is-drop-right::after{inset:0 0 0 52%;border-left:2px solid var(--dshpad-accent);border-radius:0 12px 12px 0}
.dshpad-card.is-drop-top::after{inset:0 0 52% 0;border-bottom:2px solid var(--dshpad-accent);border-radius:12px 12px 0 0}
.dshpad-card.is-drop-bottom::after{inset:52% 0 0 0;border-top:2px solid var(--dshpad-accent);border-radius:0 0 12px 12px}
.dshpad-card.is-drop-center::after{inset:0;background:color-mix(in srgb,var(--dshpad-accent) 9%, transparent);box-shadow:inset 0 0 0 2px var(--dshpad-accent)}
.dshpad-card.is-fresh{animation:dshpad-flash 2.4s ease-out}
.dshpad-card-head{display:flex;align-items:center;gap:2px;height:38px;padding:0 3px;cursor:grab;touch-action:none}
.dshpad-card-head button{cursor:pointer}
.dshpad-card-grip{flex:none;display:grid;place-items:center;width:14px;height:28px;color:var(--dshpad-fg-3);opacity:.55;cursor:grab;touch-action:none;border-radius:5px}
.dshpad-card-grip:hover{opacity:1;background:var(--dshpad-hover)}
.dshpad-card-grip:active{cursor:grabbing}
.dshpad-card-grip svg{width:12px;height:12px;fill:currentColor;stroke:none}
.dshpad-card-title{flex:1 1 auto;min-width:0;display:flex;align-items:center;gap:6px;height:28px;padding:0 4px;border:0;border-radius:8px;background:none;cursor:pointer;text-align:left;font-weight:600}
.dshpad-card-title:hover{background:var(--dshpad-hover)}
.dshpad-card-chevron{display:grid;color:var(--dshpad-fg-3);transition:transform .2s var(--dshpad-ease)}
.dshpad-card-chevron svg{width:12px;height:12px}
.dshpad-card.is-folded .dshpad-card-chevron{transform:rotate(-90deg)}
.dshpad-card-icon{flex:none;font-size:14px;line-height:1}
.dshpad-card-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshpad-card-meta{flex:none;max-width:38%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dshpad-fg-3);font-size:11px;font-variant-numeric:tabular-nums}
.dshpad-card-meta.is-alert{color:var(--dshpad-warn)}
.dshpad-card-actions{position:relative;flex:none;display:flex}
.dshpad-more{display:grid;place-items:center;width:24px;height:24px;padding:0;border:0;border-radius:8px;background:transparent;color:var(--dshpad-fg-2)!important;cursor:pointer;transition:background-color .15s,color .15s}
.dshpad-more:hover{background:transparent;color:var(--dshpad-fg)!important}
.dshpad-more svg{width:14px;height:14px}
.dshpad-card-body{padding:0 6px 5px}
.dshpad-drag-shield{position:fixed;inset:0;z-index:99990;cursor:grabbing;background:transparent;touch-action:none;user-select:none}
.dshpad-drag-shield.is-splitting{cursor:col-resize}
.dshpad-drag-ghost{position:fixed;z-index:99999;display:flex;align-items:center;gap:6px;max-width:280px;padding:6px 9px;border-radius:9px;  background:color-mix(in srgb, var(--dsw-alias-button-floating-fill,var(--dshpad-surface)) 88%, transparent);
  -webkit-backdrop-filter:blur(18px) saturate(1.4);backdrop-filter:blur(18px) saturate(1.4);
  box-shadow:var(--dsw-elevation-panel,0 6px 20px rgba(0,0,0,.16));color:var(--dshpad-fg);
  font-size:12px;line-height:1.3;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;pointer-events:none}
.dshpad-drag-name{overflow:hidden;text-overflow:ellipsis}
.dshpad-drag-hint{flex:none;padding-left:6px;border-left:.5px solid var(--dshpad-border);color:var(--dshpad-fg-3);font-size:11px}
.dshpad-card-note{margin:3px 0 0;color:var(--dshpad-fg-3);font-size:11px;line-height:16px;overflow-wrap:anywhere}
.dshpad-card-note.is-alert{color:var(--dshpad-danger)}

.dshpad-confirm{margin:0 6px 5px;padding:6px 7px;border-radius:9px;background:var(--dsw-alias-state-error-tertiary,rgba(229,72,77,.1));box-shadow:inset 0 0 0 .5px rgba(229,72,77,.32);animation:dshpad-pop .14s ease-out}
.dshpad-confirm p{margin:0}
.dshpad-confirm-text{font-size:12px;line-height:16px;color:var(--dshpad-fg);overflow-wrap:anywhere}
.dshpad-confirm-hint{margin-top:2px;color:var(--dshpad-fg-3);font-size:11px;line-height:15px}
.dshpad-confirm-actions{display:flex;justify-content:flex-end;gap:4px;margin-top:6px}
.dshpad-confirm-actions button{height:24px;padding:0 9px;border:0;border-radius:7px;font-family:inherit;font-size:12px;cursor:pointer;transition:background-color .15s,filter .15s}
.dshpad-confirm-cancel{background:transparent;color:var(--dshpad-fg-2)!important}
.dshpad-confirm-cancel:hover{background:var(--dshpad-hover);color:var(--dshpad-fg)!important}
.dshpad-confirm-delete{background:var(--dshpad-danger,#e5484d);color:#fff!important;font-weight:500}
.dshpad-confirm-delete:hover{filter:brightness(1.08)}

.dshpad-menu-value{margin-left:auto;max-width:86px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dshpad-fg-3);font-size:11px}
.dshpad-models{margin:0 6px 5px;padding:6px 7px;border-radius:9px;background:var(--dshpad-hover);box-shadow:inset 0 0 0 .5px var(--dshpad-border);animation:dshpad-pop .14s ease-out}
.dshpad-models-head{display:flex;align-items:center;justify-content:space-between;gap:6px;margin-bottom:4px;font-size:12px;font-weight:600}
.dshpad-models-close{display:grid;place-items:center;width:22px;height:22px;padding:0;border:0;border-radius:6px;background:transparent;color:var(--dshpad-fg-3)!important;font-size:16px;line-height:1;cursor:pointer}
.dshpad-models-close:hover{background:var(--dshpad-hover);color:var(--dshpad-fg)!important}
.dshpad-models-list{display:flex;flex-direction:column;gap:1px;max-height:220px;overflow-y:auto;scrollbar-gutter:stable}
.dshpad-model-group{margin-top:4px}
.dshpad-model-provider{margin:2px 5px;color:var(--dshpad-fg-3);font-size:10px;letter-spacing:.03em}
.dshpad-model-row{display:flex;align-items:center;gap:6px;width:100%;padding:5px 6px;border:0;border-radius:7px;background:none;text-align:left;font-size:12px;cursor:pointer}
.dshpad-model-row:hover:not(:disabled){background:var(--dshpad-hover)}
.dshpad-model-row.is-current{background:var(--dsw-alias-interactive-bg-active,var(--dshpad-hover))}
.dshpad-model-row:disabled{opacity:.5;cursor:default}
.dshpad-model-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshpad-model-meta{flex:none;max-width:45%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dshpad-fg-3);font-size:10px}
.dshpad-model-check{flex:none;color:var(--dshpad-accent);font-size:11px}
.dshpad-models-hint{margin:4px;color:var(--dshpad-fg-3);font-size:11px}
.dshpad-models-error{margin:4px;color:var(--dshpad-danger);font-size:11px}

/* Opaque, not transparent, and its own compositing layer: inside the dock's
   composited subtree Electron painted this frame's canvas but culled the
   content layer, so the panel came up blank while its document had loaded. */
.dshpad-frame{display:block;width:100%;border:0;background:var(--dshpad-surface);transform:translateZ(0);transition:height .2s var(--dshpad-ease)}
.dshpad-frame.is-resizing{transition:none}
.dshpad-frame-handle{height:10px;margin-top:2px;display:flex;align-items:center;justify-content:center;cursor:ns-resize;touch-action:none}
.dshpad-frame-handle::after{content:"";width:28px;height:3px;border-radius:2px;background:var(--dshpad-border);opacity:.7;transition:opacity .15s,background-color .15s}
.dshpad-frame-handle:hover::after{opacity:1;background:var(--dshpad-fg-3)}

.dshpad-menu{position:absolute;left:0;top:28px;z-index:10;min-width:176px;padding:6px;display:flex;flex-direction:column;gap:1px;border-radius:12px;
  background-color:var(--dshpad-surface);background-image:linear-gradient(var(--dshpad-card-tint),var(--dshpad-card-tint));-webkit-backdrop-filter:blur(18px) saturate(1.15);backdrop-filter:blur(18px) saturate(1.15);border:.5px solid var(--dshpad-border);
  box-shadow:var(--dsw-elevation-prominent,0 10px 30px rgba(0,0,0,.18));animation:dshpad-pop .14s ease-out}
.dshpad-menu button{display:flex;align-items:center;gap:9px;width:100%;padding:7px 9px;border:0;border-radius:8px;background:none;text-align:left;font-size:13px;color:inherit;cursor:pointer}
.dshpad-menu button:hover:not(:disabled){background:var(--dshpad-hover)}
.dshpad-menu button:disabled{opacity:.4;cursor:default}
.dshpad-menu button.is-danger{color:var(--dshpad-danger)!important}
.dshpad-menu hr{margin:4px;border:0;border-top:.5px solid var(--dshpad-border)}
.dshpad-mi{display:grid;place-items:center;flex:none;width:16px;height:16px;color:var(--dshpad-fg-2)}
.dshpad-mi svg{width:15px;height:15px}
.dshpad-menu button.is-danger .dshpad-mi{color:inherit}

.dshpad-focus{position:fixed;inset:0;z-index:40;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(0,0,0,.42);animation:dshpad-fade .18s ease-out}
.dshpad-focus-panel{display:flex;flex-direction:column;width:min(640px,92vw);padding:8px 14px 12px;border-radius:16px;background-color:var(--dshpad-surface);background-image:linear-gradient(var(--dshpad-card-tint),var(--dshpad-card-tint));-webkit-backdrop-filter:blur(40px) saturate(1.2);backdrop-filter:blur(40px) saturate(1.2);border:.5px solid var(--dshpad-border);box-shadow:var(--dsw-elevation-prominent,0 24px 60px rgba(0,0,0,.35))}
.dshpad-focus-head{display:flex;align-items:center;gap:8px;height:40px;flex:none}
.dshpad-focus-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600}

.dshpad-empty{padding:14px 5px 4px;color:var(--dshpad-fg-2);font-size:12px;text-align:center}
.dshpad-empty p{margin:0 0 6px}
.dshpad-empty .dshpad-empty-title{margin-bottom:2px;color:var(--dshpad-fg);font-size:14px;font-weight:600}
.dshpad-example{display:block;width:100%;margin:3px 0 0;padding:4px 6px;border:0;border-radius:10px;background:var(--dshpad-hover);text-align:left;font-size:12px;line-height:17px;cursor:pointer;transition:background-color .15s}
.dshpad-example:hover{background:var(--dsw-alias-interactive-bg-active,var(--dshpad-hover))}

/* Wide windows: the expanded dock reserves its own column. Padding the frame
   pushes the conversation and the (optional) right panel left, so the dock sits
   in the gap and covers neither — the panel no longer disappears under it. */
@media (min-width:1280px){
  html.dshpad-reserve [data-titlebar-density]{padding-right:var(--dshpad-reserve,0px)}
  /* The right panel's drag handle is positioned from viewport pixels, so pull it
     back onto the panel's edge while the dock holds that column. */
  html.dshpad-reserve [data-titlebar-density] [data-side=rightbar]{transform:translateX(calc(var(--dshpad-reserve,0px) * -1))}
  /* dsh hides the turn rail (the jump-to-turn column on the conversation's right
     edge) below a 900px conversation. While the dock has reserved its column the
     rail still sits in the conversation margin, left of the dock, so keep it as
     soon as there is room for it — opening the dock must not take it away. */
  @container (width >= 800px){
    html.dshpad-reserve [class*="_slot"]>nav[class*="_frame"]{display:block}
  }
}
[data-titlebar-density]{transition:padding-right .26s cubic-bezier(.22,.8,.24,1)}

@keyframes dshpad-dock-in{from{opacity:0}to{opacity:1}}
@keyframes dshpad-dock-out{to{opacity:0}}
@keyframes dshpad-ball-out{to{opacity:0}}
@keyframes dshpad-pop{from{opacity:0;scale:.96}to{opacity:1;scale:1}}
@keyframes dshpad-fade{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
@keyframes dshpad-flash{0%,30%{box-shadow:inset 0 0 0 1.5px var(--dshpad-accent)}100%{box-shadow:inset 0 0 0 .5px var(--dsw-alias-settings-card-stroke,var(--dshpad-border))}}
@media (prefers-reduced-motion:reduce){
  .dshpad-root *{animation-duration:1ms!important;transition-duration:1ms!important}
}
`
