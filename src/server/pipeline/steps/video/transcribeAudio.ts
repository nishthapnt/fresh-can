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
): Promise<{ words: WordTiming[] } | { failed: true; detail: string } | { timedOut: true }> {
  const deadline = Date.now() + POLL_TIMEOUT_MS
  while (Date.now() < deadline) {
    const result = await service.poll(jobRef)
    if (result.status === 'ready') {
      const words = Array.isArray(result.timingData) ? (result.timingData as WordTiming[]) : []
      return { words }
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
 * scene's own video_scene_audio.duration_ms (synthesizeVoice's word-count
 * estimate) as the additive offset for the next scene. Output shape is
 * exactly the {text,start,end}[] array worker/src/adapters/avMerger.ts's
 * buildFfmpegCommand already expects for caption burn-in — no further
 * transformation needed at render time.
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
  if (alreadySucceeded) return { ran: false }

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
      cumulativeOffsetMs += audio.duration_ms ?? 0
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
