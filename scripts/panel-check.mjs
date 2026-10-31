/**
 * Renders a panel definition the way the dock does, at three widths and in both
 * themes, and fails on a layout that does not fit.
 *
 * The point is the Floor: a panel that is clipped at 280px is not shippable, and
 * "looks fine on my screen" is not a check. Same `frameDocument` the dock uses,
 * so this cannot drift from what the user sees.
 *
 *   node scripts/panel-check.mjs [file.json]
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const require = createRequire(import.meta.url)
const out = join(root, '.dev')
mkdirSync(out, { recursive: true })

const CHROME = process.env['CHROME_PATH'] ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const WIDTHS = [280, 360, 440]
const THEMES = /** @type {const} */ (['light', 'dark'])

const TOKENS = {
  light: '--pad-fg:#1f2329;--pad-fg-2:#545a63;--pad-fg-3:#828a94;--pad-bg:#ffffff;--pad-bg-2:rgba(0,0,0,.06);--pad-border:rgba(0,0,0,.12);--pad-accent:#3b5bdb;--pad-ok:#1a7f4b;--pad-warn:#a35b00;--pad-danger:#c0272d;--pad-font:"Segoe UI",system-ui,sans-serif;--pad-mono:ui-monospace,Consolas,monospace;--pad-radius:8px;',
  dark: '--pad-fg:#e9e9ec;--pad-fg-2:#b7b9bf;--pad-fg-3:#8e9198;--pad-bg:#232326;--pad-bg-2:rgba(255,255,255,.08);--pad-border:rgba(255,255,255,.14);--pad-accent:#7c93ff;--pad-ok:#3ddc97;--pad-warn:#f5a524;--pad-danger:#ff6369;--pad-font:"Segoe UI",system-ui,sans-serif;--pad-mono:ui-monospace,Consolas,monospace;--pad-radius:8px;',
}

/** The definition file to check: a CLI argument, else the shipped example. */
const file = process.argv[2] ?? 'examples/github-status.json'
const definition = JSON.parse(readFileSync(join(root, file), 'utf8'))

/** Sample readings, shaped like the host's: values are JSON text. */
const DATA = {
  sources: {
    repo: { ok: true, at: iso(30000), value: JSON.stringify({ stars: 198, forks: 10, openAll: 0 }) },
    part: { ok: true, at: iso(30000), value: JSON.stringify({ all: [9, 203, 382, 115, 41, 33, 125, 38, 149, 148, 187, 214] }) },
    prs: { ok: true, at: iso(30000), value: '[]' },
    issues: {
      ok: true,
      at: iso(30000),
      value: JSON.stringify([
        { n: 307, t: '改善更新下载慢、断线后反复从零下载的问题', s: 'CLOSED', u: iso(2 * 86400e3), cm: 1, url: 'https://github.com/ChisaAlter/WhaleIsle/issues/307' },
        { n: 303, t: '大型历史的显式用量冷统计耗时约九分钟', s: 'CLOSED', u: iso(2 * 86400e3), cm: 4, url: 'https://github.com/ChisaAlter/WhaleIsle/issues/303' },
        { n: 299, t: '修正输入框附加栏过渡覆盖及队列突变', s: 'CLOSED', u: iso(3 * 86400e3), cm: 0, url: 'https://github.com/ChisaAlter/WhaleIsle/issues/299' },
      ]),
    },
    counts: { ok: true, at: iso(30000), value: JSON.stringify(['256', '53', '0']) },
    release: { ok: true, at: iso(30000), value: JSON.stringify({ tag: 'v0.3.13' }) },
  },
  agent: null,
}
function iso(ago) { return new Date(Date.now() - ago).toISOString() }

const bundle = await build({
  entryPoints: [join(root, 'src/client/panel-document.ts')],
  outfile: join(out, 'panel-document.cjs'),
  bundle: true, format: 'cjs', platform: 'node', target: 'node22', logLevel: 'error',
}).then(() => require(join(out, 'panel-document.cjs')))

const view = {
  id: 'check', version: 1, position: 0, collapsed: false, span: 1, updatedAt: iso(0),
  canUndo: false, agentRun: null, definition, data: DATA,
}

// Measures the column the panel actually occupies and the furthest right edge
// any element reaches: a child wider than the column is the failure we ship on.
const PROBE = `<script>addEventListener('load',function(){
var body=document.body, box=body.getBoundingClientRect(), right=0;
var all=body.querySelectorAll('*');
for(var i=0;i<all.length;i++){var r=all[i].getBoundingClientRect(); if(r.right>right) right=r.right;}
document.title=JSON.stringify({cw:Math.round(box.width), right:Math.round(right), sh:Math.round(body.scrollHeight), over:Math.round(right-box.width)});});</script>`

const results = []
for (const theme of THEMES) {
  for (const width of WIDTHS) {
    // The viewport cannot be trusted across headless modes, so the column width
    // is pinned in CSS: what is measured is exactly what was rendered. The page
    // takes the card's surface because in the dock the card supplies it.
    const pin = `<style>html{width:${width}px;overflow-x:auto;background:var(--pad-bg)}body{padding:2px 9px 9px}</style>`
    const doc = bundle.frameDocument({
      view, token: 'check', data: DATA, histories: {}, state: {}, lang: 'zh',
      theme: { mode: theme, css: `:root{${TOKENS[theme]}}html{background:var(--pad-bg)}body{color-scheme:${theme}}` },
    }).replace('</head>', `${pin}</head>`).replace('</body>', `${PROBE}</body>`)
    const file = join(out, `pc-${theme}-${width}.html`)
    writeFileSync(file, doc, 'utf8')

    const url = `file:///${file.replace(/\\/g, '/')}`
    const dom = execFileSync(CHROME, [
      '--headless=new', '--disable-gpu', '--hide-scrollbars', `--window-size=${width},900`,
      '--virtual-time-budget=2500', '--dump-dom', url,
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    const raw = /<title>([^<]*)<\/title>/i.exec(dom)?.[1] ?? ''
    let measured = null
    try { measured = JSON.parse(raw.replace(/&quot;/g, '"')) } catch { measured = null }

    const png = join(out, `pc-${theme}-${width}.png`)
    execFileSync(CHROME, [
      '--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=2',
      `--window-size=${width + 24},${Math.min(940, Math.max(240, (measured?.sh ?? 400) + 8))}`,
      '--virtual-time-budget=2500', `--screenshot=${png}`, url,
    ], { stdio: 'ignore' })

    results.push({ theme, width, measured, png, overflow: measured ? measured.over > 1 : null })
  }
}

const bad = results.filter(r => r.overflow !== false)
const rows = results.map(r => {
  const m = r.measured
  const size = m ? `${m.cw}px · +${m.over}px` : '?'
  const mark = r.overflow === false ? '<i class="ok">fits</i>' : '<i class="bad">overflows</i>'
  return `<figure><figcaption><span>${r.theme} · ${r.width}px</span><span>${size} ${mark}</span></figcaption>
    <div class="shot"><img src="${r.png.replace(/\\/g, '/')}" alt="${r.theme} ${r.width}px"></div></figure>`
}).join('\n')

const sheet = join(out, 'panel-check.html')
writeFileSync(sheet, `<!doctype html><html><head><meta charset="utf-8"><style>
  body{margin:0;padding:18px;background:#0d1014;font:12px system-ui;color:#c9ced6}
  .grid{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;align-items:start}
  figure{margin:0;display:flex;flex-direction:column;gap:6px}
  figcaption{display:flex;justify-content:space-between;font-size:11px;color:#8b93a1}
  .shot{border-radius:10px;overflow:hidden;background:#1b1e23;box-shadow:0 0 0 .5px rgba(255,255,255,.14)}
  img{display:block;width:100%}
  .dim{opacity:.45} .ok{color:#4ade80;font-style:normal} .bad{color:#f87171;font-style:normal}
</style></head><body><div class="grid">${rows}</div></body></html>`, 'utf8')

const shot = join(out, 'panel-check.png')
execFileSync(CHROME, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=2',
  '--window-size=1180,900', '--virtual-time-budget=2500', `--screenshot=${shot}`, `file:///${sheet.replace(/\\/g, '/')}`,
], { stdio: 'ignore' })

for (const r of results) {
  const m = r.measured
  console.log(`${r.theme.padEnd(5)} ${String(r.width).padStart(4)}px  column ${m ? `${m.cw}px` : '?'}  tallest ${m ? `${m.sh}px` : '?'}  ${r.overflow === false ? 'fits' : m ? `overflows by ${m.over}px` : 'unmeasured'}`)
}
console.log(`\n${shot}`)
if (bad.length > 0) {
  console.error(`\n${bad.length} case(s) do not fit: ${bad.map(r => `${r.theme}/${r.width}`).join(', ')}`)
  process.exitCode = 1
}
