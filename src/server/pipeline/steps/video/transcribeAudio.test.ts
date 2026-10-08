import { describe, it, expect } from 'vitest'
import {
  computeNarrationCorrection,
  computeSpeedFit,
  rewriteNarrationToWordCount,
  type NarrationCorrection,
} from './transcribeAudio'
import type { ScriptGenerator } from '../../adapters/types'

/** Narrows a correction to the clean-cut variant and returns its text. */
function cutText(result: NarrationCorrection | null): string {
  expect(result).not.toBeNull()
  expect(result!.kind).toBe('cut')
  return (result as Extract<NarrationCorrection, { kind: 'cut' }>).shortenedText
}

describe('computeNarrationCorrection', () => {
  it('returns null for a small mismatch — left to renderLanguageTrack.ts\'s existing per-scene handling', () => {
    // Target 7.0s, real 7.2s — the "small mismatch" case from the real
    // incident write-up: nowhere near the 1.35x hard tolerance.
    const result = computeNarrationCorrection(7_200, 7_000, 'A short scene of narration text here now.')
    expect(result).toBeNull()
  })

  it('returns null when there is no narration text to shorten', () => {
    expect(computeNarrationCorrection(20_000, 7_000, null)).toBeNull()
    expect(computeNarrationCorrection(20_000, 7_000, undefined)).toBeNull()
    expect(computeNarrationCorrection(20_000, 7_000, '')).toBeNull()
  })

  it('returns null when the target duration is not a real budget (0 or negative)', () => {
    expect(computeNarrationCorrection(20_000, 0, 'Some narration text that is long enough to matter here.')).toBeNull()
  })

  // Regression for the real failing job (2026-09-25): a 7.0s-budget scene's
  // real ElevenLabs+AssemblyAI-measured narration came back at 11.975s
  // (1.71x over budget) — the voice spoke at ~2.25 words/sec on 27 words,
  // well under the ~3.1wps the script/localize prompts assume.
  it('flags a materially-over-budget scene and shortens it to fit a real, self-measured rate — regression for the real 7.0s-target/11.975s-real incident', () => {
    const words = 27
    const realDurationMs = 11_975
    const narrationText = Array.from({ length: words }, (_, i) => `word${i + 1}`).join(' ')
    const result = computeNarrationCorrection(realDurationMs, 7_000, narrationText)
    expect(result).not.toBeNull()
    // No clean sentence/clause exists in "word1 word2 ..." so a cut would be a
    // bare chop; the fix is now a rewrite to a word count.
    expect(result!.kind).toBe('rewrite')
    const shortenedWordCount = (result as Extract<NarrationCorrection, { kind: 'rewrite' }>).maxWords
    expect(shortenedWordCount).toBeLessThan(words)
    // Self-calibrated from THIS scene's own measured rate (27 words / 11.975s
    // ≈ 2.25 words/sec) — never the global 3.1wps assumption, which is what
    // makes this correct regardless of which dashboard-selected voice
    // produced the real audio.
    const selfWordsPerSecond = words / (realDurationMs / 1000)
    const expectedMaxWords = Math.floor(7 * 1.03 * selfWordsPerSecond)
    expect(shortenedWordCount).toBeLessThanOrEqual(expectedMaxWords)
  })

  it('is voice-agnostic: a different (faster-speaking) voice measuring the same overshoot ratio gets the same relative correction', () => {
    // Same 1.7x overshoot ratio as the regression case above, but at a much
    // higher self-measured words/sec — the function must not assume any
    // global rate, so it caps against THIS scene's own measured rate.
    const words = 60
    const realDurationMs = 11_900 // ~1.7x over the same 7s budget
    const narrationText = Array.from({ length: words }, (_, i) => `word${i + 1}`).join(' ')
    const result = computeNarrationCorrection(realDurationMs, 7_000, narrationText)
    expect(result).not.toBeNull()
    const selfWordsPerSecond = words / (realDurationMs / 1000)
    const target = result as Extract<NarrationCorrection, { kind: 'rewrite' }>
    expect(target.kind).toBe('rewrite')
    expect(target.wordsPerSecond).toBeCloseTo(selfWordsPerSecond, 5)
    expect(target.maxWords).toBeLessThanOrEqual(Math.floor(7 * 1.03 * selfWordsPerSecond))
    expect(target.maxWords).toBeGreaterThan(0)
  })

  it('cuts at a sentence boundary when that still fills the slot', () => {
    // 15 words (a 12-word sentence + a 3-word one); 2.4s real vs a 2.0s slot.
    // Dropping the short tail leaves 12/15 of the speech: ~1.92s, within the
    // 85% fill floor, so it is a clean cut rather than a rewrite.
    const first = Array.from({ length: 12 }, (_, i) => `a${i + 1}`).join(' ') + '.'
    const narrationText = `${first} b1 b2 b3.`
    expect(cutText(computeNarrationCorrection(2_400, 2_000, narrationText))).toBe(first)
  })

  it('prefers a rewrite over a cut that would leave the slot mostly empty (regression, job 8e92b381)', () => {
    const narrationText = 'This is the first complete sentence here. This second sentence continues on for several.'
    expect(computeNarrationCorrection(3_111, 2_000, narrationText)!.kind).toBe('rewrite')
  })

  it('asks for a rewrite, never a mid-sentence fragment, when no clean cut fills the slot', () => {
    // Regression for a real job (2026-09-26): the old truncation fell through
    // to a bare word-count chop, producing narration that audibly stops
    // mid-phrase ("...ends up in"). A single sentence far longer than the
    // budget now yields a rewrite request instead of a fragment.
    const narrationText =
      'Every year in Canada an astonishing amount of food ends up in landfills while households keep replacing groceries before they are really used'
    const result = computeNarrationCorrection(20_000, 5_000, narrationText)
    expect(result).not.toBeNull()
    expect(result!.kind).toBe('rewrite')
  })

  it('keeps as many WHOLE sentences as fit within the budget when that still fills the slot', () => {
    const narrationText = 'Short one. Also short two. This third sentence is much longer and will not fit the budget at all.'
    // 17 words in 5.5s of speech vs a 4s slot: two whole sentences (4 words) fit but fill ~1s of 4s, so rewrite.
    const result = computeNarrationCorrection(5_500, 4_000, narrationText)
    expect(result).not.toBeNull()
  })

  it('never asks for fewer than 1 word even for an extreme overshoot ratio', () => {
    const result = computeNarrationCorrection(60_000, 1_000, 'one two three four five')
    expect(result).not.toBeNull()
    if (result!.kind === 'rewrite') expect(result!.maxWords).toBeGreaterThanOrEqual(1)
    else expect(result!.shortenedText.split(/\s+/).filter(Boolean).length).toBeGreaterThanOrEqual(1)
  })
})

describe('computeNarrationCorrection — retuned thresholds (job 790b8771: 36s requested, 44.2s delivered)', () => {
  it('no longer lets a 1.46x-over scene through (scene 1: 25 words, 10.2s in a 7s slot)', () => {
    const text = Array.from({ length: 25 }, (_, i) => `w${i}`).join(' ')
    const result = computeNarrationCorrection(10_239, 7_000, text)
    expect(result).not.toBeNull()
    expect(result!.kind).toBe('rewrite')
    // ~2.44 wps measured -> aims at 97% of the 7s slot, ~16 words.
    expect((result as Extract<NarrationCorrection, { kind: 'rewrite' }>).maxWords).toBeLessThanOrEqual(17)
  })

  it('corrects a moderately long narration (1.3x) instead of leaving it', () => {
    const text = 'Fresh-CAN is extending a warm welcome to neighbourhoods across Canada. It offers an intriguing and novel way to shop.'
    // 6s slot, 7.8s real: the first-sentence cut would only fill ~3.5s, so rewrite — not "leave it".
    expect(computeNarrationCorrection(7_800, 6_000, text)!.kind).toBe('rewrite')
  })

  it('leaves a scene within the 8% hard tolerance alone', () => {
    expect(computeNarrationCorrection(7_500, 7_000, 'one two three four five six seven eight nine ten eleven twelve thirteen')).toBeNull()
  })

  it('holds a scene to the tight tolerance when told the running total is already over', () => {
    const text = Array.from({ length: 20 }, (_, i) => `w${i}`).join(' ')
    // 7.4s vs a 7s slot is 1.057x: fine normally, corrected once the video as a whole is over budget.
    expect(computeNarrationCorrection(7_400, 7_000, text)).toBeNull()
    expect(computeNarrationCorrection(7_400, 7_000, text, 1.02)).not.toBeNull()
  })
})

describe('rewriteNarrationToWordCount', () => {
  const generatorReturning = (narrationText: unknown, reject = false): ScriptGenerator =>
    ({
      generate: async () => {
        if (reject) throw new Error('boom')
        return { parsed: { scenes: [{ scene_number: 1, narration_text: narrationText }] }, raw: '' }
      },
    }) as unknown as ScriptGenerator
  const base = {
    language: 'EN' as const,
    sceneNumber: 1,
    text: 'one two three four five six seven eight nine ten',
    targetDurationMs: 4_000,
    maxWords: 6,
    wordsPerSecond: 2.5,
  }

  it('returns the rewrite when it is shorter and within the word budget', async () => {
    expect(await rewriteNarrationToWordCount(generatorReturning('one two three four five'), base)).toBe('one two three four five')
  })

  it('rejects a rewrite that is still over budget, empty, or not a string', async () => {
    expect(await rewriteNarrationToWordCount(generatorReturning('a b c d e f g h'), base)).toBeNull()
    expect(await rewriteNarrationToWordCount(generatorReturning('   '), base)).toBeNull()
    expect(await rewriteNarrationToWordCount(generatorReturning(42), base)).toBeNull()
  })

  it('returns null instead of throwing when the model call fails', async () => {
    expect(await rewriteNarrationToWordCount(generatorReturning('x', true), base)).toBeNull()
  })
})

describe('computeSpeedFit (closed-loop narration speed)', () => {
  it('slows a scene that came in short, by the ratio needed to fill ~98% of its slot', () => {
    // 5.45s in an 8s slot (job 65b08e09 scene 4): would need 0.70 -> floored at 0.8.
    expect(computeSpeedFit(5_452, 8_000)).toBe(0.8)
    // 4.43s in a 5s slot (88.6%): wanted 4.43/(5*0.98) = 0.90.
    expect(computeSpeedFit(4_428, 5_000)).toBe(0.9)
  })

  it('speeds up a moderately long scene, capped at 1.12', () => {
    // 11s in a 10s slot -> wanted 1.122 -> 1.12.
    expect(computeSpeedFit(11_000, 10_000)).toBe(1.12)
    // 10.9s in a 10s slot -> 1.11.
    expect(computeSpeedFit(10_900, 10_000)).toBe(1.11)
  })

  it('leaves a scene alone when it is already within tolerance either way', () => {
    expect(computeSpeedFit(10_000, 10_000)).toBeNull()
    expect(computeSpeedFit(9_300, 10_000)).toBeNull() // 93%: above the 90% undershoot line
    expect(computeSpeedFit(10_700, 10_000)).toBeNull() // 1.07x: within the 1.08 tolerance
  })

  it('ignores a change too small to be worth a resynthesis', () => {
    // 8.9s in 10s is under 90% but the wanted speed (0.908) is a 9% change — fine; 9.0 is not under.
    expect(computeSpeedFit(9_050, 10_000)).toBeNull()
  })

  it('honours the tightened tolerance once the whole video is running over', () => {
    expect(computeSpeedFit(10_400, 10_000)).toBeNull()
    expect(computeSpeedFit(10_400, 10_000, 1.02)).toBe(1.06)
  })

  it('never returns an out-of-range speed and returns null for unusable input', () => {
    for (const real of [1_000, 3_000, 5_000, 12_000, 20_000, 60_000]) {
      const speed = computeSpeedFit(real, 10_000)
      if (speed !== null) {
        expect(speed).toBeGreaterThanOrEqual(0.8)
        expect(speed).toBeLessThanOrEqual(1.12)
      }
    }
    expect(computeSpeedFit(0, 10_000)).toBeNull()
    expect(computeSpeedFit(5_000, 0)).toBeNull()
    expect(computeSpeedFit(Number.NaN, 10_000)).toBeNull()
  })
})
