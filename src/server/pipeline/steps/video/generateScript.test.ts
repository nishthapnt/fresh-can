import { describe, it, expect } from 'vitest'
import { normalizeScriptOutput } from './generateScript'

const VALID = {
  script: 'A short script.',
  visual_description: 'The truck arrives.',
  duration_seconds: 20,
  scenes: [
    {
      scene_number: 1,
      visual_description: 'The truck pulls up.',
      shot_notes: 'Wide shot.',
      narration_intent: 'Introduce the truck.',
      target_duration_seconds: 10,
    },
    {
      scene_number: 2,
      visual_description: 'A family shops.',
      narration_intent: 'Show a family shopping.',
      target_duration_seconds: 10,
    },
  ],
}

describe('normalizeScriptOutput', () => {
  it('accepts a well-formed response as-is', () => {
    const result = normalizeScriptOutput(VALID)
    expect(result).not.toBeNull()
    expect(result!.scenes).toHaveLength(2)
    expect(result!.scenes[1].shot_notes).toBeUndefined()
  })

  it('coerces numeric fields the model sent as quoted strings — the live failure mode this fix targets', () => {
    const withStringNumbers = {
      ...VALID,
      duration_seconds: '20',
      scenes: VALID.scenes.map((s) => ({
        ...s,
        scene_number: String(s.scene_number),
        target_duration_seconds: String(s.target_duration_seconds),
      })),
    }
    const result = normalizeScriptOutput(withStringNumbers)
    expect(result).not.toBeNull()
    expect(result!.duration_seconds).toBe(20)
    expect(typeof result!.duration_seconds).toBe('number')
    expect(result!.scenes[0].scene_number).toBe(1)
    expect(typeof result!.scenes[0].scene_number).toBe('number')
  })

  it('returns null for non-JSON / non-object input (e.g. conversational prose the model prefixed the JSON with)', () => {
    expect(normalizeScriptOutput(null)).toBeNull()
    expect(normalizeScriptOutput('Sure, here is the script!')).toBeNull()
  })

  it('returns null when scenes is missing or empty', () => {
    expect(normalizeScriptOutput({ ...VALID, scenes: [] })).toBeNull()
    const { scenes: _scenes, ...withoutScenes } = VALID
    expect(normalizeScriptOutput(withoutScenes)).toBeNull()
  })

  it('returns null when a scene is missing a required field, even with otherwise-valid numbers', () => {
    const missingNarration = {
      ...VALID,
      scenes: [{ scene_number: 1, visual_description: 'x', target_duration_seconds: 10 }],
    }
    expect(normalizeScriptOutput(missingNarration)).toBeNull()
  })

  it('returns null when a number field is genuinely non-numeric, not silently coerced to 0', () => {
    const badNumber = {
      ...VALID,
      scenes: [{ ...VALID.scenes[0], scene_number: 'not-a-number' }],
    }
    expect(normalizeScriptOutput(badNumber)).toBeNull()
  })

  describe('Layer 2 planning fields (PROMPT_REFACTOR_BRIEF.md §4.3)', () => {
    const WITH_PLAN = {
      ...VALID,
      story: { hook: 'A quiet morning.', arc: 'Discovery.', resolution: 'Relief.', cta: null },
      look: { time_of_day: 'morning', lighting: 'soft', palette: 'warm', style_direction: 'documentary', camera_language: 'handheld' },
      cast_bible: [
        { id: 'mother', role: 'protagonist', age_range: '30s', appearance: 'curly hair', wardrobe: 'blue coat', distinguishing_details: 'red scarf' },
      ],
      locations: [{ id: 'street', description: 'a quiet residential street', continuity_details: 'autumn leaves on the ground' }],
      scenes: VALID.scenes.map((s, i) => ({
        ...s,
        beat: i === 0 ? 'hook' : 'payoff',
        cast_present: ['mother'],
        props_present: ['reusable bag'],
        unit_presence: 'background',
        setting: 'exterior',
        contains_food: false,
        is_final_scene: i === 1,
      })),
    }

    it('accepts a fully plan-populated response and preserves every field', () => {
      const result = normalizeScriptOutput(WITH_PLAN)
      expect(result).not.toBeNull()
      expect(result!.story).toEqual(WITH_PLAN.story)
      expect(result!.look).toEqual(WITH_PLAN.look)
      expect(result!.cast_bible).toEqual(WITH_PLAN.cast_bible)
      expect(result!.locations).toEqual(WITH_PLAN.locations)
      expect(result!.scenes[0].beat).toBe('hook')
      expect(result!.scenes[0].cast_present).toEqual(['mother'])
      expect(result!.scenes[0].unit_presence).toBe('background')
      expect(result!.scenes[0].setting).toBe('exterior')
      expect(result!.scenes[0].contains_food).toBe(false)
      expect(result!.scenes[1].is_final_scene).toBe(true)
    })

    it('omits every Layer 2 field (never fails the core script) when none are given — legacy/plain response', () => {
      const result = normalizeScriptOutput(VALID)
      expect(result).not.toBeNull()
      expect(result!.story).toBeUndefined()
      expect(result!.look).toBeUndefined()
      expect(result!.cast_bible).toBeUndefined()
      expect(result!.locations).toBeUndefined()
      expect(result!.scenes[0].beat).toBeUndefined()
      expect(result!.scenes[0].unit_presence).toBeUndefined()
    })

    it('drops a cast_bible/locations entry with no id, rather than keeping one with a made-up id', () => {
      const result = normalizeScriptOutput({
        ...VALID,
        cast_bible: [{ role: 'no id here' }],
        locations: [{ description: 'no id here either' }],
      })
      expect(result).not.toBeNull()
      expect(result!.cast_bible).toBeUndefined()
      expect(result!.locations).toBeUndefined()
    })

    it('rejects an unrecognized unit_presence/setting value rather than accepting it as free text', () => {
      const result = normalizeScriptOutput({
        ...VALID,
        scenes: [{ ...VALID.scenes[0], unit_presence: 'sometimes', setting: 'space' }, VALID.scenes[1]],
      })
      expect(result).not.toBeNull()
      expect(result!.scenes[0].unit_presence).toBeUndefined()
      expect(result!.scenes[0].setting).toBeUndefined()
    })

    it('accepts a partially-specified look/story object rather than discarding it wholesale', () => {
      const result = normalizeScriptOutput({ ...VALID, look: { lighting: 'golden hour' } })
      expect(result).not.toBeNull()
      expect(result!.look).toEqual({ lighting: 'golden hour' })
    })
  })
})
