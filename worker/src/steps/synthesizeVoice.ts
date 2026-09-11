import type { SupabaseClient } from '@supabase/supabase-js'
import type { VoiceSynthesizer } from '../adapters/types.js'
import type { VideoStorageUploader } from '../adapters/storage.js'
import {
  hasSucceededStep,
  recordStepAttempt,
  recordTrackRetryableFailure,
  markTrackFailed,
  getVideoScenes,
  getVideoSceneAudioRows,
  upsertVideoSceneAudio,
  type TrackRow,
} from '../db.js'
import { hasExceededMaxAttempts, isReadyToRetry, MAX_ATTEMPTS } from '../lib/backoff.js'
import { BRAND_PROFILE } from '../prompts/index.js'

// ~150 words per minute — a reasonable average speaking pace. Used only to
// ESTIMATE duration_ms; ElevenLabs' plain text-to-speech response doesn't
// reliably expose real measured audio duration. This is an acceptable
// approximation per ARCHITECTURE.MD §4.2's own design: the render step (M4)
// holds/trims frames to absorb residual drift rather than depending on
// frame-perfect duration figures at this stage.
const WORDS_PER_SECOND = 2.5

function estimateDurationMs(text: string): number {
  const wordCount = text.trim().split(/\s+/).filter(Boolean).length
  return Math.round((wordCount / WORDS_PER_SECOND) * 1000)
}

/**
 * Per-language-track step, fanned per scene — mirrors generateSceneVisual.ts's
 * per-scene fan-out shape, but for audio (and track-scoped, not
 * pipeline-scoped: each language's audio is independent, unlike the shared
 * visuals). Gated on localize_script having written this scene's
 * narration_text. One scene's transient ElevenLabs failure never blocks the
 * others, and never touches the shared visual assets or the other language.
 */
export async function runSynthesizeVoice(
  client: SupabaseClient,
  track: TrackRow,
  contentPipelineId: string,
  jobId: string,
  voiceSynthesizer: VoiceSynthesizer,
  uploader: VideoStorageUploader,
  backoffBaseDelayMs = 5000,
): Promise<{ ran: boolean }> {
  if (track.status !== 'generating') return { ran: false }

  const generation = track.master_generation_used
  const localizeReady = await hasSucceededStep(client, { contentLanguageTrackId: track.id }, 'localize_script', generation)
  if (!localizeReady) return { ran: false }

  const voiceId = BRAND_PROFILE.videoVoiceIds?.[track.language]

  const scenes = await getVideoScenes(client, contentPipelineId, generation)
  const audioRows = await getVideoSceneAudioRows(client, track.id, generation)

  let anyRan = false
  for (const scene of scenes) {
    const existing = audioRows.find((a) => a.video_scene_id === scene.id)
    if (!existing || !existing.narration_text) continue // localize_script hasn't written this scene yet
    if (existing.status === 'ready') continue

    const stepName = `synthesize_voice:scene:${scene.scene_number}`
    const alreadySucceeded = await hasSucceededStep(client, { contentLanguageTrackId: track.id }, stepName, generation)
    if (alreadySucceeded) continue

    let attemptNumber = 1
    if (existing.status === 'failed' || existing.status === 'generating') {
      const ready = isReadyToRetry({
        lastError: 'previous attempt did not succeed',
        retryCount: existing.attempt_number,
        updatedAt: new Date(existing.updated_at),
        baseDelayMs: backoffBaseDelayMs,
      })
      if (!ready) continue
      attemptNumber = existing.attempt_number + 1
    }
    anyRan = true

    if (!voiceId) {
      const message = `No ElevenLabs voice id configured for language "${track.language}" — see BRAND_PROFILE.videoVoiceIds`
      await recordStepAttempt(client, {
        contentLanguageTrackId: track.id,
        stepName,
        generation,
        attemptNumber,
        status: 'failed_terminal',
        provider: 'elevenlabs',
        errorMessage: message,
      })
      await markTrackFailed(client, track.id, message)
      continue
    }

    try {
      await upsertVideoSceneAudio(client, {
        contentLanguageTrackId: track.id,
        videoSceneId: scene.id,
        generation,
        status: 'generating',
        attemptNumber,
      })

      const result = await voiceSynthesizer.synthesize({ text: existing.narration_text, voiceId })
      const path = `${jobId}/${track.language}/scene-${scene.scene_number}-audio.mp3`
      const fileUrl = await uploader.uploadBuffer(path, result.audioBuffer, 'audio/mpeg')
      const durationMs = estimateDurationMs(existing.narration_text)

      await upsertVideoSceneAudio(client, {
        contentLanguageTrackId: track.id,
        videoSceneId: scene.id,
        generation,
        status: 'ready',
        fileUrl,
        durationMs,
        providerRef: result.providerRef,
        attemptNumber,
      })
      await recordStepAttempt(client, {
        contentLanguageTrackId: track.id,
        stepName,
        generation,
        attemptNumber,
        status: 'succeeded',
        provider: 'elevenlabs',
        outputSnapshot: { fileUrl, durationMs },
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      await upsertVideoSceneAudio(client, {
        contentLanguageTrackId: track.id,
        videoSceneId: scene.id,
        generation,
        status: 'failed',
        attemptNumber,
      })
      await recordStepAttempt(client, {
        contentLanguageTrackId: track.id,
        stepName,
        generation,
        attemptNumber,
        status: 'failed_retryable',
        provider: 'elevenlabs',
        errorMessage: message,
      })
      if (hasExceededMaxAttempts(attemptNumber, MAX_ATTEMPTS.elevenlabs)) {
        await markTrackFailed(client, track.id, message)
      } else {
        await recordTrackRetryableFailure(client, track.id, attemptNumber, message)
      }
    }
  }

  return { ran: anyRan }
}
