import type { SupabaseClient } from '@supabase/supabase-js'
import type { AVMerger } from '../adapters/types.js'
import { ProviderCallError } from '../adapters/types.js'
import type { VideoStorageUploader } from '../adapters/storage.js'
import {
  claimTrack,
  hasSucceededStep,
  recordStepAttempt,
  recordTrackRetryableFailure,
  markTrackFailed,
  getVideoScenes,
  getVisualAssets,
  getVideoSceneAudioRows,
  upsertVideoGeneratedContent,
  type TrackRow,
  type PipelineRow,
} from '../db.js'
import { hasExceededMaxAttempts, isReadyToRetry, MAX_ATTEMPTS } from '../lib/backoff.js'

// FFmpeg render is the longest-running external call in the whole pipeline
// (ARCHITECTURE.MD §3.1) — generous poll timeout, unlike the ~1-3 min
// windows used for image/video-clip generation.
const POLL_INTERVAL_MS = 10_000
const POLL_TIMEOUT_MS = 20 * 60 * 1000

async function pollUntilDone(
  merger: AVMerger,
  jobRef: { providerRef: string },
): Promise<{ fileBuffer: Buffer } | { failed: true; detail: string } | { timedOut: true }> {
  const deadline = Date.now() + POLL_TIMEOUT_MS
  while (Date.now() < deadline) {
    const result = await merger.poll(jobRef)
    if (result.status === 'ready') return { fileBuffer: result.fileBuffer }
    if (result.status === 'failed') return { failed: true, detail: result.detail }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
  }
  return { timedOut: true }
}

/**
 * Per-language-track step — the only step allowed to read BOTH the shared
 * content_visual_assets AND a track's own audio/captions (no other step
 * file in this worker imports both getVisualAssets and the track-scoped
 * audio/caption helpers together — that asymmetry is what makes "a track
 * retry can't touch shared assets" a code-review-visible fact, per
 * generateSceneVisual.ts's header).
 *
 * Gated on three things, all required:
 * - this track has reached 'awaiting_shared' (M3 done)
 * - the PIPELINE has reached 'ready' ("visuals_ready" in prose)
 * - this track's master_generation_used matches the pipeline's
 *   current_generation (ARCHITECTURE.MD §10.1's generation fencing — a
 *   track from a superseded generation must never render against newer
 *   shared visuals it was never approved against; a script-level
 *   regeneration resets tracks back to waiting_on_shared, so in practice
 *   this guards a race, not a normal code path)
 */
export async function runRenderLanguageTrack(
  client: SupabaseClient,
  track: TrackRow,
  pipeline: PipelineRow,
  avMerger: AVMerger,
  uploader: VideoStorageUploader,
  backoffBaseDelayMs = 5000,
): Promise<{ ran: boolean }> {
  if (pipeline.status !== 'ready') return { ran: false } // shared visuals not ready yet
  if (track.master_generation_used !== pipeline.current_generation) return { ran: false } // stale generation

  let working: TrackRow
  if (track.status === 'awaiting_shared') {
    const claimed = await claimTrack(client, track.id, 'awaiting_shared', 'rendering', { current_step: 'rendering' })
    if (!claimed) return { ran: false } // lost the race to another worker
    working = claimed
  } else if (track.status === 'rendering') {
    if (!track.last_error) return { ran: false } // no error recorded — already in flight, not our turn
    if (
      !isReadyToRetry({
        lastError: track.last_error,
        retryCount: track.retry_count,
        updatedAt: new Date(track.updated_at),
        baseDelayMs: backoffBaseDelayMs,
      })
    ) {
      return { ran: false } // backoff window hasn't elapsed yet
    }
    working = track
  } else {
    return { ran: false } // wrong state entirely for this step
  }

  const generation = track.master_generation_used
  const stepName = 'render'
  const alreadySucceeded = await hasSucceededStep(client, { contentLanguageTrackId: track.id }, stepName, generation)
  if (alreadySucceeded) return { ran: true }

  const attemptNumber = working.retry_count + 1
  try {
    const scenes = await getVideoScenes(client, pipeline.id, generation)
    if (scenes.length === 0) throw new Error('render: no scenes found for this pipeline generation')

    const visualAssets = await getVisualAssets(client, pipeline.id, generation)
    const audioRows = await getVideoSceneAudioRows(client, track.id, generation)

    const scenePairs = scenes.map((scene) => {
      const clip = visualAssets.find((a) => a.video_scene_id === scene.id && a.asset_type === 'scene_video_clip')
      const audio = audioRows.find((a) => a.video_scene_id === scene.id)
      if (!clip?.file_url) {
        throw new Error(`render: scene ${scene.scene_number} has no ready scene_video_clip`)
      }
      if (!audio?.file_url) {
        throw new Error(`render: scene ${scene.scene_number} has no ready audio for track ${track.language}`)
      }
      return { clipUrl: clip.file_url, audioUrl: audio.file_url }
    })

    const { data: captionRow } = await client
      .from('video_captions')
      .select('timing_data')
      .eq('content_language_track_id', track.id)
      .eq('generation', generation)
      .maybeSingle()

    const jobRef = await avMerger.submit({
      scenes: scenePairs,
      captionTimingData: captionRow?.timing_data,
    })
    const outcome = await pollUntilDone(avMerger, jobRef)

    if (!('fileBuffer' in outcome)) {
      const detail = 'failed' in outcome ? outcome.detail : 'FFmpeg render poll timed out'
      throw new ProviderCallError('upload-post', null, detail)
    }

    // Storage path convention: freshcan-videos/{job_id}/{language}.mp4
    // (ARCHITECTURE.MD §17.2) — no per-generation segment, since a
    // superseded generation's track is reset to waiting_on_shared long
    // before it could ever reach this step again.
    const permanentUrl = await uploader.uploadBuffer(
      `${pipeline.job_id}/${track.language}.mp4`,
      outcome.fileBuffer,
      'video/mp4',
    )

    await upsertVideoGeneratedContent(client, {
      jobId: pipeline.job_id,
      language: track.language,
      contentPipelineId: pipeline.id,
      contentLanguageTrackId: track.id,
      fileUrl: permanentUrl,
      sceneCount: scenes.length,
    })

    await recordStepAttempt(client, {
      contentLanguageTrackId: track.id,
      stepName,
      generation,
      attemptNumber,
      status: 'succeeded',
      provider: 'upload-post',
      outputSnapshot: { fileUrl: permanentUrl },
    })

    await claimTrack(client, track.id, 'rendering', 'ready', { current_step: 'ready' })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await recordStepAttempt(client, {
      contentLanguageTrackId: track.id,
      stepName,
      generation,
      attemptNumber,
      status: 'failed_retryable',
      provider: 'upload-post',
      errorMessage: message,
    })
    if (hasExceededMaxAttempts(attemptNumber, MAX_ATTEMPTS.upload_post)) {
      await markTrackFailed(client, track.id, message)
    } else {
      await recordTrackRetryableFailure(client, track.id, attemptNumber, message)
    }
  }

  return { ran: true }
}
