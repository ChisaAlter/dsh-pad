import { describe, expect, it } from 'vitest'
import { classifyFrameLoad, MAX_FRAME_RECOVERIES, shouldRecoverFrame } from '../src/client/frame-lifecycle.ts'

describe('frame lifecycle', () => {
  it('treats the first load as initial and subsequent loads as navigated', () => {
    expect(classifyFrameLoad(0)).toBe('initial')
    expect(classifyFrameLoad(1)).toBe('navigated')
    expect(classifyFrameLoad(2)).toBe('navigated')
  })

  it('caps recoveries so a panel that navigates on every load cannot remount forever', () => {
    expect(MAX_FRAME_RECOVERIES).toBeGreaterThan(0)
    for (let recoveries = 0; recoveries < MAX_FRAME_RECOVERIES; recoveries++) {
      expect(shouldRecoverFrame(recoveries)).toBe(true)
    }
    expect(shouldRecoverFrame(MAX_FRAME_RECOVERIES)).toBe(false)
    expect(shouldRecoverFrame(MAX_FRAME_RECOVERIES + 10)).toBe(false)
  })
})
