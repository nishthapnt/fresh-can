import { describe, it, expect } from 'vitest'
import { normalizeScriptOutput } from './generateScript.js'

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
})
