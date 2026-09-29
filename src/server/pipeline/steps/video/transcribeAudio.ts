import type { SupabaseClient } from '@supabase/supabase-js'
import type { TranscriptionService, VoiceSynthesizer } from '../../adapters/types'
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
import { BRAND_PROFILE } from '../../prompts/index'
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
const OVERSHOOT_HARD_TOLERANCE = 1.15
const OVERSHOOT_SOFT_TOLERANCE = 1.05
// A cut must leave at least this much of the slot filled, unless the original
// overshoots by EXTREME_OVERSHOOT x or more (then shortening still wins).
const MIN_FILL_AFTER_CUT = 0.7
const EXTREME_OVERSHOOT = 1.8

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
 *      ANYWHERE (no safe cut point exists at all): the raw word-count
 *      chop, same as before. */
function truncateNarrationToWordCount(text: string, maxWords: number): string {
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

  return truncated
}

/** Pure decision logic, unit-tested on its own (transcribeAudio.test.ts):
 *  does this scene's REAL measured duration overshoot its own budget badly
 *  enough to need shortening, and if so, to what text? Self-calibrated from
 *  THIS scene's own just-measured words/sec — never a fleet-wide or
 *  per-voice guess — so it behaves correctly for any ElevenLabs voice,
 *  including one never seen before. Returns null for a small mismatch
 *  (left to the existing render-time handling) or when there's no
 *  narration text to shorten. */
export function computeNarrationCorrection(
  realDurationMs: number,
  targetDurationMs: number,
  narrationText: string | null | undefined,
): { shortenedText: string } | null {
  if (!narrationText || targetDurationMs <= 0) return null
  if (realDurationMs <= targetDurationMs * OVERSHOOT_HARD_TOLERANCE) return null

  const words = narrationWordCount(narrationText)
  if (words === 0) return null
  const selfWordsPerSecond = words / (realDurationMs / 1000)
  const maxWords = Math.max(1, Math.floor((targetDurationMs / 1000) * OVERSHOOT_SOFT_TOLERANCE * selfWordsPerSecond))
  if (maxWords >= words) return null

  const shortenedText = truncateNarrationToWordCount(narrationText, maxWords)
  if (shortenedText === narrationText) return null
  // Sentence-level chopping can overshoot DOWNWARD: real job 8e92b381 cut a
  // two-sentence narration to its first sentence, landing at ~58% of the
  // slot — and since a scene's rendered length IS its narration length, that
  // shrinks the whole video (18s delivered vs 32s requested). A moderately
  // long scene is harmless (its clip is held/trimmed by the render step),
  // so unless it overshoots badly, keep the original rather than accept a
  // cut that would leave the slot mostly empty.
  const predictedShortenedMs = (narrationWordCount(shortenedText) / selfWordsPerSecond) * 1000
  const overshootRatio = realDurationMs / targetDurationMs
  if (predictedShortenedMs < targetDurationMs * MIN_FILL_AFTER_CUT && overshootRatio < EXTREME_OVERSHOOT) return null
  return { shortenedText }
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
        const fix = computeNarrationCorrection(realDurationMs, scene.target_duration_ms, audio.narration_text)
        if (fix) {
          try {
            const voiceId = correction.voiceId ?? BRAND_PROFILE.videoVoiceIds?.[track.language]
            if (!voiceId) throw new Error('no voice id available for narration-correction retry')
            const synthResult = await correction.voiceSynthesizer.synthesize({ text: fix.shortenedText, voiceId })
            // A DISTINCT path from synthesizeVoice.ts's own upload (not the
            // same `scene-N-audio.mp3` re-uploaded with upsert) — confirmed
            // live (2026-09-26) that reusing the same path made AssemblyAI's
            // fetch of this "corrected" audio come back at nearly the same
            // duration as the ORIGINAL over-budget narration, not the real
            // (much shorter) corrected one: same class of stale-cached-URL
            // issue this repo already hit once for the final rendered video
            // (see mediaUrl.ts's cache-busting commit) — a same-path
            // overwrite can serve a cached copy of the old bytes to an
            // external fetcher even though Storage itself has the new ones.
            // A new path is a guaranteed cache miss, not a heuristic fix.
            const path = `${correction.jobId}/${track.language}/scene-${scene.scene_number}-audio-corrected.mp3`
            const newFileUrl = await correction.uploader.uploadBuffer(path, synthResult.audioBuffer, 'audio/mpeg')
            const retryJobRef = await transcriptionService.submit({ audioUrl: newFileUrl })
            const retryOutcome = await pollUntilDone(client, track.id, transcriptionService, retryJobRef)

            if ('cancelled' in retryOutcome) {
              console.log(
                `[transcribe_captions] cancelled during narration-correction retry at scene ${scene.scene_number} — stopping, not recording a failure`,
              )
              return { ran: true }
            }
            if ('words' in retryOutcome) {
              words = retryOutcome.words
              lastWord = words[words.length - 1]
              realDurationMs =
                lastWord !== undefined
                  ? lastWord.end + TRAILING_SILENCE_BUFFER_MS
                  : (retryOutcome.audioDurationMs ?? realDurationMs)
              correctedNarrationText = fix.shortenedText
              correctedFileUrl = newFileUrl
              console.log(
                `[transcribe_captions] scene ${scene.scene_number}: narration overshot its ` +
                  `${scene.target_duration_ms}ms budget — resynthesized shorter, now ${realDurationMs}ms`,
              )
            } else {
              const detail = 'failed' in retryOutcome ? retryOutcome.detail : 'AssemblyAI poll timed out'
              console.log(
                `[transcribe_captions] scene ${scene.scene_number}: narration-correction retry did not complete ` +
                  `(${detail}) — keeping the original over-budget narration`,
              )
            }
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            console.log(
              `[transcribe_captions] scene ${scene.scene_number}: narration-correction attempt failed (${message}) ` +
                `— keeping the original over-budget narration`,
            )
          }
        }
      }

      for (const w of words) {
        combinedWords.push({ text: w.text, start: w.start + cumulativeOffsetMs, end: w.end + cumulativeOffsetMs })
      }
      cumulativeOffsetMs += realDurationMs

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
