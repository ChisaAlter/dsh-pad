import { afterEach, describe, expect, it, vi } from 'vitest'
import { readViewport } from '../src/client/window-controls.ts'

function desktop({ controls = null, platform = 'win32', width = '', height = '', visibility = 'visible' }: {
  controls?: { left: number, top: number, right: number, bottom: number, width: number, height: number } | null
  platform?: string
  width?: string
  height?: string
  visibility?: string
} = {}): void {
  vi.stubGlobal('window', { innerWidth: 1000, innerHeight: 700 })
  vi.stubGlobal('document', {
    documentElement: { dataset: { platform } },
    getElementById: (id: string) => id === 'dshd-shell-controls' && controls !== null ? { getBoundingClientRect: () => controls } : null,
  })
  vi.stubGlobal('getComputedStyle', () => ({
    visibility,
    getPropertyValue: (name: string) => name === '--dshd-wco-controls' ? width : name === '--dshd-wco-caption' ? height : '',
  }))
}

afterEach(() => vi.unstubAllGlobals())

describe('desktop window controls', () => {
  it('uses the real control rectangle including fractional CSS pixels', () => {
    desktop({ controls: { left: 888.5, top: 0, right: 1000.5, bottom: 48, width: 112, height: 48 }, width: '99px', height: '20px' })
    expect(readViewport()).toEqual({ width: 1000, height: 700, controls: { left: 888.5, top: 0, right: 1000.5, bottom: 48 } })
  })

  it('reserves desktop insets before the shell inserts its controls', () => {
    desktop({ width: '112px', height: '48px' })
    expect(readViewport().controls).toEqual({ left: 888, top: 0, right: 1000, bottom: 48 })
  })

  it('leaves ordinary browser pages and native macOS controls unrestricted', () => {
    desktop()
    expect(readViewport().controls).toBeUndefined()
    desktop({ platform: 'darwin', width: '112px', height: '48px' })
    expect(readViewport().controls).toBeUndefined()
  })

  it('does not reserve space for hidden controls even when insets remain', () => {
    desktop({ controls: { left: 888, top: 0, right: 1000, bottom: 48, width: 112, height: 48 }, visibility: 'hidden', width: '112px', height: '48px' })
    expect(readViewport().controls).toBeUndefined()
    desktop({ controls: { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }, width: '112px', height: '48px' })
    expect(readViewport().controls).toBeUndefined()
  })
})
