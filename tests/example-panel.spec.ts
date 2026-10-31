/**
 * The shipped example panel is the reference a reader copies, so it has to obey
 * the rules in docs/design.md: tokens only, a reduced-motion branch, and no
 * lint errors at all.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { lintPanel } from '../src/host/lint.ts'

const definition = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'examples/github-status.json'), 'utf8')) as {
  title: string
  html: string
  css: string
  script: string
}

describe('examples/github-status.json', () => {
  it('passes the panel lint with no errors', () => {
    const issues = lintPanel(definition)
    const errors = issues.filter(issue => issue.severity === 'error')
    expect(errors, JSON.stringify(errors, null, 2)).toEqual([])
  })

  it('takes every colour from the theme tokens', () => {
    const hex = definition.css.match(/#[0-9a-f]{3,8}\b/gi) ?? []
    expect(hex).toEqual([])
    expect(definition.css).not.toMatch(/rgba?\(/i)
  })

  it('honours prefers-reduced-motion once it animates anything', () => {
    const animates = /transition:|animation:/.test(definition.css)
    if (animates) expect(definition.css).toMatch(/prefers-reduced-motion/)
  })

  it('has a real sentence for the empty and failed states', () => {
    expect(definition.script).toContain('这部分没取到')
    expect(definition.script).toContain('没有待处理的 PR')
  })
})
