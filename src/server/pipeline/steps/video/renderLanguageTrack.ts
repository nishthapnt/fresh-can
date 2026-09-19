import type { SupabaseClient } from '@supabase/supabase-js'
import type { AVMerger } from '../../adapters/types'
import { ProviderCallError } from '../../adapters/types'
import { normalizeCaptionCues } from '../../adapters/avMerger'
import type { VideoStorageUploader } from '../../adapters/storage'
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
  markJobReadyIfAllContentComplete,
  type TrackRow,
  type PipelineRow,
} from '../../db'
import { hasExceededMaxAttempts, isReadyToRetry, MAX_ATTEMPTS } from '../../lib/backoff'
import { pickClipDurationSeconds } from '../../lib/sceneClipDuration'

// FFmpeg render is the longest-running external call in the whole pipeline
// (ARCHITECTURE.MD §3.1) — generous poll timeout, unlike the ~1-3 min
// windows used for image/video-clip generation.
const POLL_INTERVAL_MS = 10_000
const POLL_TIMEOUT_MS = 20 * 60 * 1000

// A track genuinely still in flight always ends up recording SOME outcome
// (success, provider failure, or pollUntilDone's own timeout) within at
// most two back-to-back POLL_TIMEOUT_MS windows — concat pass, then caption
// pass. If a track has been sitting at status='rendering' with last_error
// still null for meaningfully longer than that, the process that claimed
// it didn't just take a while — it died or restarted mid-call (confirmed
// live, 2026-09-11: tsx watch's hot-reload on a code change killed an
// in-flight render, orphaning the track at 'rendering'/null forever,
// since the retry gate below previously treated "no error" as "someone
// else already owns this" with no expiry). Generous margin on top of the
// 2x ceiling so a genuinely slow-but-alive render is never mistaken for
// abandoned.
const STALE_CLAIM_MS = 2 * POLL_TIMEOUT_MS + 5 * 60 * 1000

function isStaleClaim(updatedAt: string): boolean {
  return Date.now() - new Date(updatedAt).getTime() > STALE_CLAIM_MS
}

/**
 * Instrumentation for the upload-post.com processing-time ceiling
 * investigation (avMerger.ts's buildVideoConcatCommand header): a real
 * 7-scene render vanished — poll went straight to a 404, never
 * status=ERROR — at a consistent ~9min mark, on two separate attempts,
 * before `-preset ultrafast` was added. Logged (not just returned) so a
 * live worker run confirms, independent of whether the track ultimately
 * succeeds or fails, either: (a) every pass finishes comfortably under
 * 9min now, or (b) which pass still hits the wall and at what elapsed
 * time — data the mocked e2e test can't produce since it doesn't exercise
 * real provider timing. elapsedMs is also threaded into the persisted
 * pipeline_steps row (see call sites below) so this is queryable after the
 * fact, not just visible in whatever is tailing the worker's stdout at the
 * time.
 */
async function pollUntilDone(
  merger: AVMerger,
  jobRef: { providerRef: string },
  label: 'duration-match' | 'video-concat' | 'audio-concat' | 'mux' | 'caption',
): Promise<
  | { fileBuffer: Buffer; elapsedMs: number }
  | { failed: true; detail: string; elapsedMs: number }
  | { timedOut: true; elapsedMs: number }
> {
  const startedAt = Date.now()
  const elapsed = () => Date.now() - startedAt
  const elapsedSec = () => (elapsed() / 1000).toFixed(1)
  console.log(`[render:${label}] job ${jobRef.providerRef} submitted, polling every ${POLL_INTERVAL_MS / 1000}s`)

  const deadline = startedAt + POLL_TIMEOUT_MS
  let pollCount = 0
  while (Date.now() < deadline) {
    pollCount += 1
    let result: Awaited<ReturnType<AVMerger['poll']>>
    try {
      result = await merger.poll(jobRef)
    } catch (err) {
      // This IS the failure mode under investigation: the job vanishing
      // (provider returns a non-OK/404 rather than a polled status) throws
      // out of merger.poll() rather than resolving to status:'failed' — see
      // avMerger.ts's poll(). Logged with elapsed time before rethrowing so
      // the exact moment it happens is visible even though the caller ends
      // up recording this as a generic failed_retryable attempt.
      const message = err instanceof Error ? err.message : String(err)
      console.log(`[render:${label}] poll #${pollCount} THREW at ${elapsedSec()}s — ${message}`)
      throw err instanceof Error
        ? new Error(`${err.message} (${label} pass, ${elapsedSec()}s elapsed, poll #${pollCount})`)
        : err
    }
    console.log(`[render:${label}] poll #${pollCount} at ${elapsedSec()}s — status=${result.status}`)
    if (result.status === 'ready') {
      console.log(`[render:${label}] finished in ${elapsedSec()}s (${result.fileBuffer.length} bytes)`)
      return { fileBuffer: result.fileBuffer, elapsedMs: elapsed() }
    }
    if (result.status === 'failed') {
      console.log(`[render:${label}] provider reported failure after ${elapsedSec()}s — ${result.detail}`)
      return { failed: true, detail: result.detail, elapsedMs: elapsed() }
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
  }
  console.log(`[render:${label}] timed out waiting after ${elapsedSec()}s`)
  return { timedOut: true, elapsedMs: elapsed() }
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
  // content_jobs.aspect_ratio (video.ts already has this in scope from its
  // own fetchVideoJobFields call) — threaded through to the caption-burn
  // pass so its line-wrapping knows the real frame width instead of
  // guessing (see avMerger.ts's buildCaptionCommand).
  aspectRatio: '9:16' | '1:1' | '16:9' = '9:16',
): Promise<{ ran: boolean }> {
  if (pipeline.status !== 'ready') return { ran: false } // shared visuals not ready yet
  if (track.master_generation_used !== pipeline.current_generation) return { ran: false } // stale generation

  let working: TrackRow
  if (track.status === 'awaiting_shared') {
    const claimed = await claimTrack(client, track.id, 'awaiting_shared', 'rendering', { current_step: 'rendering' })
    if (!claimed) return { ran: false } // lost the race to another worker
    working = claimed
  } else if (track.status === 'rendering') {
    if (!track.last_error) {
      if (!isStaleClaim(track.updated_at)) return { ran: false } // no error recorded — still genuinely in flight, not our turn
      // Abandoned claim — see STALE_CLAIM_MS's header. Reclaim it with a
      // real CAS write (bumping updated_at) rather than just proceeding in
      // place: otherwise, if THIS attempt also dies before ever recording an
      // outcome, updated_at is still the ORIGINAL claim's timestamp, so
      // every tick past the staleness window re-enters here with no claim
      // ever actually registered — a second worker process (or a fast
      // crash-loop) could then pick up and resubmit the same render
      // concurrently.
      const reclaimed = await claimTrack(client, track.id, 'rendering', 'rendering', { current_step: 'rendering' })
      if (!reclaimed) return { ran: false } // someone else reclaimed it first
      console.error(
        `[render] track ${track.id} (${track.language}) claim abandoned since ${track.updated_at} with no ` +
          `recorded outcome — reclaiming as stale (likely a worker crash/restart mid-render)`,
      )
      working = reclaimed
    } else {
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
    }
  } else {
    return { ran: false } // wrong state entirely for this step
  }

  const generation = track.master_generation_used
  const stepName = 'render'
  const alreadySucceeded = await hasSucceededStep(client, { contentLanguageTrackId: track.id }, stepName, generation)
  if (alreadySucceeded) {
    // recordStepAttempt (success, below) and claimTrack('rendering' ->
    // 'ready', also below) are two separate writes — if the worker died, or
    // claimTrack itself failed, in the gap between them, the render step is
    // marked succeeded (the video is already in generated_content) but the
    // track never reached 'ready'. Without this, every future tick would
    // hit this exact early return and never retry that transition,
    // stranding the track at 'rendering' forever even though the video
    // exists. CAS-guarded, so it's a no-op if the track already reached
    // 'ready' some other way.
    await claimTrack(client, track.id, 'rendering', 'ready', { current_step: 'ready' })
    return { ran: true }
  }

  const attemptNumber = working.retry_count + 1
  try {
    const scenes = await getVideoScenes(client, pipeline.id)
    if (scenes.length === 0) throw new Error('render: no scenes found for this pipeline generation')

    const visualAssets = await getVisualAssets(client, pipeline.id, generation)
    const audioRows = await getVideoSceneAudioRows(client, track.id, generation)

    const sceneRenderInputs = scenes.map((scene) => {
      const clip = visualAssets.find((a) => a.video_scene_id === scene.id && a.asset_type === 'scene_video_clip')
      const audio = audioRows.find((a) => a.video_scene_id === scene.id)
      if (!clip?.file_url) {
        throw new Error(`render: scene ${scene.scene_number} has no ready scene_video_clip`)
      }
      if (!audio?.file_url) {
        throw new Error(`render: scene ${scene.scene_number} has no ready audio for track ${track.language}`)
      }
      return {
        sceneNumber: scene.scene_number,
        clipUrl: clip.file_url,
        audioUrl: audio.file_url,
        // Never probed — Kling/Hailuo reliably render at exactly the
        // duration requested, so this is recomputed deterministically from
        // the same input generateSceneVisual.ts used to request the clip
        // (see pickClipDurationSeconds's own header for why that's safe).
        clipDurationSeconds: Number(pickClipDurationSeconds(scene.target_duration_ms)),
        // The REAL AssemblyAI-measured duration, once transcribeAudio.ts
        // has run (it overwrites synthesizeVoice.ts's word-count estimate
        // in this same column) — falls back to whatever's stored if a
        // track somehow reached here without that write, which shouldn't
        // happen (transcribe_captions is a hard gate before awaiting_shared).
        audioDurationSeconds: (audio.duration_ms ?? 0) / 1000,
      }
    })

    // Pass 0: reconcile each scene's SHARED video clip to THIS track's
    // real narration length — hold the last frame if the clip is shorter
    // than the audio, trim if it's longer (avMerger.ts's
    // buildSceneDurationMatchCommand). This is the render-time
    // reconciliation ARCHITECTURE.MD §4.2 always called for but that was
    // never actually implemented — confirmed live (2026-09-19): a real
    // 7-scene render's total video length (35s, all fixed 5s clips) ran
    // 7.4s short of its real total audio length (42.4s), and the mux
    // pass's `-shortest` below was silently truncating the last ~7.4s of
    // narration and captions instead of anything ever reconciling per
    // scene. Writes to PER-TRACK temp clip URLs, never back onto the
    // shared content_visual_assets row — the match amount is language-
    // specific (EN/FR narration lengths differ for the same scene), and
    // that row must stay untouched so every language keeps editing from
    // the same real, unmodified shared clip. Run in parallel across
    // scenes — independent single-file operations, same reasoning the
    // video/audio concat passes below use for their own two halves.
    const matchedScenes = await Promise.all(
      sceneRenderInputs.map(async (input) => {
        const jobRef = await avMerger.submitSceneDurationMatch(
          input.clipUrl,
          input.clipDurationSeconds,
          input.audioDurationSeconds,
        )
        const outcome = await pollUntilDone(avMerger, jobRef, 'duration-match')
        if (!('fileBuffer' in outcome)) {
          const detail = 'failed' in outcome ? outcome.detail : 'FFmpeg duration-match pass poll timed out'
          throw new ProviderCallError(
            'upload-post',
            null,
            `scene ${input.sceneNumber}: ${detail} (after ${(outcome.elapsedMs / 1000).toFixed(1)}s)`,
          )
        }
        const matchedClipUrl = await uploader.uploadBuffer(
          `${pipeline.job_id}/${track.language}-scene${input.sceneNumber}-matched-tmp.mp4`,
          outcome.fileBuffer,
          'video/mp4',
        )
        return { clipUrl: matchedClipUrl, audioUrl: input.audioUrl }
      }),
    )
    const scenePairs = matchedScenes

    const { data: captionRow } = await client
      .from('video_captions')
      .select('timing_data')
      .eq('content_language_track_id', track.id)
      .eq('generation', generation)
      .maybeSingle()

    // Pass 1a/1b: concatenate video and audio INDEPENDENTLY, then mux them
    // together in pass 2 — concatenating them TOGETHER in one mixed
    // v=1:a=1 filter (the original approach) silently truncates the
    // resulting audio to ~2 seconds regardless of scene count or real
    // audio length, confirmed live against a real render (see
    // avMerger.ts's buildVideoConcatCommand header for the full writeup).
    // Run in parallel — genuinely independent inputs, no reason to
    // serialize them.
    const [videoJobRef, audioJobRef] = await Promise.all([
      avMerger.submitVideoConcat({ scenes: scenePairs }),
      avMerger.submitAudioConcat({ scenes: scenePairs }),
    ])
    const [videoOutcome, audioOutcome] = await Promise.all([
      pollUntilDone(avMerger, videoJobRef, 'video-concat'),
      pollUntilDone(avMerger, audioJobRef, 'audio-concat'),
    ])
    if (!('fileBuffer' in videoOutcome)) {
      const detail = 'failed' in videoOutcome ? videoOutcome.detail : 'FFmpeg video-concat pass poll timed out'
      // elapsedMs is included so a failure at/near the ~9min ceiling is
      // identifiable straight from last_error/pipeline_steps without cross-
      // referencing worker stdout — see pollUntilDone's header.
      throw new ProviderCallError('upload-post', null, `${detail} (after ${(videoOutcome.elapsedMs / 1000).toFixed(1)}s)`)
    }
    if (!('fileBuffer' in audioOutcome)) {
      const detail = 'failed' in audioOutcome ? audioOutcome.detail : 'FFmpeg audio-concat pass poll timed out'
      throw new ProviderCallError('upload-post', null, `${detail} (after ${(audioOutcome.elapsedMs / 1000).toFixed(1)}s)`)
    }

    // Pass 2: mux the two independently-concatenated streams back into one
    // file. upload-post.com's `files` field takes fetchable URLs, not raw
    // bytes, so both pass-1 outputs are re-hosted at temp paths first
    // purely to hand this provider URLs for them.
    const [videoTempUrl, audioTempUrl] = await Promise.all([
      uploader.uploadBuffer(`${pipeline.job_id}/${track.language}-video-tmp.mp4`, videoOutcome.fileBuffer, 'video/mp4'),
      uploader.uploadBuffer(`${pipeline.job_id}/${track.language}-audio-tmp.mp4`, audioOutcome.fileBuffer, 'video/mp4'),
    ])
    const muxJobRef = await avMerger.submitMux(videoTempUrl, audioTempUrl)
    const muxOutcome = await pollUntilDone(avMerger, muxJobRef, 'mux')
    if (!('fileBuffer' in muxOutcome)) {
      const detail = 'failed' in muxOutcome ? muxOutcome.detail : 'FFmpeg mux pass poll timed out'
      throw new ProviderCallError('upload-post', null, `${detail} (after ${(muxOutcome.elapsedMs / 1000).toFixed(1)}s)`)
    }

    // Pass 3: only when there are caption cues to burn in — a render with
    // no captions is already done after the mux pass. Burning captions in
    // as a *further* pass (via -vf, a linear filter chain with no named
    // pads) is what avoids ever needing a ';' even with many cues (see
    // buildCaptionCommand's header). The mux pass's output is re-hosted at
    // a temp path first, same reason as above.
    const cues = normalizeCaptionCues(captionRow?.timing_data)
    let finalBuffer = muxOutcome.fileBuffer
    // captionElapsedMs stays null (not 0) when there were no cues, so the
    // success snapshot below can tell "no caption pass ran" apart from "the
    // caption pass ran and finished instantly" — relevant for confirming
    // whether it's specifically the caption pass (re-encoding the WHOLE
    // merged video, not just per-scene clips) that risks the ceiling.
    let captionElapsedMs: number | null = null
    if (cues.length > 0) {
      const muxTempUrl = await uploader.uploadBuffer(
        `${pipeline.job_id}/${track.language}-mux-tmp.mp4`,
        muxOutcome.fileBuffer,
        'video/mp4',
      )
      const captionJobRef = await avMerger.submitCaptionBurn(muxTempUrl, captionRow?.timing_data, aspectRatio)
      const captionOutcome = await pollUntilDone(avMerger, captionJobRef, 'caption')
      if (!('fileBuffer' in captionOutcome)) {
        const detail = 'failed' in captionOutcome ? captionOutcome.detail : 'FFmpeg caption pass poll timed out'
        throw new ProviderCallError('upload-post', null, `${detail} (after ${(captionOutcome.elapsedMs / 1000).toFixed(1)}s)`)
      }
      finalBuffer = captionOutcome.fileBuffer
      captionElapsedMs = captionOutcome.elapsedMs
    }

    // Storage path convention: freshcan-videos/{job_id}/{language}.mp4
    // (ARCHITECTURE.MD §17.2) — no per-generation segment, since a
    // superseded generation's track is reset to waiting_on_shared long
    // before it could ever reach this step again.
    const permanentUrl = await uploader.uploadBuffer(
      `${pipeline.job_id}/${track.language}.mp4`,
      finalBuffer,
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

    console.log(
      `[render] track ${track.id} (${track.language}) succeeded — ` +
        `video-concat ${(videoOutcome.elapsedMs / 1000).toFixed(1)}s, ` +
        `audio-concat ${(audioOutcome.elapsedMs / 1000).toFixed(1)}s, ` +
        `mux ${(muxOutcome.elapsedMs / 1000).toFixed(1)}s` +
        (captionElapsedMs !== null ? `, caption ${(captionElapsedMs / 1000).toFixed(1)}s` : ', no captions') +
        `, ${scenes.length} scenes, ${finalBuffer.length} bytes`,
    )

    await recordStepAttempt(client, {
      contentLanguageTrackId: track.id,
      stepName,
      generation,
      attemptNumber,
      status: 'succeeded',
      provider: 'upload-post',
      // Timing/size instrumentation for the upload-post.com ~9min
      // processing-ceiling investigation (see pollUntilDone's header) —
      // queryable per-attempt in pipeline_steps.output_snapshot, so a
      // pattern (e.g. concat consistently taking 7-8min against the ~9min
      // wall) is visible across many real renders without needing to
      // capture worker stdout at the time.
      outputSnapshot: {
        fileUrl: permanentUrl,
        sceneCount: scenes.length,
        outputBytes: finalBuffer.length,
        videoConcatElapsedMs: videoOutcome.elapsedMs,
        audioConcatElapsedMs: audioOutcome.elapsedMs,
        muxElapsedMs: muxOutcome.elapsedMs,
        captionElapsedMs,
      },
    })

    await claimTrack(client, track.id, 'rendering', 'ready', { current_step: 'ready' })
    // upsertVideoGeneratedContent above just wrote this track's row — the
    // job-level aggregate completeness check must run here, same as
    // image_post's finalizeImageContent.ts (video has no separate
    // approve-gated generated_content write to hook instead).
    await markJobReadyIfAllContentComplete(client, pipeline.job_id)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[render] track ${track.id} (${track.language}) attempt ${attemptNumber} failed — ${message}`)
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
