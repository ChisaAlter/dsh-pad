import { describe, expect, it } from 'vitest'
import { PanelValidationError, validateDefinition } from '../src/shared/validate.ts'

const limits = { minIntervalSec: 2, minAgentMinutes: 15 }
const base = { title: '服务器性能', html: '<div></div>', css: '', script: '', height: 'auto', sources: [] }

function problems(raw: Record<string, unknown>): readonly string[] {
  try {
    validateDefinition(raw, limits)
  } catch (error) {
    if (error instanceof PanelValidationError) return error.problems
    throw error
  }
  return []
}

describe('validateDefinition', () => {
  it('normalizes a complete definition', () => {
    const def = validateDefinition({
      ...base,
      title: '  服务器性能 ',
      icon: '🖥️',
      sources: [
        { id: 'host', kind: 'command', command: 'uptime', parse: 'text', intervalSec: 3 },
        { id: 'api', kind: 'http', url: 'https://example.org/x', headers: { A: '{{env:KEY}}' }, parse: 'json', intervalSec: 60, timeoutMs: 5000 },
      ],
      agent: { instruction: '刷新', everyMinutes: 30 },
    }, limits)
    expect(def.title).toBe('服务器性能')
    expect(def.sources).toHaveLength(2)
    expect(def.sources[1]).toMatchObject({ kind: 'http', headers: { A: '{{env:KEY}}' }, timeoutMs: 5000 })
    expect(def.agent).toEqual({ instruction: '刷新', everyMinutes: 30 })
  })

  it('keeps agent: null so an update can drop agent refresh', () => {
    expect(validateDefinition({ ...base, agent: null }, limits).agent).toBeNull()
  })

  it('keeps one panel’s own model', () => {
    const def = validateDefinition({
      ...base,
      model: { provider: 'magpie', model: 'codex/gpt-6.1-sol', reasoningEffort: 'max' },
      agent: { instruction: '刷新', everyMinutes: 60 },
    }, limits)
    expect(def.model).toEqual({ provider: 'magpie', model: 'codex/gpt-6.1-sol', reasoningEffort: 'max' })
    expect(problems({ ...base, model: { provider: '', model: '' } }))
      .toEqual(expect.arrayContaining([expect.stringMatching(/model\.provider/), expect.stringMatching(/model\.model/)]))
  })

  it('reports every problem at once', () => {
    const found = problems({
      title: '',
      html: 1,
      height: 20,
      sources: [
        { id: 'Bad Id', kind: 'command', command: '', parse: 'xml', intervalSec: 1 },
        { id: 'web', kind: 'http', url: 'file:///etc/passwd', parse: 'json', intervalSec: 5 },
        { id: 'x', kind: 'ftp', parse: 'text', intervalSec: 5 },
      ],
      agent: { instruction: 'x', everyMinutes: 1 },
    })
    expect(found.join('\n')).toMatch(/title/)
    expect(found.join('\n')).toMatch(/html/)
    expect(found.join('\n')).toMatch(/height/)
    expect(found.join('\n')).toMatch(/sources\[0\]\.id/)
    expect(found.join('\n')).toMatch(/sources\[0\]\.parse/)
    expect(found.join('\n')).toMatch(/sources\[0\]\.intervalSec 必须是 2/)
    expect(found.join('\n')).toMatch(/sources\[0\]\.command/)
    expect(found.join('\n')).toMatch(/sources\[1\]\.url/)
    expect(found.join('\n')).toMatch(/sources\[2\]\.kind/)
    expect(found.join('\n')).toMatch(/agent\.everyMinutes 必须是 15/)
  })

  it('rejects duplicate source ids', () => {
    const source = { id: 'a', kind: 'command', command: 'true', parse: 'text', intervalSec: 5 }
    expect(problems({ ...base, sources: [source, source] })).toEqual(['sources 里的 id「a」重复了'])
  })

  it('caps the code size', () => {
    expect(problems({ ...base, script: 'x'.repeat(200_001) })[0]).toMatch(/合计不能超过/)
  })
})
