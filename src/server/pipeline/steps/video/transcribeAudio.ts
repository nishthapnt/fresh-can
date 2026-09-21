import type { SupabaseClient } from '@supabase/supabase-js'
import type { TranscriptionService } from '../../adapters/types'
import { ProviderCallError } from '../../adapters/types'
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
      for (const w of outcome.words) {
        combinedWords.push({ text: w.text, start: w.start + cumulativeOffsetMs, end: w.end + cumulativeOffsetMs })
      }
      // Prefer the real per-word timing (millisecond-precise) over the
      // coarse whole-second audio_duration field — see TRAILING_SILENCE_
      // BUFFER_MS's header. Only falls back to audioDurationMs/duration_ms
      // when a scene somehow has zero transcribed words.
      const lastWord = outcome.words[outcome.words.length - 1]
      const realDurationMs =
        lastWord !== undefined
          ? lastWord.end + TRAILING_SILENCE_BUFFER_MS
          : (outcome.audioDurationMs ?? audio.duration_ms ?? 0)
      cumulativeOffsetMs += realDurationMs

      // Persist the REAL measured duration back over synthesizeVoice.ts's
      // word-count ESTIMATE. renderLanguageTrack.ts's per-scene duration-
      // match pass (M4) reads this column to know how long THIS scene's
      // audio really is — without this, it would still see the estimate,
      // silently reintroducing the exact estimate-vs-reality drift this
      // whole fix exists to close, just one step later in the pipeline than
      // the caption-offset bug was.
      if (realDurationMs !== audio.duration_ms) {
        await upsertVideoSceneAudio(client, {
          contentLanguageTrackId: track.id,
          videoSceneId: scene.id,
          generation,
          status: audio.status as 'pending' | 'generating' | 'ready' | 'failed',
          durationMs: realDurationMs,
          attemptNumber: audio.attempt_number,
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
