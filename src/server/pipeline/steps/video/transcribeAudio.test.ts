import { describe, it, expect } from 'vitest'
import { computeNarrationCorrection } from './transcribeAudio'

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
    const shortenedWordCount = result!.shortenedText.split(/\s+/).filter(Boolean).length
    expect(shortenedWordCount).toBeLessThan(words)
    // Self-calibrated from THIS scene's own measured rate (27 words / 11.975s
    // ≈ 2.25 words/sec) — never the global 3.1wps assumption, which is what
    // makes this correct regardless of which dashboard-selected voice
    // produced the real audio.
    const selfWordsPerSecond = words / (realDurationMs / 1000)
    const expectedMaxWords = Math.floor(7 * 1.15 * selfWordsPerSecond)
    expect(shortenedWordCount).toBeLessThanOrEqual(expectedMaxWords)
  })

  it('is voice-agnostic: a different (faster-speaking) voice measuring the same overshoot ratio gets the same relative correction', () => {
    // Same 1.7x overshoot ratio as the regression case above, but at a much
    // higher self-measured words/sec (a fast voice saying far more words in
    // the same real duration) — the function must not assume any global
    // rate, so it should still cap the shortened text against THIS scene's
    // own measured rate, not silently under- or over-correct because the
    // voice differs.
    const words = 60
    const realDurationMs = 11_900 // ~1.7x over the same 7s budget
    const narrationText = Array.from({ length: words }, (_, i) => `word${i + 1}`).join(' ')
    const result = computeNarrationCorrection(realDurationMs, 7_000, narrationText)
    expect(result).not.toBeNull()
    const shortenedWordCount = result!.shortenedText.split(/\s+/).filter(Boolean).length
    const selfWordsPerSecond = words / (realDurationMs / 1000)
    const expectedMaxWords = Math.floor(7 * 1.15 * selfWordsPerSecond)
    expect(shortenedWordCount).toBeLessThanOrEqual(expectedMaxWords)
    expect(shortenedWordCount).toBeGreaterThan(0)
  })

  it('cuts at the last sentence boundary within the kept words when one exists close to the cutoff', () => {
    // 14 words, real duration/target chosen so maxWords works out to 10 —
    // i.e. the hard word-count cut would land 3 words INTO the second
    // sentence ("...here. This second sentence"), and the boundary logic
    // should pull it back to the end of the first sentence instead.
    const narrationText = 'This is the first complete sentence here. This second sentence continues on for several.'
    const result = computeNarrationCorrection(3_111, 2_000, narrationText)
    expect(result).not.toBeNull()
    expect(result!.shortenedText).toBe('This is the first complete sentence here.')
  })

  // Regression for a real job (2026-09-26): the old truncation fell through
  // to a bare word-count chop whenever the FIRST sentence alone didn't fit
  // maxWords, producing narration that audibly stops mid-word/mid-phrase —
  // e.g. real output from that job: "Every year in Canada, an astonishing
  // amount of food ends up in" and "...replacing groceries before". A single
  // sentence longer than the whole allotted budget must now come back
  // whole (accepting it lands over the soft-tolerance aim) rather than as a
  // fragment with no clean ending — the render step's own visual trim/zoom
  // fallback safely absorbs whatever residual gap that leaves.
  it('never returns a mid-sentence fragment — keeps the whole first sentence even when it alone exceeds the word budget', () => {
    const narrationText =
      'Every year in Canada, an astonishing amount of food ends up in landfills, wasting money and resources.'
    // Real duration wildly over budget so maxWords lands well inside this
    // one long sentence (no earlier sentence boundary exists at all).
    const result = computeNarrationCorrection(20_000, 5_000, narrationText)
    expect(result).not.toBeNull()
    const shortened = result!.shortenedText
    // Ends on a real sentence boundary, not a bare word.
    expect(/[.!?]$/.test(shortened)).toBe(true)
    // Falls back to the comma clause here since the sentence itself has no
    // terminal punctuation in this fixture — either way, never a fragment
    // like "...ends up in".
    expect(shortened).not.toMatch(/\bin$/)
    expect(shortened).not.toMatch(/\band$/)
    expect(shortened).not.toMatch(/\bbefore$/)
  })

  it('keeps as many WHOLE sentences as fit within the budget, not just the first, when several fit', () => {
    const narrationText = 'Short one. Also short two. This third sentence is much longer and will not fit the budget at all.'
    const result = computeNarrationCorrection(20_000, 3_000, narrationText)
    expect(result).not.toBeNull()
    expect(result!.shortenedText.endsWith('.')).toBe(true)
    expect(result!.shortenedText).toContain('Short one.')
  })

  it('never reduces below 1 word even for an extreme overshoot ratio', () => {
    const result = computeNarrationCorrection(60_000, 1_000, 'one two three four five')
    expect(result).not.toBeNull()
    expect(result!.shortenedText.split(/\s+/).filter(Boolean).length).toBeGreaterThanOrEqual(1)
  })
})

describe('computeNarrationCorrection — never collapses a slot (regression, job 8e92b381)', () => {
  it('keeps a moderately long two-sentence narration instead of cutting it to ~58% of the slot', () => {
    const text = 'Fresh-CAN is extending a warm welcome to neighbourhoods across Canada. It offers an intriguing and novel way to shop.'
    // 6s slot, 7.8s real (1.3x): the first-sentence cut would land ~3.5s.
    expect(computeNarrationCorrection(7_800, 6_000, text)).toBeNull()
  })
})
