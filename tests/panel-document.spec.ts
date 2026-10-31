import { describe, expect, it } from 'vitest'
import { frameDocument, type FrameDocumentInput } from '../src/client/panel-document.ts'
import { PANEL_KIT_CSS } from '../src/shared/kit.ts'
import type { PanelView } from '../src/shared/types.ts'

function view(overrides: Partial<PanelView['definition']> = {}): PanelView {
  return {
    id: 'p_test',
    version: 1,
    position: 0,
    collapsed: false,
    span: 1,
    updatedAt: '2026-10-30T00:00:00.000Z',
    definition: {
      title: 'CPU',
      html: '<div class="pad-metric"><span class="pad-metric-value">42</span></div>',
      css: '.mine{color:var(--pad-fg)}',
      script: 'dsh.onData(function () {})',
      height: 'auto',
      sources: [],
      ...overrides,
    },
    canUndo: false,
    agentRun: null,
    data: { sources: {}, agent: null },
    history: {},
  }
}

function build(overrides: Partial<FrameDocumentInput> = {}): string {
  return frameDocument({
    view: view(),
    token: 'tok',
    theme: { mode: 'dark', css: ':root{--pad-fg:#e9e9ec}body{color-scheme:dark}' },
    data: { sources: {}, agent: null },
    histories: {},
    state: {},
    lang: 'zh',
    ...overrides,
  })
}

describe('panel document', () => {
  it('injects the panel kit, before the panel stylesheet so a panel can override it', () => {
    const doc = build()
    expect(doc).toContain('<style id="pad-kit">')
    expect(doc).toContain(PANEL_KIT_CSS)
    expect(doc.indexOf('<style id="pad-kit">')).toBeLessThan(doc.indexOf('.mine{color:var(--pad-fg)}'))
  })

  it('orders theme, base, kit, panel css, html', () => {
    const doc = build()
    const theme = doc.indexOf('<style id="pad-theme">')
    const kit = doc.indexOf('<style id="pad-kit">')
    const own = doc.indexOf('.mine{')
    const html = doc.indexOf('<div class="pad-metric">')
    expect(theme).toBeGreaterThanOrEqual(0)
    expect(theme).toBeLessThan(kit)
    expect(kit).toBeLessThan(own)
    expect(own).toBeLessThan(html)
  })

  it('carries the sandbox CSP and the frame runtime', () => {
    const doc = build()
    expect(doc).toContain('Content-Security-Policy')
    expect(doc).toContain("default-src 'none'")
    expect(doc).toContain('window.dsh = dsh')
  })

  it('seeds the first paint with data, histories, state and lang', () => {
    const doc = build({
      data: { sources: { cpu: { ok: true, value: { percent: 12 }, at: '2026-10-30T00:00:00.000Z' } }, agent: null },
      histories: { cpu: [{ value: { percent: 11 }, at: '2026-10-30T00:00:00.000Z' }] },
      state: { range: '24h' },
    })
    const init = doc.slice(doc.indexOf('id="pad-init"'), doc.indexOf('</script>', doc.indexOf('id="pad-init"')))
    expect(init).toContain('percent')
    expect(init).toContain('24h')
    expect(init).toContain('"lang":"zh"')
  })

  it('escapes markup so panel content cannot close its own style or script tag', () => {
    const doc = build({ view: view({ css: '}</style><script>alert(1)</script>', script: 'var x = "</script>"' }) })
    expect(doc).not.toContain('</style><script>alert(1)')
    expect(doc).not.toContain('"</script>"')
    expect(doc).toContain('<\\/style')
    expect(doc).toContain('<\\/script')
  })

  it('escapes "<" inside the embedded init payload', () => {
    const doc = build({ view: view({ html: '<span class="pad-item-name">a<b>c</span>' }) })
    const start = doc.indexOf('id="pad-init"')
    const init = doc.slice(start, doc.indexOf('</script>', start))
    expect(init).not.toContain('<')
  })

  it('lets a dragged height switch the frame out of auto sizing', () => {
    expect(build()).toContain('data-height="auto"')
    expect(build({ viewHeight: 320 })).toContain('data-height="fixed"')
    expect(build({ view: view({ height: 240 }) })).toContain('data-height="fixed"')
  })
})
