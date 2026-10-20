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
  --dshpad-ease:cubic-bezier(.22,.8,.24,1);
  color:var(--dshpad-fg)}
.dshpad-root svg{width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round}
.dshpad-root circle{fill:currentColor;stroke:none}
.dshpad-root button{font:inherit;color:inherit}

.dshpad-toggle,.dshpad-collapse{display:grid;place-items:center;padding:0;border:0;border-radius:9px;cursor:pointer;touch-action:none;user-select:none;
  background:transparent;color:var(--dshpad-fg-2)!important;
  transition:background-color .18s,box-shadow .2s,color .15s}
.dshpad-toggle{position:fixed;right:5px;transform:translateY(-50%);width:28px;height:28px;
  background:color-mix(in srgb, var(--dsw-alias-button-floating-fill,var(--dshpad-surface)) 78%, transparent);
  -webkit-backdrop-filter:blur(18px) saturate(1.4);backdrop-filter:blur(18px) saturate(1.4);
  box-shadow:inset 0 0 0 .5px var(--dsw-alias-border-l1,var(--dshpad-border)),var(--dsw-elevation-panel,0 6px 20px rgba(0,0,0,.12));
  animation:dshpad-pop .2s var(--dshpad-ease)}
.dshpad-toggle:hover{background:color-mix(in srgb, var(--dsw-alias-button-floating-hover,var(--dshpad-surface)) 84%, transparent);color:var(--dshpad-fg)!important}
.dshpad-collapse{position:absolute;top:2px;right:9px;width:28px;height:28px}
.dshpad-collapse:hover{background:var(--dshpad-hover);color:var(--dshpad-fg)!important}
.dshpad-toggle.is-dragging{cursor:grabbing;box-shadow:inset 0 0 0 .5px var(--dsw-alias-border-l1,var(--dshpad-border)),var(--dsw-elevation-prominent,0 10px 30px rgba(0,0,0,.18))}
.dshpad-toggle svg,.dshpad-collapse svg{width:16px;height:16px}
.dshpad-dot{position:absolute;top:3px;right:4px;width:7px;height:7px;border-radius:50%;corner-shape:round;background:var(--dshpad-warn)}

.dshpad-dock{position:fixed;top:52px;right:5px;max-height:calc(100vh - 64px);max-width:calc(100vw - 12px);pointer-events:auto;display:flex;flex-direction:column;
  background:color-mix(in srgb, var(--dshpad-surface) 70%, transparent);border:0;border-radius:var(--dsw-radius-xl,16px);box-shadow:var(--dsw-elevation-panel,0 8px 28px rgba(0,0,0,.14));
  -webkit-backdrop-filter:blur(26px) saturate(1.45);backdrop-filter:blur(26px) saturate(1.45);
  font-size:13px;line-height:18px;transform-origin:100% 0;animation:dshpad-slide .22s var(--dshpad-ease)}
.dshpad-dock.is-closing{animation:dshpad-close .18s var(--dshpad-ease) forwards;pointer-events:none}
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
.dshpad-update{flex:none;margin:0 6px 5px;padding:8px 9px;border-radius:11px;background:color-mix(in srgb, var(--dshpad-surface) 55%, transparent);
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
.dshpad-rows{display:flex;flex-direction:column;gap:4px}
.dshpad-row{display:grid;align-items:stretch;min-height:0}
.dshpad-splitter{position:relative;min-height:0;cursor:col-resize;touch-action:none;z-index:1;border-radius:3px;background:transparent}
.dshpad-splitter::before{content:"";position:absolute;top:0;bottom:0;left:2px;right:2px;border-radius:2px;background:var(--dshpad-border);opacity:.55;transition:background-color .15s,opacity .15s}
.dshpad-splitter:hover::before,.dshpad-splitter:active::before{background:var(--dshpad-accent);opacity:1}

.dshpad-card{position:relative;min-width:0;border-radius:12px;background:color-mix(in srgb, var(--dsw-alias-settings-card-fill, transparent) 55%, transparent);box-shadow:inset 0 0 0 .5px var(--dsw-alias-settings-card-stroke,var(--dshpad-border));animation:dshpad-fade .24s ease-out}
.dshpad-card.is-dragging{opacity:.45}
.dshpad-card.is-drop-target{box-shadow:inset 0 0 0 2px var(--dshpad-accent),0 8px 24px rgba(0,0,0,.12)}
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
.dshpad-drag-ghost{position:fixed;z-index:99999;display:flex;align-items:center;gap:6px;max-width:220px;padding:6px 9px;border-radius:9px;
  background:color-mix(in srgb, var(--dsw-alias-button-floating-fill,var(--dshpad-surface)) 88%, transparent);
  -webkit-backdrop-filter:blur(18px) saturate(1.4);backdrop-filter:blur(18px) saturate(1.4);
  box-shadow:var(--dsw-elevation-panel,0 6px 20px rgba(0,0,0,.16));color:var(--dshpad-fg);
  font-size:12px;line-height:1.3;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;pointer-events:none}
.dshpad-drag-ghost span:last-child{overflow:hidden;text-overflow:ellipsis}
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

.dshpad-frame{display:block;width:100%;border:0;background:transparent;transition:height .2s var(--dshpad-ease)}
.dshpad-frame.is-resizing{transition:none}
.dshpad-frame-handle{height:10px;margin-top:2px;display:flex;align-items:center;justify-content:center;cursor:ns-resize;touch-action:none}
.dshpad-frame-handle::after{content:"";width:28px;height:3px;border-radius:2px;background:var(--dshpad-border);opacity:.7;transition:opacity .15s,background-color .15s}
.dshpad-frame-handle:hover::after{opacity:1;background:var(--dshpad-fg-3)}

.dshpad-menu{position:absolute;left:0;top:28px;z-index:10;min-width:176px;padding:6px;display:flex;flex-direction:column;gap:1px;border-radius:12px;
  background:color-mix(in srgb, var(--dsw-alias-settings-card-fill,var(--dshpad-surface)) 86%, transparent);-webkit-backdrop-filter:blur(18px) saturate(1.15);backdrop-filter:blur(18px) saturate(1.15);border:.5px solid var(--dshpad-border);
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
.dshpad-focus-panel{display:flex;flex-direction:column;width:min(640px,92vw);padding:8px 14px 12px;border-radius:16px;background:color-mix(in srgb, var(--dsw-alias-bg-layer-1,var(--dshpad-surface)) 82%, transparent);-webkit-backdrop-filter:blur(40px) saturate(1.2);backdrop-filter:blur(40px) saturate(1.2);border:.5px solid var(--dshpad-border);box-shadow:var(--dsw-elevation-prominent,0 24px 60px rgba(0,0,0,.35))}
.dshpad-focus-head{display:flex;align-items:center;gap:8px;height:40px;flex:none}
.dshpad-focus-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600}

.dshpad-approve{margin:0 0 5px;padding:5px 6px;border-radius:10px;background:var(--dsw-alias-state-warn-tertiary,rgba(217,119,6,.1));font-size:12px}
.dshpad-approve p{margin:0 0 3px}
.dshpad-approve ul{margin:0 0 5px;padding:0;list-style:none;display:flex;flex-direction:column;gap:2px}
.dshpad-approve code{display:block;max-height:76px;overflow:auto;padding:2px 4px;border-radius:6px;background:var(--dshpad-hover);font:11px/16px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;word-break:break-all;white-space:pre-wrap}
.dshpad-primary{height:28px;padding:0 12px;border:0;border-radius:8px;background:var(--dshpad-accent,#4d6bfe);color:var(--dsw-alias-label-primary-foreground,#fff)!important;box-shadow:inset 0 0 0 1px rgba(0,0,0,.08);font-size:12px;font-weight:500;cursor:pointer}
.dshpad-primary:hover{filter:brightness(1.06)}

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

@keyframes dshpad-slide{from{opacity:0;transform:translateX(12px) scale(.94)}to{opacity:1;transform:none}}
@keyframes dshpad-close{to{opacity:0;transform:translateX(10px) scale(.94)}}
@keyframes dshpad-pop{from{opacity:0;scale:.96}to{opacity:1;scale:1}}
@keyframes dshpad-fade{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
@keyframes dshpad-flash{0%,30%{box-shadow:inset 0 0 0 1.5px var(--dshpad-accent)}100%{box-shadow:inset 0 0 0 .5px var(--dsw-alias-settings-card-stroke,var(--dshpad-border))}}
@media (prefers-reduced-motion:reduce){
  .dshpad-root *{animation-duration:1ms!important;transition-duration:1ms!important}
}
@media (max-width:640px){
  .dshpad-dock{top:8px;right:8px;max-height:calc(100vh - 16px);width:calc(100vw - 16px)!important}
}
`
