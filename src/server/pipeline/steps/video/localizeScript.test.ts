import { describe, it, expect } from 'vitest'
import { findOffBandScenes, isBetterFit, narrationWordRange } from './localizeScript'

describe('narration length floor', () => {
  it('flags a 5s slot filled with 4 words but not a full one', () => {
    const scenes = [
      { scene_number: 1, target_duration_ms: 5000 },
      { scene_number: 2, target_duration_ms: 5000 },
    ]
    const full = Array(narrationWordRange(5000).min).fill('word').join(' ')
    expect(findOffBandScenes(scenes, [
      { scene_number: 1, narration_text: 'Discover Fresh-CAN today.' },
      { scene_number: 2, narration_text: full },
    ])).toEqual([1])
  })
  it('keeps max above min', () => {
    const r = narrationWordRange(4000)
    expect(r.max).toBeGreaterThanOrEqual(r.min)
  })
  it('also flags far-too-long narration and prefers the closer rewrite', () => {
    const scenes = [{ scene_number: 1, target_duration_ms: 5000 }]
    const long = Array(24).fill('word').join(' ')
    expect(findOffBandScenes(scenes, [{ scene_number: 1, narration_text: long }])).toEqual([1])
    const fitted = Array(narrationWordRange(5000).max).fill('word').join(' ')
    expect(isBetterFit(long, fitted, 5000)).toBe(true)
    expect(isBetterFit(fitted, long, 5000)).toBe(false)
  })
})
