import { describe, it, expect } from 'vitest'
import { pickClipDurationSeconds } from './sceneClipDuration'

describe('pickClipDurationSeconds', () => {
  it('requests the scene\'s own rounded target PLUS 1s headroom when the result still falls inside Seedance\'s 4-12s accepted range', () => {
    expect(pickClipDurationSeconds(6000)).toBe(7)
    expect(pickClipDurationSeconds(7000)).toBe(8)
    expect(pickClipDurationSeconds(8000)).toBe(9)
  })

  it('rounds to the nearest whole second (then adds headroom) rather than truncating', () => {
    expect(pickClipDurationSeconds(6400)).toBe(7) // round(6.4)=6, +1
    expect(pickClipDurationSeconds(6600)).toBe(8) // round(6.6)=7, +1
  })

  // Regression for a real 4-scene job (2026-09-24) where a target under the
  // old '5'|'10' bucket's lower value got rounded down to 5 anyway — a
  // target genuinely below Seedance's own 4s floor is the only case that
  // still needs clamping up (headroom on top of an already-clamped-low
  // target still can't push it below the floor either).
  it('clamps a target below the 4s floor up to 4, even with headroom added', () => {
    expect(pickClipDurationSeconds(2000)).toBe(4) // round=2, +1=3, clamped to 4
    expect(pickClipDurationSeconds(3400)).toBe(4) // round=3, +1=4
  })

  it('clamps a target above the 12s ceiling down to 12, even with headroom added', () => {
    expect(pickClipDurationSeconds(15000)).toBe(12)
    expect(pickClipDurationSeconds(20000)).toBe(12)
  })

  it('gives progressively less real headroom as the target approaches the 12s ceiling, never exceeding it', () => {
    expect(pickClipDurationSeconds(11000)).toBe(12) // 11+1=12, full headroom, right at the ceiling
    expect(pickClipDurationSeconds(12000)).toBe(12) // 12+1=13, clamped back to 12 — no real headroom left
  })

  it('never returns the old fixed 5/10 bucket for a target that is neither — regression for the visible frozen-frame hold this replaced (avMerger.ts\'s buildSceneDurationMatchCommand header)', () => {
    expect(pickClipDurationSeconds(6000)).not.toBe(5)
    expect(pickClipDurationSeconds(6000)).not.toBe(10)
    expect(pickClipDurationSeconds(7000)).not.toBe(5)
    expect(pickClipDurationSeconds(7000)).not.toBe(10)
  })
})
