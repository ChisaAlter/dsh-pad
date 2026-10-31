import { describe, expect, it } from 'vitest'
import { formatLint, lintPanel } from '../src/host/lint.ts'
import type { LintIssue, LintTarget } from '../src/host/lint.ts'

function panel(html: string, css = '', script = ''): LintTarget {
  return { html, css, script }
}

function rules(target: LintTarget): string[] {
  return lintPanel(target).map((issue) => issue.rule)
}

function find(target: LintTarget, rule: string): LintIssue | undefined {
  return lintPanel(target).find((issue) => issue.rule === rule)
}

/** The panel the lint asks for: one big number, a short list, a meter. */
const ready = panel(
  `<div class="pad-stack">
    <div class="pad-split"><span class="pad-label">负载</span><span class="pad-status is-ok">正常</span></div>
    <div class="pad-metric"><span class="pad-metric-value">0.42</span><span class="pad-foot">1 / 5 / 15 分钟</span></div>
    <ul class="pad-list">
      <li class="pad-item"><span class="pad-item-name">cpu</span><span class="pad-item-value">38%</span></li>
      <li class="pad-item"><span class="pad-item-name">mem</span><span class="pad-item-value">61%</span></li>
    </ul>
    <div class="pad-meter"><i style="width:38%"></i></div>
  </div>`,
  '.pad-status.is-ok{color:var(--pad-ok)}',
  `dsh.onData((data) => {
    const load = data.sources.load
    if (!load.ok) {
      document.body.textContent = load.error
      return
    }
    document.body.textContent = String(load.value)
  })`,
)

const metric = '<div class="pad-metric"><span class="pad-metric-value">1</span></div>'

describe('lintPanel', () => {
  it('passes a panel built from the kit', () => {
    expect(lintPanel(ready)).toEqual([])
  })

  it('passes a short plain line without a visual anchor', () => {
    expect(lintPanel(panel('<p>共 3 个任务</p>'))).toEqual([])
  })

  it('reports a paragraph dump as a wall, a prose run and no anchor', () => {
    const dump = panel(`<div class="pad-stack"><p>${'今天服务器整体负载正常，数据库连接数略有上升，建议观察。'.repeat(6)}</p></div>`)
    expect(rules(dump)).toEqual(['text-wall', 'prose', 'no-anchor'])
    expect(find(dump, 'text-wall')?.severity).toBe('error')
  })

  it('returns the same issues on every run', () => {
    const once = panel('<pre>{"a":1,"b":2,"c":3}</pre>', '.x{color:#fff}', 'dsh.refresh()')
    expect(lintPanel(once)).toEqual(lintPanel({ ...once }))
  })
})

describe('text-wall', () => {
  it('allows exactly 150 characters of copy', () => {
    expect(rules(panel(`<div class="pad-item">${'字'.repeat(150)}</div>`))).not.toContain('text-wall')
  })

  it('reports static copy above 150 characters with the count and the fix', () => {
    const issue = find(panel(`<div class="pad-item">${'字'.repeat(151)}</div>`), 'text-wall')
    expect(issue?.severity).toBe('error')
    expect(issue?.message).toContain('151 字')
    expect(issue?.message).toContain('pad-item')
  })
})

describe('prose', () => {
  it('allows a run of exactly 90 characters', () => {
    expect(rules(panel(`<div class="pad-item">${'字'.repeat(90)}</div>`))).not.toContain('prose')
  })

  it('reports one long run and names the fix', () => {
    const issue = find(panel(`<div class="pad-item">${'字'.repeat(91)}</div>`), 'prose')
    expect(issue?.severity).toBe('error')
    expect(issue?.message).toContain('91 字')
    expect(issue?.message).toContain('pad-label')
  })
})

describe('data-dump', () => {
  it('allows an object with only a couple of keys', () => {
    expect(rules(panel('<div class="pad-item">{"cpu": 0.4, "mem": 0.7}</div>'))).not.toContain('data-dump')
  })

  it('reports a pre block', () => {
    expect(find(panel('<pre>load 0.42</pre>'), 'data-dump')?.severity).toBe('error')
  })

  it('lets an inline code carry a value like a version or a command name', () => {
    expect(rules(panel('<div class="pad-item"><span class="pad-item-name">build</span><code>v0.4.0</code></div>'))).not.toContain('data-dump')
  })

  it('reports an inline code that holds a blob', () => {
    expect(find(panel(`<code>${'x'.repeat(120)}</code>`), 'data-dump')?.severity).toBe('error')
    expect(find(panel('<code>line one\nline two</code>'), 'data-dump')?.severity).toBe('error')
  })

  it('reports three or more JSON pairs without a pre block', () => {
    const issue = find(panel('<div class="pad-item">{"cpu": 0.4, "mem": 0.7, "disk": 0.2}</div>'), 'data-dump')
    expect(issue?.message).toContain('pad-metric')
  })
})

describe('no-anchor', () => {
  it('accepts a short bare line like 共 3 个任务', () => {
    expect(rules(panel('<p>共 3 个任务</p>'))).not.toContain('no-anchor')
  })

  it('allows 60 characters of text without a visual', () => {
    expect(rules(panel(`<div>${'好'.repeat(60)}</div>`))).not.toContain('no-anchor')
  })

  it('reports 61 characters of text with nothing visual', () => {
    const issue = find(panel(`<div>${'好'.repeat(61)}</div>`), 'no-anchor')
    expect(issue?.severity).toBe('error')
    expect(issue?.message).toContain('61 字')
    expect(issue?.message).toContain('pad-metric')
  })
})

describe('hardcoded-color', () => {
  it('allows token colours, including a var() fallback', () => {
    expect(rules(panel('', '.pad-label{color:var(--pad-fg-3, #888)}'))).not.toContain('hardcoded-color')
  })

  it('reports a literal hex colour', () => {
    const issue = find(panel('', '.card{background:#1b1b1b}'), 'hardcoded-color')
    expect(issue?.severity).toBe('warn')
    expect(issue?.message).toContain('#1b1b1b')
  })

  it('reports rgb() and hsl()', () => {
    expect(rules(panel('', 'body{color:rgb(20 20 20)}'))).toContain('hardcoded-color')
    expect(rules(panel('', 'body{background:hsl(210 40% 20%)}'))).toContain('hardcoded-color')
  })
})

describe('tracked-caps', () => {
  it('allows normal casing and tight letter spacing', () => {
    expect(rules(panel('', '.pad-label{text-transform:none;letter-spacing:-.01em}'))).not.toContain('tracked-caps')
    expect(rules(panel('', '.pad-label{letter-spacing:.04em}'))).not.toContain('tracked-caps')
  })

  it('reports uppercase labels', () => {
    const issue = find(panel('', '.pad-label{text-transform:uppercase}'), 'tracked-caps')
    expect(issue?.severity).toBe('warn')
    expect(issue?.message).toContain('text-transform:uppercase')
  })

  it('reports letter spacing above .04em', () => {
    expect(find(panel('', '.pad-label{letter-spacing:.08em}'), 'tracked-caps')?.message).toContain('.08em')
  })
})

describe('no-error-state', () => {
  it('allows a script that checks the source before drawing', () => {
    const script = 'dsh.onData((data) => { if (!data.sources.load.ok) { document.body.textContent = data.sources.load.error } })'
    expect(rules(panel('<div class="pad-item">ok</div>', '', script))).not.toContain('no-error-state')
  })

  it('allows a try/catch', () => {
    expect(rules(panel('', '', 'try { dsh.refresh() } catch (problem) { console.log(problem) }'))).not.toContain('no-error-state')
  })

  it('stays quiet for a panel that ships no script', () => {
    expect(rules(panel('<p>静态</p>'))).not.toContain('no-error-state')
  })

  it('reports a script with no failure branch and names the check', () => {
    const issue = find(panel('', '', 'dsh.onData((data) => { document.body.textContent = String(data.sources.load.value) })'), 'no-error-state')
    expect(issue?.severity).toBe('warn')
    expect(issue?.message).toContain('sources[id].ok')
  })
})

describe('emoji-icon', () => {
  it('allows a status dot and a word', () => {
    expect(rules(panel('<div class="pad-split"><span class="pad-status is-ok">正常</span>服务器</div>'))).not.toContain('emoji-icon')
  })

  it('ignores an emoji after the first 40 characters', () => {
    expect(rules(panel(`<div class="pad-item">${'a'.repeat(40)}🔥</div>`))).not.toContain('emoji-icon')
  })

  it('reports an emoji used as the leading icon and names the replacement', () => {
    const issue = find(panel('<div class="pad-split">🔥 服务器正常</div>'), 'emoji-icon')
    expect(issue?.severity).toBe('warn')
    expect(issue?.message).toContain('🔥')
    expect(issue?.message).toContain('pad-status')
  })
})

describe('many-metrics', () => {
  it('allows four metrics', () => {
    expect(rules(panel(metric.repeat(4)))).not.toContain('many-metrics')
  })

  it('reports a fifth metric with the count', () => {
    const issue = find(panel(metric.repeat(5)), 'many-metrics')
    expect(issue?.severity).toBe('warn')
    expect(issue?.message).toContain('5 个 pad-metric')
  })
})

describe('formatLint', () => {
  it('renders nothing for a clean panel', () => {
    expect(formatLint([])).toBe('')
  })

  it('lists errors before warnings', () => {
    const issues: LintIssue[] = [
      { rule: 'many-metrics', severity: 'warn', message: '警告一' },
      { rule: 'text-wall', severity: 'error', message: '错误一' },
      { rule: 'prose', severity: 'error', message: '错误二' },
    ]
    expect(formatLint(issues)).toBe('- [error] 错误一\n- [error] 错误二\n- [warn] 警告一')
  })
})
