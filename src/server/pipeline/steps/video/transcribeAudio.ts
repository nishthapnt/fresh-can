import type { SupabaseClient } from '@supabase/supabase-js'
import type { ScriptGenerator, TranscriptionService, VoiceSynthesizer } from '../../adapters/types'
import { ProviderCallError } from '../../adapters/types'
import type { VideoStorageUploader } from '../../adapters/storage'
import {
  claimTrack,
  hasSucceededStep,
  recordStepAttempt,
  recordTrackRetryableFailure,
  markTrackFailed,
  getVideoScenes,
  getVideoSceneAudioRows,
  upsertVideoCaptions,
  upsertVideoSceneAudio,
  isTrackFailed,
  type TrackRow,
} from '../../db'
import { hasExceededMaxAttempts, isReadyToRetry, MAX_ATTEMPTS } from '../../lib/backoff'
import { BRAND_PROFILE, composeLocalizeScriptSystemPrompt } from '../../prompts/index'
import { narrationWordCount } from '../../../../lib/videoNarrationBudget'

const POLL_INTERVAL_MS = 3000
const POLL_TIMEOUT_MS = 120_000

// Confirmed live 2026-09-21 against the real AssemblyAI API: `audio_duration`
// is Math.ceil() of the real file length in SECONDS, not a precise
// measurement (a real 6.09s file reported `audio_duration: 7`, a real 7.24s
// file reported `8` — every scene in the same job showed the same whole-
// second-ceiling pattern). This function used to use that field directly as
// "the real duration", which is what it was added to replace synthesizeVoice
// .ts's word-count estimate with — but a value that's up to ~1s inflated
// PER SCENE, compounding across every scene into cumulativeOffsetMs below,
// reproduces the exact same class of drift this whole mechanism exists to
// avoid, just smaller and harder to notice. It also over-pads Pass 0's
// per-scene video hold (renderLanguageTrack.ts) well past what the real clip
// needs, and inflates totalDurationSeconds enough that the mux pass's fade
// (avMerger.ts's buildMuxCommand) computes a fadeStart past the real,
// `-shortest`-trimmed video's actual end — confirmed live as the root cause
// of a real render showing frozen holds at every scene cut, no visible fade,
// and end-of-video captions never appearing. The word timings themselves
// (outcome.words) are real, millisecond-precise AssemblyAI output — the last
// word's own `end` timestamp plus a small trailing-silence buffer is a far
// more accurate "how long is this scene's real content" signal than the
// coarse audio_duration field, so that's what's used below instead.
const TRAILING_SILENCE_BUFFER_MS = 300

interface WordTiming {
  text: string
  start: number
  end: number
}

// Confirmed live 2026-09-25/26: a real job's per-scene real (AssemblyAI-
// measured) narration duration landed 53-92% over its own target_duration_ms
// (target 7-9s scenes measuring 10.7-13.9s), because that job's ElevenLabs
// voice spoke meaningfully slower than the rest of the fleet — a real
// per-voice effect, not just noise (two jobs sharing that same voice_id both
// ran over budget; every other voice checked ran at/under it). A single
// global words-per-second assumption (composeLocalizeScriptSystemPrompt's
// own NARRATION_WORDS_PER_SECOND) can never be right for every voice a user
// might pick from the dashboard, so this only ever reacts to THIS scene's
// own just-measured real rate below — self-calibrating per voice/scene,
// never assuming any fixed rate — rather than trying to predict the
// mismatch ahead of time. `HARD` gates when a correction fires at all (a
// small mismatch — e.g. a 7.0s scene running 7.2s — is left to
// renderLanguageTrack.ts's existing per-scene duration-match pass, same as
// before); `SOFT` is the ceiling the shortened retry targets, deliberately
// looser than 1.0 so the corrected narration doesn't get cut uncomfortably
// close to its budget.
//
// Tightened 2026-09-26 (1.35->1.15, 1.15->1.05) as the upstream half of
// making renderLanguageTrack.ts's visual fallback (avMerger.ts's small-gap
// zoom / large-gap loop) rarely necessary rather than routinely relied on —
// the other half is sceneClipDuration.ts's own +1s KIE request headroom.
// Keeping narration itself much closer to target is what makes "actual
// video duration >= actual audio duration" hold on its own most of the
// time, instead of depending on the render-time fallback to paper over a
// large narration overshoot. The correction logic/flow below is unchanged —
// only these two numbers moved.
//
// Retuned 2026-10-08 (1.15->1.08, 1.05->1.03, MIN_FILL 0.7->0.85, and the
// "unless EXTREME_OVERSHOOT" escape removed): real job 790b8771 (36s
// requested, 44.2s delivered) had scenes at 1.46x and 1.37x their slot that
// were NEVER corrected, because the only available fix — a sentence-level
// cut — would have left the slot under 70% full, and the guard preferred an
// over-long scene to a short one. Both are wrong: the video's length is the
// sum of its scenes, so an over-long scene silently lengthens the whole
// video. When no clean cut lands near the slot, the correction is now an LLM
// rewrite to the exact word count (see rewriteNarrationToWordCount), not
// "leave it".
const OVERSHOOT_HARD_TOLERANCE = 1.08
const OVERSHOOT_SOFT_TOLERANCE = 1.03
// Once the video as a whole is running over (see
// OVERSHOOT_RUNNING_TOTAL_THRESHOLD), a scene only has to be this close to
// its slot to be left alone — the budget is already spent.
const OVERSHOOT_TIGHT_TOLERANCE = 1.02
const OVERSHOOT_RUNNING_TOTAL_THRESHOLD = 1.05
// A cut must leave at least this much of the slot filled; otherwise the
// correction is a rewrite instead.
const MIN_FILL_AFTER_CUT = 0.85
// A rewrite aims slightly under the slot so TTS variance doesn't push it
// back over.
const REWRITE_TARGET_FILL = 0.97

/** Word-level truncation — NEVER returns a fragment with no clean ending
 *  (confirmed live 2026-09-26: the old version's "don't sacrifice more than
 *  ~60% of the allotted words" guard let it fall through to a bare
 *  word-count chop whenever the first sentence alone didn't fit the
 *  budget — for a scene whose real narration ran well over target, that's
 *  the common case, not the rare one, and it produced narration that
 *  audibly stops mid-word/mid-phrase, e.g. "...ends up in" / "...and").
 *  Priority order, each tried only if the previous one found nothing:
 *   1. the last complete sentence that fits within maxWords (keeps as many
 *      whole sentences as the budget allows, not just the first);
 *   2. the last comma-delimited clause that fits within maxWords;
 *   3. the first complete sentence in the ORIGINAL text, even past
 *      maxWords — accepting the narration lands over its soft-tolerance
 *      aim (there is no second retry either way — see
 *      OVERSHOOT_SOFT_TOLERANCE's own header) is far better than a
 *      grammatically broken result, and the render step's own visual
 *      trim/zoom fallback (avMerger.ts) safely absorbs whatever residual
 *      gap that leaves;
 *   4. the first comma clause in the original text;
 *   5. only if the text has no sentence-ending punctuation or comma
 *      ANYWHERE (no safe cut point exists at all): null — the caller asks
 *      for a rewrite to the word count instead of chopping mid-phrase
 *      (retuned 2026-10-08; this used to return the raw word-count chop). */
function truncateNarrationToWordCount(text: string, maxWords: number): string | null {
  const words = text.trim().split(/\s+/).filter(Boolean)
  if (words.length <= maxWords) return text
  const truncated = words.slice(0, maxWords).join(' ')

  const lastSentenceEnd = Math.max(truncated.lastIndexOf('. '), truncated.lastIndexOf('! '), truncated.lastIndexOf('? '))
  if (lastSentenceEnd > 0) return truncated.slice(0, lastSentenceEnd + 1).trim()

  const lastComma = truncated.lastIndexOf(', ')
  if (lastComma > 0) return `${truncated.slice(0, lastComma).trim()}.`

  const firstSentenceEnd = Math.max(text.indexOf('. '), text.indexOf('! '), text.indexOf('? '))
  if (firstSentenceEnd > 0) return text.slice(0, firstSentenceEnd + 1).trim()

  const firstComma = text.indexOf(', ')
  if (firstComma > 0) return `${text.slice(0, firstComma).trim()}.`

  // No safe cut point exists anywhere in the text. A bare word-count chop
  // would audibly stop mid-phrase, so the caller rewrites instead.
  return null
}

export type NarrationCorrection =
  | { kind: 'cut'; shortenedText: string }
  | { kind: 'rewrite'; maxWords: number; wordsPerSecond: number }

/** Pure decision logic, unit-tested on its own (transcribeAudio.test.ts):
 *  does this scene's REAL measured duration overshoot its own budget badly
 *  enough to need shortening, and if so, how? Self-calibrated from THIS
 *  scene's own just-measured words/sec — never a fleet-wide or per-voice
 *  guess — so it behaves correctly for any ElevenLabs voice, including one
 *  never seen before. Returns null for a small mismatch (left to the
 *  existing render-time handling) or when there's no narration text to
 *  shorten. A clean sentence/clause cut is preferred when it still fills the
 *  slot; otherwise the caller is asked to rewrite to `maxWords`. */
export function computeNarrationCorrection(
  realDurationMs: number,
  targetDurationMs: number,
  narrationText: string | null | undefined,
  tolerance: number = OVERSHOOT_HARD_TOLERANCE,
): NarrationCorrection | null {
  if (!narrationText || targetDurationMs <= 0) return null
  if (realDurationMs <= targetDurationMs * tolerance) return null

  const words = narrationWordCount(narrationText)
  if (words === 0) return null
  const selfWordsPerSecond = words / (realDurationMs / 1000)
  const maxWords = Math.max(1, Math.floor((targetDurationMs / 1000) * OVERSHOOT_SOFT_TOLERANCE * selfWordsPerSecond))
  if (maxWords >= words) return null

  const shortenedText = truncateNarrationToWordCount(narrationText, maxWords)
  if (shortenedText !== null && shortenedText !== narrationText) {
    // Sentence-level chopping can overshoot DOWNWARD: real job 8e92b381 cut a
    // two-sentence narration to its first sentence, landing at ~58% of the
    // slot — and since a scene's rendered length IS its narration length,
    // that shrinks the whole video (18s delivered vs 32s requested). So only
    // take a cut that still fills the slot.
    const predictedShortenedMs = (narrationWordCount(shortenedText) / selfWordsPerSecond) * 1000
    if (predictedShortenedMs >= targetDurationMs * MIN_FILL_AFTER_CUT) return { kind: 'cut', shortenedText }
  }

  const rewriteWords = Math.max(1, Math.floor((targetDurationMs / 1000) * REWRITE_TARGET_FILL * selfWordsPerSecond))
  return { kind: 'rewrite', maxWords: rewriteWords, wordsPerSecond: selfWordsPerSecond }
}

/** Asks the script model to rewrite one scene's narration to at most
 *  `maxWords` words, same meaning and tone. Text-only (no TTS spend until the
 *  caller accepts the result). Returns null on any failure or if the rewrite
 *  is not actually shorter and within budget — the caller then keeps the
 *  original narration, never failing the track. */
export async function rewriteNarrationToWordCount(
  scriptGenerator: ScriptGenerator,
  opts: {
    language: 'EN' | 'FR'
    sceneNumber: number
    text: string
    targetDurationMs: number
    maxWords: number
    wordsPerSecond: number
  },
): Promise<string | null> {
  try {
    const result = await scriptGenerator.generate({
      systemPrompt: composeLocalizeScriptSystemPrompt(BRAND_PROFILE, {
        language: opts.language === 'FR' ? 'French' : 'English',
        wordsPerSecond: opts.wordsPerSecond,
      }),
      userPrompt: JSON.stringify([
        {
          scene_number: opts.sceneNumber,
          narration_intent: opts.text,
          target_duration_seconds: Math.round(opts.targetDurationMs / 1000),
          min_words: Math.max(1, Math.floor(opts.maxWords * 0.85)),
          max_words: opts.maxWords,
          previous_narration_off_length: opts.text,
        },
      ]),
      stepName: 'localize_script',
    })
    const parsed = result.parsed as { scenes?: { scene_number?: unknown; narration_text?: unknown }[] } | null
    const text = parsed?.scenes?.[0]?.narration_text
    if (typeof text !== 'string' || text.trim() === '') return null
    const count = narrationWordCount(text)
    if (count > opts.maxWords || count >= narrationWordCount(opts.text)) return null
    return text.trim()
  } catch {
    return null
  }
}

// Closed-loop speed fit (2026-10-08). Word-count budgeting alone cannot hit a
// scene's slot: the same voice speaks 2.4-3.6 words/sec depending on the
// text (real jobs: 790b8771 ran 2.4-2.7, 65b08e09 ran 2.9-3.6), so scenes
// land 15-30% either side of their slot and the video's length drifts the
// same way (44.2s and then 31.1s for a 36s request). After a scene's real
// duration is MEASURED, ElevenLabs' voice speed (0.7-1.2) is the one knob
// that moves it without touching the wording: a short scene is re-spoken
// slower, a moderately long one faster.
//
// Bounded to a natural-sounding range, not the API's full one: below 0.8
// narration drags, above ~1.12 it sounds rushed.
const SPEED_MIN = 0.8
const SPEED_MAX = 1.12
// A scene under this fraction of its slot is slowed down to fill it.
const UNDERSHOOT_THRESHOLD = 0.9
// Aim a hair under the slot so measurement noise cannot tip it back over.
const SPEED_AIM_FILL = 0.98
// A speed change smaller than this is not worth a resynthesis + retranscription.
const SPEED_MIN_CHANGE = 0.04
// Overshoot up to this ratio is fixed by speed alone (wording untouched);
// beyond it the narration genuinely has too many words (cut / rewrite).
const SPEED_ONLY_OVERSHOOT_MAX = 1.15

/** The voice speed that would bring a scene's measured duration onto its
 *  slot, or null when it is already close enough (or no bounded speed helps).
 *  `tolerance` is the same overshoot tolerance computeNarrationCorrection uses
 *  (tightened once the whole video is running over). */
export function computeSpeedFit(
  realDurationMs: number,
  targetDurationMs: number,
  tolerance: number = OVERSHOOT_HARD_TOLERANCE,
): number | null {
  if (!(realDurationMs > 0) || !(targetDurationMs > 0)) return null
  const ratio = realDurationMs / targetDurationMs
  const wanted = realDurationMs / (targetDurationMs * SPEED_AIM_FILL)
  let speed: number
  if (ratio < UNDERSHOOT_THRESHOLD) speed = Math.max(SPEED_MIN, wanted)
  else if (ratio > tolerance) speed = Math.min(SPEED_MAX, wanted)
  else return null
  speed = Math.round(speed * 100) / 100
  return Math.abs(speed - 1) < SPEED_MIN_CHANGE ? null : speed
}

// Cancellation check (2026-09-22, P0 fix) — see isPipelineFailed's header
// (db.ts, isTrackFailed is its track-scoped twin) and generateSceneVisual
// .ts's own pollUntilDone for the full reasoning; not duplicated here.
async function pollUntilDone(
  client: SupabaseClient,
  trackId: string,
  service: TranscriptionService,
  jobRef: { providerRef: string },
): Promise<
  | { words: WordTiming[]; audioDurationMs?: number }
  | { failed: true; detail: string }
  | { timedOut: true }
  | { cancelled: true }
> {
  const deadline = Date.now() + POLL_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (await isTrackFailed(client, trackId)) {
      console.log('[transcribe_captions] cancelled — stopping poll early')
      return { cancelled: true }
    }
    const result = await service.poll(jobRef)
    if (result.status === 'ready') {
      const words = Array.isArray(result.timingData) ? (result.timingData as WordTiming[]) : []
      return { words, audioDurationMs: result.audioDurationMs }
    }
    if (result.status === 'failed') return { failed: true, detail: result.detail }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
  }
  return { timedOut: true }
}

/**
 * Per-language-track step — gated on EVERY scene's synthesize_voice having
 * succeeded (there is ONE combined video_captions row per track, not per
 * scene, per ARCHITECTURE.MD §5 — captions are never shared across
 * languages, but they ARE combined across scenes within one language).
 *
 * No audio-concatenation service exists yet (that's render's job, M4), so
 * this transcribes each scene's audio SEPARATELY and stitches the resulting
 * word timings into one flat, cumulative-offset timeline — using each
 * scene's own last transcribed word's real `end` timestamp (plus
 * TRAILING_SILENCE_BUFFER_MS) as the additive offset for the next scene,
 * falling back to TranscriptionPollResult.audioDurationMs or video_scene_audio
 * .duration_ms (synthesizeVoice's word-count ESTIMATE) only if a scene
 * somehow has zero transcribed words. Using the word-count estimate here
 * unconditionally used to be the only option — that drifted captions out of
 * sync with the real render's audio track (concatenated from these same
 * real audio files in renderLanguageTrack.ts) whenever ElevenLabs' actual
 * speaking pace differed from the flat words-per-second assumption behind
 * the estimate, and the error compounded scene over scene. A later attempt
 * to fix that by using AssemblyAI's own audio_duration field instead turned
 * out to have the same compounding-drift problem one level down — see
 * TRAILING_SILENCE_BUFFER_MS's header for why that field itself is too
 * coarse to use. The real per-word timing is already sitting in every
 * poll() response this step already makes — no extra API call needed to use
 * it. Output shape is exactly the {text,start,end}[] array worker/src/
 * adapters/avMerger.ts's buildFfmpegCommand already expects for caption
 * burn-in — no further transformation needed at render time.
 *
 * Also persists that same real duration back into
 * video_scene_audio.duration_ms (overwriting the estimate) once known —
 * renderLanguageTrack.ts's per-scene duration-match pass (M4) needs the
 * REAL length of THIS scene's audio to decide how much to hold/trim the
 * shared video clip by, and without this write it would still be reading
 * the same stale estimate this function itself stopped trusting.
 *
 * On success, advances the track to 'awaiting_shared' (the literal DB
 * value, not ARCHITECTURE.MD's prose name "awaiting_visuals") — all
 * per-language work is done; only the render step (M4) remains, gated on
 * the shared visuals being ready too.
 */
export async function runTranscribeAudio(
  client: SupabaseClient,
  track: TrackRow,
  contentPipelineId: string,
  transcriptionService: TranscriptionService,
  backoffBaseDelayMs = 5000,
  // Optional — when omitted, behaves exactly as before (every existing
  // caller/test that doesn't pass this keeps working unchanged). When
  // given, enables the narration-overshoot correction above: a scene whose
  // real measured duration badly overshoots its own budget gets ONE
  // shortened re-synthesis + re-transcription attempt, best-effort (a
  // failure here just falls back to today's behavior, never fails the
  // whole track — no new state machine).
  correction?: {
    voiceSynthesizer: VoiceSynthesizer
    uploader: VideoStorageUploader
    jobId: string
    /** Enables the rewrite fallback (see computeNarrationCorrection): when no
     *  clean cut lands near the slot, the narration is rewritten to a word
     *  count instead. Omitted = such scenes keep their original narration. */
    scriptGenerator?: ScriptGenerator
    /** Falls back to BRAND_PROFILE.videoVoiceIds[track.language], same
     *  resolution order synthesizeVoice.ts already uses. */
    voiceId?: string | null
  },
): Promise<{ ran: boolean }> {
  if (track.status !== 'generating') return { ran: false }

  const generation = track.master_generation_used
  const stepName = 'transcribe_captions'
  const alreadySucceeded = await hasSucceededStep(client, { contentLanguageTrackId: track.id }, stepName, generation)
  if (alreadySucceeded) {
    // The step's own artifacts (video_captions, the succeeded pipeline_steps
    // row) already exist, but track.status is still 'generating' — this
    // step is the ONLY thing that ever advances a track to 'awaiting_shared'
    // (see this function's own header), and that transition happens AFTER
    // recordStepAttempt below, in the same try block. A crash/restart
    // between those two writes — or any external process that resets
    // track.status back without also rolling back the already-succeeded
    // step record (confirmed live 2026-09-19 during a manual recovery) —
    // would otherwise leave this track stuck at 'generating' forever: every
    // future call hits this exact branch and returns before ever reaching
    // the real claimTrack call. Catching up here, not just on the fresh-run
    // path below, is what makes this step properly resumable rather than
    // only resumable from a mid-run crash. claimTrack's CAS (WHERE status =
    // 'generating') makes this a safe no-op if the transition already
    // happened through the normal path.
    await claimTrack(client, track.id, 'generating', 'awaiting_shared', { current_step: 'awaiting_shared' })
    return { ran: false }
  }

  const scenes = await getVideoScenes(client, contentPipelineId)
  if (scenes.length === 0) return { ran: false }
  const audioRows = await getVideoSceneAudioRows(client, track.id, generation)
  const allAudioReady = scenes.every(
    (scene) => audioRows.find((a) => a.video_scene_id === scene.id)?.status === 'ready',
  )
  if (!allAudioReady) return { ran: false } // not every scene's audio exists yet

  if (track.last_error) {
    const ready = isReadyToRetry({
      lastError: track.last_error,
      retryCount: track.retry_count,
      updatedAt: new Date(track.updated_at),
      baseDelayMs: backoffBaseDelayMs,
    })
    if (!ready) return { ran: false } // backoff window hasn't elapsed yet
  }

  const attemptNumber = track.retry_count + 1
  try {
    const combinedWords: WordTiming[] = []
    let cumulativeOffsetMs = 0
    // Running totals across scenes already finalized, so a video that is
    // already over budget gets its later scenes held to a tighter tolerance —
    // the finished length is the SUM of the scenes, so each scene only
    // slightly over still adds up to a visibly long video.
    let cumulativeTargetMs = 0

    for (const scene of scenes) {
      const audio = audioRows.find((a) => a.video_scene_id === scene.id)!
      const jobRef = await transcriptionService.submit({ audioUrl: audio.file_url! })
      const outcome = await pollUntilDone(client, track.id, transcriptionService, jobRef)

      if ('cancelled' in outcome) {
        // A plain `return` here (inside this function's own try block)
        // skips the catch below entirely — no failure gets recorded, and
        // the loop never reaches a later scene's submit() call, satisfying
        // "don't start the next expensive operation after cancellation."
        console.log(`[transcribe_captions] cancelled at scene ${scene.scene_number} — stopping, not recording a failure`)
        return { ran: true }
      }
      if (!('words' in outcome)) {
        const detail = 'failed' in outcome ? outcome.detail : 'AssemblyAI poll timed out'
        throw new ProviderCallError('assemblyai', null, `scene ${scene.scene_number}: ${detail}`)
      }

      // Prefer the real per-word timing (millisecond-precise) over the
      // coarse whole-second audio_duration field — see TRAILING_SILENCE_
      // BUFFER_MS's header. Only falls back to audioDurationMs/duration_ms
      // when a scene somehow has zero transcribed words.
      let words = outcome.words
      let lastWord = words[words.length - 1]
      let realDurationMs =
        lastWord !== undefined
          ? lastWord.end + TRAILING_SILENCE_BUFFER_MS
          : (outcome.audioDurationMs ?? audio.duration_ms ?? 0)

      let correctedNarrationText: string | undefined
      let correctedFileUrl: string | undefined

      if (correction) {
        const runningOvershoot = cumulativeTargetMs > 0 ? cumulativeOffsetMs / cumulativeTargetMs : 1
        const tolerance =
          runningOvershoot > OVERSHOOT_RUNNING_TOTAL_THRESHOLD ? OVERSHOOT_TIGHT_TOLERANCE : OVERSHOOT_HARD_TOLERANCE
        const voiceId = correction.voiceId ?? BRAND_PROFILE.videoVoiceIds?.[track.language]

        // Re-synthesizes `text` (at `speed`, if given), uploads it, and
        // re-transcribes it. Returns the new measurement, null when it did not
        // complete (the caller keeps what it had — never fails the track), or
        // 'cancelled'.
        const resynthesize = async (
          text: string,
          pathTag: string,
          speed?: number,
        ): Promise<{ words: WordTiming[]; durationMs: number; fileUrl: string } | null | 'cancelled'> => {
          try {
            if (!voiceId) throw new Error('no voice id available for the narration retry')
            const synthResult = await correction.voiceSynthesizer.synthesize({
              text,
              voiceId,
              ...(speed !== undefined ? { speed } : {}),
            })
            // A DISTINCT path from synthesizeVoice.ts's own upload (not the
            // same `scene-N-audio.mp3` re-uploaded with upsert) — confirmed
            // live (2026-09-26) that reusing the same path made AssemblyAI's
            // fetch of this "corrected" audio come back at nearly the same
            // duration as the ORIGINAL narration, not the real corrected one:
            // same class of stale-cached-URL issue this repo already hit once
            // for the final rendered video (see mediaUrl.ts's cache-busting
            // commit) — a same-path overwrite can serve a cached copy of the
            // old bytes to an external fetcher even though Storage itself has
            // the new ones. A new path is a guaranteed cache miss, not a
            // heuristic fix.
            // `fit-<speed*100>` in the name is READ BACK by db.getMeasuredWordsPerSecond
            // to undo the speed change when calibrating a voice's natural pace.
            const path = `${correction.jobId}/${track.language}/scene-${scene.scene_number}-audio-${pathTag}.mp3`
            const newFileUrl = await correction.uploader.uploadBuffer(path, synthResult.audioBuffer, 'audio/mpeg')
            const retryJobRef = await transcriptionService.submit({ audioUrl: newFileUrl })
            const retryOutcome = await pollUntilDone(client, track.id, transcriptionService, retryJobRef)
            if ('cancelled' in retryOutcome) return 'cancelled'
            if (!('words' in retryOutcome)) {
              const detail = 'failed' in retryOutcome ? retryOutcome.detail : 'AssemblyAI poll timed out'
              console.log(
                `[transcribe_captions] scene ${scene.scene_number}: ${pathTag} retry did not complete (${detail}) — keeping the previous narration audio`,
              )
              return null
            }
            const last = retryOutcome.words[retryOutcome.words.length - 1]
            return {
              words: retryOutcome.words,
              durationMs: last !== undefined ? last.end + TRAILING_SILENCE_BUFFER_MS : (retryOutcome.audioDurationMs ?? 0),
              fileUrl: newFileUrl,
            }
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            console.log(
              `[transcribe_captions] scene ${scene.scene_number}: ${pathTag} attempt failed (${message}) — keeping the previous narration audio`,
            )
            return null
          }
        }

        // 1. Wording fix, only for an overshoot too large for speed alone.
        const decision =
          realDurationMs / scene.target_duration_ms > SPEED_ONLY_OVERSHOOT_MAX
            ? computeNarrationCorrection(realDurationMs, scene.target_duration_ms, audio.narration_text, tolerance)
            : null
        let fix: { shortenedText: string } | null = null
        if (decision?.kind === 'cut') {
          fix = { shortenedText: decision.shortenedText }
        } else if (decision?.kind === 'rewrite' && correction.scriptGenerator && audio.narration_text) {
          const rewritten = await rewriteNarrationToWordCount(correction.scriptGenerator, {
            language: track.language === 'FR' ? 'FR' : 'EN',
            sceneNumber: scene.scene_number,
            text: audio.narration_text,
            targetDurationMs: scene.target_duration_ms,
            maxWords: decision.maxWords,
            wordsPerSecond: decision.wordsPerSecond,
          })
          if (rewritten) fix = { shortenedText: rewritten }
        }
        if (fix) {
          const result = await resynthesize(fix.shortenedText, 'corrected')
          if (result === 'cancelled') {
            console.log(
              `[transcribe_captions] cancelled during narration-correction retry at scene ${scene.scene_number} — stopping, not recording a failure`,
            )
            return { ran: true }
          }
          if (result) {
            words = result.words
            realDurationMs = result.durationMs
            correctedNarrationText = fix.shortenedText
            correctedFileUrl = result.fileUrl
            console.log(
              `[transcribe_captions] scene ${scene.scene_number}: narration overshot its ` +
                `${scene.target_duration_ms}ms budget — resynthesized shorter, now ${realDurationMs}ms`,
            )
          }
        }

        // 2. Speed fit on whatever the scene measures now: slows a short scene,
        // speeds up a moderately long one. Kept only if it lands closer.
        const speed = computeSpeedFit(realDurationMs, scene.target_duration_ms, tolerance)
        const speedText = correctedNarrationText ?? audio.narration_text
        if (speed !== null && speedText) {
          const result = await resynthesize(speedText, `fit-${Math.round(speed * 100)}`, speed)
          if (result === 'cancelled') {
            console.log(
              `[transcribe_captions] cancelled during narration speed fit at scene ${scene.scene_number} — stopping, not recording a failure`,
            )
            return { ran: true }
          }
          if (
            result &&
            result.durationMs > 0 &&
            Math.abs(result.durationMs - scene.target_duration_ms) < Math.abs(realDurationMs - scene.target_duration_ms)
          ) {
            console.log(
              `[transcribe_captions] scene ${scene.scene_number}: speed ${speed} moved narration ${realDurationMs}ms -> ` +
                `${result.durationMs}ms (slot ${scene.target_duration_ms}ms)`,
            )
            words = result.words
            realDurationMs = result.durationMs
            correctedFileUrl = result.fileUrl
          }
        }
      }

      for (const w of words) {
        combinedWords.push({ text: w.text, start: w.start + cumulativeOffsetMs, end: w.end + cumulativeOffsetMs })
      }
      cumulativeOffsetMs += realDurationMs
      cumulativeTargetMs += scene.target_duration_ms

      // Persist the REAL measured duration back over synthesizeVoice.ts's
      // word-count ESTIMATE. renderLanguageTrack.ts's per-scene duration-
      // match pass (M4) reads this column to know how long THIS scene's
      // audio really is — without this, it would still see the estimate,
      // silently reintroducing the exact estimate-vs-reality drift this
      // whole fix exists to close, just one step later in the pipeline than
      // the caption-offset bug was.
      if (realDurationMs !== audio.duration_ms || correctedNarrationText || correctedFileUrl) {
        await upsertVideoSceneAudio(client, {
          contentLanguageTrackId: track.id,
          videoSceneId: scene.id,
          generation,
          status: audio.status as 'pending' | 'generating' | 'ready' | 'failed',
          durationMs: realDurationMs,
          attemptNumber: audio.attempt_number,
          ...(correctedNarrationText ? { narrationText: correctedNarrationText } : {}),
          ...(correctedFileUrl ? { fileUrl: correctedFileUrl } : {}),
        })
      }
    }

    if (cumulativeTargetMs > 0 && cumulativeOffsetMs > cumulativeTargetMs * OVERSHOOT_RUNNING_TOTAL_THRESHOLD) {
      console.log(
        `[transcribe_captions] track ${track.id}: total narration ${cumulativeOffsetMs}ms is ` +
          `${Math.round((cumulativeOffsetMs / cumulativeTargetMs - 1) * 100)}% over its ${cumulativeTargetMs}ms plan ` +
          `even after per-scene correction`,
      )
    }

    await upsertVideoCaptions(client, {
      contentLanguageTrackId: track.id,
      generation,
      timingData: combinedWords,
      status: 'ready',
    })

    await recordStepAttempt(client, {
      contentLanguageTrackId: track.id,
      stepName,
      generation,
      attemptNumber,
      status: 'succeeded',
      provider: 'assemblyai',
      outputSnapshot: { wordCount: combinedWords.length },
    })

    await claimTrack(client, track.id, 'generating', 'awaiting_shared', { current_step: 'awaiting_shared' })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await recordStepAttempt(client, {
      contentLanguageTrackId: track.id,
      stepName,
      generation,
      attemptNumber,
      status: 'failed_retryable',
      provider: 'assemblyai',
      errorMessage: message,
    })
    if (hasExceededMaxAttempts(attemptNumber, MAX_ATTEMPTS.assemblyai)) {
      await markTrackFailed(client, track.id, message)
    } else {
      await recordTrackRetryableFailure(client, track.id, attemptNumber, message)
    }
  }

  return { ran: true }
}
