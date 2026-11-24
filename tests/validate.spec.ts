import { describe, expect, it } from 'vitest'
import {
  assertPanelData,
  MAX_HTTP_HEADER_NAME_CHARS,
  MAX_HTTP_HEADER_VALUE_CHARS,
  MAX_HTTP_URL_CHARS,
  MAX_PANEL_DATA_BYTES,
  PanelValidationError,
  validateDefinition,
} from '../src/shared/validate.ts'

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

  it('enforces HTTP url, header and GET body bounds', () => {
    const longUrl = `https://example.org/${'a'.repeat(MAX_HTTP_URL_CHARS)}`
    expect(problems({
      ...base,
      sources: [{ id: 'api', kind: 'http', url: longUrl, parse: 'json', intervalSec: 5 }],
    }).join('\n')).toMatch(/sources\[0\]\.url 不能超过/)

    expect(problems({
      ...base,
      sources: [{
        id: 'api', kind: 'http', url: 'https://example.org/x', parse: 'json', intervalSec: 5,
        headers: { ['k'.repeat(MAX_HTTP_HEADER_NAME_CHARS + 1)]: 'v' },
      }],
    }).join('\n')).toMatch(/sources\[0\]\.headers/)

    expect(problems({
      ...base,
      sources: [{
        id: 'api', kind: 'http', url: 'https://example.org/x', parse: 'json', intervalSec: 5,
        headers: { 'x-big': 'v'.repeat(MAX_HTTP_HEADER_VALUE_CHARS + 1) },
      }],
    }).join('\n')).toMatch(/sources\[0\]\.headers/)

    expect(problems({
      ...base,
      sources: [{ id: 'api', kind: 'http', url: 'https://example.org/x', body: '{"a":1}', parse: 'json', intervalSec: 5 }],
    }).join('\n')).toMatch(/不能用于 GET/)

    expect(problems({
      ...base,
      sources: [{ id: 'api', kind: 'http', url: 'https://example.org/x', method: 'GET', body: '{"a":1}', parse: 'json', intervalSec: 5 }],
    }).join('\n')).toMatch(/不能用于 GET/)

    expect(problems({
      ...base,
      sources: [{ id: 'api', kind: 'http', url: 'https://example.org/x', method: 'POST', body: '{"a":1}', parse: 'json', intervalSec: 5 }],
    })).toEqual([])
  })
})

describe('assertPanelData', () => {
  it('accepts safe JSON within the 256 KiB limit and rejects deep or oversized values', () => {
    expect(() => assertPanelData({ ok: true, items: [1, 2, 3] })).not.toThrow()
    const deep = JSON.parse('['.repeat(200) + '1' + ']'.repeat(200))
    expect(() => assertPanelData(deep)).toThrow(/JSON 嵌套超过/)
    expect(() => assertPanelData('x'.repeat(MAX_PANEL_DATA_BYTES + 1))).toThrow(/数据超过 256KB/)
    expect(() => assertPanelData(Number.NaN)).toThrow(/不支持的 JSON 值/)
  })
})
