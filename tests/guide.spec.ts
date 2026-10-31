import { describe, expect, it } from 'vitest'
import { PANEL_GUIDE, PANEL_TOPICS, panelManual } from '../src/host/guide.ts'
import { PANEL_KIT_CSS, PANEL_KIT_VISUALS } from '../src/shared/kit.ts'

/** The html + js pairs the manual tells the model to copy. */
function recipes(): Array<{ html: string, js: string }> {
  return [...panelManual('recipes').matchAll(/```html\n([\s\S]*?)```\n[\s\S]*?```js\n([\s\S]*?)```/g)]
    .map(match => ({ html: match[1] ?? '', js: match[2] ?? '' }))
}

describe('authoring guide', () => {
  it('keeps the short form short, because it rides in the tool description', () => {
    expect(PANEL_GUIDE.length).toBeLessThan(4000)
    expect(PANEL_GUIDE).toContain('pad_guide')
    expect(PANEL_GUIDE).toContain('lint')
  })

  it('serves every topic on its own and all of them together', () => {
    const all = panelManual('all')
    for (const topic of PANEL_TOPICS) {
      const section = panelManual(topic)
      expect(section.length).toBeGreaterThan(100)
      expect(all).toContain(section)
    }
    expect(all.split('# ').length - 1).toBeGreaterThanOrEqual(PANEL_TOPICS.length - 1)
    // An unknown topic degrades to the whole manual rather than an empty answer.
    expect(panelManual('nope' as never)).toBe(all)
  })

  it('offers four complete recipes with a script that compiles', () => {
    const pairs = recipes()
    expect(pairs).toHaveLength(4)
    for (const recipe of pairs) {
      expect(recipe.html.trim()).not.toBe('')
      expect(() => new Function(recipe.js)).not.toThrow()
      expect(recipe.js).toContain('dsh.onData')
      // Every recipe must survive a source that exists but failed.
      expect(recipe.js).toMatch(/\.ok/)
      expect(recipe.js).toContain('dsh.')
    }
  })

  it('builds the recipes out of the kit the frame actually injects', () => {
    const html = recipes().map(recipe => recipe.html).join('\n')
    const used = PANEL_KIT_VISUALS.filter(name => html.includes(`class="${name}`) || html.includes(` ${name} `) || html.includes(` ${name}"`))
    // A recipe that uses none of the kit would drift away from the stylesheet.
    expect(used.length).toBeGreaterThanOrEqual(4)
    expect(html).toContain('pad-stack')
    expect(html).toContain('pad-metric')
  })

  it('never tells the model to use an API the frame does not expose', () => {
    const manual = panelManual('all')
    const allowed = ['onData', 'data', 'history', 'refresh', 'openUrl', 'state', 'ask', 'run', 'tone', 'escape', 'fmt', 'chart', 'ui']
    const called = [...manual.matchAll(/dsh\.([a-zA-Z]+)/g)].map(match => match[1] ?? '')
    expect(called.length).toBeGreaterThan(10)
    for (const name of called) expect(allowed).toContain(name)
  })

  it('never names a kit class the stylesheet does not define', () => {
    const manual = panelManual('all')
    // `--pad-fg` style tokens are excluded by the lookbehind; only class names remain.
    const named = new Set([...manual.matchAll(/(?<![\w-])pad-[a-z][a-z0-9-]*/g)].map(match => match[0]))
    expect(named.size).toBeGreaterThan(15)
    for (const name of named) expect(PANEL_KIT_CSS, `${name} is documented but not styled`).toContain(`.${name}`)
  })

  it('does not describe the removed approval step', () => {
    const manual = panelManual('all')
    expect(manual).not.toMatch(/允许运行/)
    expect(manual).not.toMatch(/审批/)
    expect(manual).toContain('不需要点任何按钮')
  })
})
