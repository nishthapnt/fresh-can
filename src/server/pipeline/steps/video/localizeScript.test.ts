import { describe, it, expect } from 'vitest'
import {
  findCrossingScenes,
  findOffBandScenes,
  isBetterFit,
  narrationDescribesCrossing,
  narrationWordRange,
} from './localizeScript'

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

describe('narrationWordRange with a measured voice rate', () => {
  it('gives a slower voice fewer words for the same slot', () => {
    const slow = narrationWordRange(7000, 2.44)
    const fast = narrationWordRange(7000, 3.1)
    expect(slow.max).toBeLessThan(fast.max)
    // Job 790b8771 scene 1: 25 words in a 7s slot at 2.44 wps was ~46% over; it must now be off-band.
    expect(slow.max).toBeLessThan(25)
  })

  it('flags the real 25-word / 7s scene as off-band at its voice rate but not at the old 3.1', () => {
    const scenes = [{ scene_number: 1, target_duration_ms: 7000 }]
    const text = Array(25).fill('word').join(' ')
    expect(findOffBandScenes(scenes, [{ scene_number: 1, narration_text: text }], 2.44)).toEqual([1])
  })
})

describe('narration entry/exit lint', () => {
  it.each([
    'The student enters the unit with a quick scan.',
    'She walks out feeling content and stress-free.',
    'They step inside and grab fresh produce.',
    'He comes out of the truck with a basket.',
    'Everyone rushes in to grab burgers.',
    'She climbs into the unit.',
    'Elle entre dans le camion avec son téléphone.',
    'Il sort du camion avec ses courses.',
  ])('flags: %s', (text) => {
    expect(narrationDescribesCrossing(text)).toBe(true)
  })

  it.each([
    'A Fresh-CAN unit is parked close by, a promising solution.',
    'The student picks fresh produce and heads home with a full bag.',
    'The truck arrives and neighbours gather around it.',
    'Dinner is easy when the groceries come to you.',
    'Elle choisit des produits frais et rentre chez elle.',
  ])('does not flag: %s', (text) => {
    expect(narrationDescribesCrossing(text)).toBe(false)
  })

  it('returns the scene numbers that describe a crossing', () => {
    expect(
      findCrossingScenes([
        { scene_number: 1, narration_text: 'A busy student rushes to class.' },
        { scene_number: 2, narration_text: 'She enters the unit and shops.' },
      ]),
    ).toEqual([2])
  })
})
