import { describe, expect, it } from 'vitest'
import { FRAME_RUNTIME } from '../src/client/frame-runtime.ts'

describe('frame runtime', () => {
  it('is valid inline JavaScript', () => {
    expect(() => new Function(FRAME_RUNTIME)).not.toThrow()
  })
})
