import { describe, it, expect } from 'vitest'
import { applyScriptEdits, buildScriptSummary } from './updateScript'
import { maxNarrationWords, NARRATION_WORDS_PER_SECOND } from '../../../../lib/videoNarrationBudget'
import { composeLocalizeScriptSystemPrompt, BRAND_PROFILE } from '../../prompts/index'
import type { VideoSceneRow } from '../../db'

function scene(overrides: Partial<VideoSceneRow> = {}): VideoSceneRow {
  return {
    id: 'scene-1',
    content_pipeline_id: 'pipeline-1',
    generation: 1,
    scene_number: 1,
    visual_description: 'The truck pulls up.',
    shot_notes: null,
    narration_intent: { text: 'Original narration.', beat: 'setup', unit_presence: 'featured' },
    target_duration_ms: 10_000,
    created_at: new Date().toISOString(),
    ...overrides,
  }
}

describe('applyScriptEdits', () => {
  it('merges edited text into narration_intent while preserving other fields', () => {
    const result = applyScriptEdits([scene()], [{ id: 'scene-1', narration: 'New narration.' }])
    expect('error' in result).toBe(false)
    if ('error' in result) return
    expect(result.updates).toEqual([
      { sceneNumber: 1, narrationIntent: { text: 'New narration.', beat: 'setup', unit_presence: 'featured' } },
    ])
  })

  it('trims narration text', () => {
    const result = applyScriptEdits([scene()], [{ id: 'scene-1', narration: '  spaced  ' }])
    if ('error' in result) throw new Error('expected success')
    expect(result.updates[0].narrationIntent.text).toBe('spaced')
  })

  it('only returns updates for edited scenes, not every scene', () => {
    const scenes = [scene({ id: 'scene-1', scene_number: 1 }), scene({ id: 'scene-2', scene_number: 2 })]
    const result = applyScriptEdits(scenes, [{ id: 'scene-2', narration: 'Only this one.' }])
    if ('error' in result) throw new Error('expected success')
    expect(result.updates).toHaveLength(1)
    expect(result.updates[0].sceneNumber).toBe(2)
  })

  it('rejects an unknown scene id — a stale/regenerated scene plan, not a partial-apply case', () => {
    const result = applyScriptEdits([scene()], [{ id: 'not-a-real-scene', narration: 'x' }])
    expect('error' in result).toBe(true)
  })

  it('rejects an empty scenes array', () => {
    expect('error' in applyScriptEdits([scene()], [])).toBe(true)
  })

  it('rejects a non-array payload', () => {
    expect('error' in applyScriptEdits([scene()], { id: 'scene-1', narration: 'x' })).toBe(true)
  })

  it('rejects blank narration text', () => {
    const result = applyScriptEdits([scene()], [{ id: 'scene-1', narration: '   ' }])
    expect('error' in result).toBe(true)
  })

  it('rejects a malformed edit shape', () => {
    expect('error' in applyScriptEdits([scene()], [{ id: 'scene-1' }])).toBe(true)
  })

  it('handles a scene with no pre-existing narration_intent object', () => {
    const result = applyScriptEdits(
      [scene({ narration_intent: null })],
      [{ id: 'scene-1', narration: 'Fresh text.' }],
    )
    if ('error' in result) throw new Error('expected success')
    expect(result.updates[0].narrationIntent).toEqual({ text: 'Fresh text.' })
  })

  it('accepts narration right at the word budget for its scene duration', () => {
    const targetDurationMs = 10_000 // 10s
    const max = maxNarrationWords(targetDurationMs)
    const narration = Array.from({ length: max }, (_, i) => `word${i}`).join(' ')
    const result = applyScriptEdits([scene({ target_duration_ms: targetDurationMs })], [{ id: 'scene-1', narration }])
    expect('error' in result).toBe(false)
  })

  it('rejects narration that exceeds its scene budget, naming the scene and the budget', () => {
    const targetDurationMs = 10_000 // 10s
    const max = maxNarrationWords(targetDurationMs)
    const narration = Array.from({ length: max + 1 }, (_, i) => `word${i}`).join(' ')
    const result = applyScriptEdits([scene({ target_duration_ms: targetDurationMs })], [{ id: 'scene-1', narration }])
    expect('error' in result).toBe(true)
    if ('error' in result) {
      expect(result.error).toContain('Scene 1')
      expect(result.error).toContain('10s')
    }
  })
})

describe('maxNarrationWords', () => {
  it('scales with duration and stays a strict ceiling above the raw (untoleranced) rate', () => {
    const words10s = maxNarrationWords(10_000)
    const words20s = maxNarrationWords(20_000)
    expect(words20s).toBeGreaterThan(words10s)
    expect(words10s).toBeGreaterThan(10 * NARRATION_WORDS_PER_SECOND) // tolerance adds real slack
  })

  it('derives from the exact same rate composeLocalizeScriptSystemPrompt targets — the two can never silently diverge', () => {
    const prompt = composeLocalizeScriptSystemPrompt(BRAND_PROFILE, { language: 'English' })
    expect(prompt).toContain(`${NARRATION_WORDS_PER_SECOND} words per second`)
  })
})

describe('buildScriptSummary', () => {
  it('joins narration text in scene order regardless of input order', () => {
    const summary = buildScriptSummary([
      { scene_number: 2, narrationText: 'Second.' },
      { scene_number: 1, narrationText: 'First.' },
    ])
    expect(summary).toBe('First.\n\nSecond.')
  })

  it('drops scenes with blank narration text', () => {
    const summary = buildScriptSummary([
      { scene_number: 1, narrationText: 'First.' },
      { scene_number: 2, narrationText: '   ' },
    ])
    expect(summary).toBe('First.')
  })
})
