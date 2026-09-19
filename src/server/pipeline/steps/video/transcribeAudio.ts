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
  type TrackRow,
} from '../../db'
import { hasExceededMaxAttempts, isReadyToRetry, MAX_ATTEMPTS } from '../../lib/backoff'

const POLL_INTERVAL_MS = 3000
const POLL_TIMEOUT_MS = 120_000

interface WordTiming {
  text: string
  start: number
  end: number
}

async function pollUntilDone(
  service: TranscriptionService,
  jobRef: { providerRef: string },
): Promise<
  | { words: WordTiming[]; audioDurationMs?: number }
  | { failed: true; detail: string }
  | { timedOut: true }
> {
  const deadline = Date.now() + POLL_TIMEOUT_MS
  while (Date.now() < deadline) {
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
 * word timings into one flat, cumulative-offset timeline — using
 * AssemblyAI's own REAL measured duration of each scene's audio file
 * (TranscriptionPollResult.audioDurationMs) as the additive offset for the
 * next scene, falling back to video_scene_audio.duration_ms (synthesizeVoice's
 * word-count ESTIMATE) only if a provider/mock doesn't report one. Using the
 * estimate here unconditionally used to be the only option — that drifted
 * captions out of sync with the real render's audio track (concatenated
 * from these same real audio files in renderLanguageTrack.ts) whenever
 * ElevenLabs' actual speaking pace differed from the flat words-per-second
 * assumption behind the estimate, and the error compounded scene over
 * scene. The real duration is already sitting in every poll() response
 * this step already makes — no extra API call needed to use it. Output
 * shape is exactly the {text,start,end}[] array worker/src/adapters/
 * avMerger.ts's buildFfmpegCommand already expects for caption burn-in —
 * no further transformation needed at render time.
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
      const outcome = await pollUntilDone(transcriptionService, jobRef)

      if (!('words' in outcome)) {
        const detail = 'failed' in outcome ? outcome.detail : 'AssemblyAI poll timed out'
        throw new ProviderCallError('assemblyai', null, `scene ${scene.scene_number}: ${detail}`)
      }
      for (const w of outcome.words) {
        combinedWords.push({ text: w.text, start: w.start + cumulativeOffsetMs, end: w.end + cumulativeOffsetMs })
      }
      const realDurationMs = outcome.audioDurationMs ?? audio.duration_ms ?? 0
      cumulativeOffsetMs += realDurationMs

      // Persist the REAL measured duration back over synthesizeVoice.ts's
      // word-count ESTIMATE (only when AssemblyAI actually reported one —
      // never overwrite a real value with 0 if a provider/mock omits it).
      // renderLanguageTrack.ts's per-scene duration-match pass (M4) reads
      // this column to know how long THIS scene's audio really is — without
      // this, it would still see the estimate, silently reintroducing the
      // exact estimate-vs-reality drift this whole fix exists to close, just
      // one step later in the pipeline than the caption-offset bug was.
      if (outcome.audioDurationMs !== undefined && outcome.audioDurationMs !== audio.duration_ms) {
        await upsertVideoSceneAudio(client, {
          contentLanguageTrackId: track.id,
          videoSceneId: scene.id,
          generation,
          status: audio.status as 'pending' | 'generating' | 'ready' | 'failed',
          durationMs: outcome.audioDurationMs,
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
