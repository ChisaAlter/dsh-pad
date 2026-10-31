import { describe, expect, it } from 'vitest'
import { FRAME_RUNTIME } from '../src/client/frame-runtime.ts'
import { PANEL_KIT_CSS, PANEL_KIT_VISUALS } from '../src/shared/kit.ts'

/** Boot the frame runtime against a stubbed window/document and return its `dsh`. */
function boot(): any {
  const attributes = new Map([['data-token', 't'], ['data-height', 'auto']])
  const documentStub = {
    documentElement: {
      getAttribute: (name: string): string | undefined => attributes.get(name),
      setAttribute: (name: string, value: string): void => { attributes.set(name, value) },
    },
    getElementById: (id: string): { textContent: string } => ({
      textContent: id === 'pad-init' ? JSON.stringify({ data: { sources: {}, agent: null }, histories: {}, state: {}, lang: 'zh' }) : '',
    }),
    addEventListener: (): void => {},
    body: { scrollHeight: 10 },
  }
  const windowStub = {
    parent: { postMessage: (): void => {} },
    addEventListener: (): void => {},
    dsh: undefined as unknown,
  }
  class Observer {
    observe(): void {}
    disconnect(): void {}
  }
  new Function('window', 'document', 'ResizeObserver', FRAME_RUNTIME)(windowStub, documentStub, Observer)
  return (windowStub as { dsh: unknown }).dsh
}

describe('panel kit stylesheet', () => {
  it('defines every class the lint counts as a visual anchor', () => {
    for (const name of PANEL_KIT_VISUALS) expect(PANEL_KIT_CSS).toContain(`.${name}`)
  })

  it('reads colour only from tokens, so panels follow the host theme', () => {
    // A literal colour in the kit would break one of the two modes.
    expect(PANEL_KIT_CSS).not.toMatch(/#[0-9a-f]{3,8}\b/i)
    expect(PANEL_KIT_CSS).not.toMatch(/\b(rgba?|hsla?)\(/i)
    expect(PANEL_KIT_CSS).toContain('var(--pad-')
  })

  it('has a reduced-motion fallback for everything that animates', () => {
    expect(PANEL_KIT_CSS).toContain('@media (prefers-reduced-motion:reduce)')
  })
})

describe('dsh.ui helpers', () => {
  it('builds a metric and escapes both label and value', () => {
    const html = boot().ui.metric({ label: '<b>', value: '12', unit: 'ms', foot: 'now' })
    expect(html).toContain('class="pad-metric"')
    expect(html).toContain('class="pad-metric-value"')
    expect(html).toContain('class="pad-unit">ms<')
    expect(html).toContain('&lt;b&gt;')
    expect(html).not.toContain('<b>')
  })

  it.each(['ok', 'warn', 'danger', 'accent'])('colours a metric from the supported %s tone', tone => {
    expect(boot().ui.metric({ label: 'CPU', value: '90', tone })).toContain(`color:var(--pad-${tone})`)
  })

  it('accepts the exact tokens returned by dsh.tone', () => {
    const dsh = boot()
    for (const fraction of [0.1, 0.8, 0.99]) {
      expect(dsh.ui.metric({ value: '12', tone: dsh.tone(fraction) })).toContain(`color:${dsh.tone(fraction)}`)
    }
  })

  it.each([
    'red"><img src="data:image/png;base64,broken" onerror="dsh.refresh()"><i style="color:red',
    'ok" onmouseover="dsh.refresh()',
    'var(--pad-ok);background:url(https://invalid.example/)',
    '&#34;><script>dsh.refresh()</script>',
    'red', '', null, 42, {},
  ])('ignores an unsupported metric tone without adding markup or attributes: %s', tone => {
    const ui = boot().ui
    expect(ui.metric({ value: '12', tone })).toBe(ui.metric({ value: '12' }))
  })

  it('does not coerce an untrusted tone object into executable markup', () => {
    const tone = { toString: (): never => { throw new Error('untrusted coercion') } }
    const ui = boot().ui
    expect(ui.metric({ value: '<12>', tone })).toBe(ui.metric({ value: '<12>' }))
    expect(ui.metric({ value: '<12>', tone })).toContain('&lt;12&gt;')
  })

  it('draws a row meter at the given fraction', () => {
    const html = boot().ui.item({ name: '/data', value: '412 GB', meter: 0.72, tone: 'warn' })
    expect(html).toContain('class="pad-item-name">/data<')
    expect(html).toContain('class="pad-meter is-warn"')
    expect(html).toContain('width:72.0%')
  })

  it('clamps a meter outside 0–1 instead of writing a broken width', () => {
    expect(boot().ui.item({ name: 'x', value: '1', meter: 4 })).toContain('width:100.0%')
    expect(boot().ui.item({ name: 'y', value: '1', meter: -1 })).toContain('width:0.0%')
  })

  it('omits the meter when no fraction is given', () => {
    expect(boot().ui.item({ name: 'x', value: '1' })).not.toContain('pad-meter')
  })

  it('renders status dots, chips, empty states and alerts from the kit', () => {
    const dsh = boot()
    expect(dsh.ui.status('API', 'ok')).toBe('<span class="pad-status is-ok">API</span>')
    expect(dsh.ui.chip('2 queued', 'ok')).toContain('pad-chip is-ok')
    expect(dsh.ui.empty('no data')).toBe('<p class="pad-empty">no data</p>')
    expect(dsh.ui.alert('boom')).toBe('<p class="pad-alert">boom</p>')
  })

  it('joins a list of rows inside one pad-list', () => {
    const html = boot().ui.list([{ name: 'a', value: '1' }, { name: 'b', value: '2' }])
    expect(html.startsWith('<div class="pad-list">')).toBe(true)
    expect(html.match(/class="pad-item"/g)).toHaveLength(2)
  })

  it('escapes markup that arrives from a data source', () => {
    expect(boot().ui.empty('<img onerror=alert(1)>')).toContain('&lt;img')
  })
})
