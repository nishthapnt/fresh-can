import type { SupabaseClient } from '@supabase/supabase-js'
import type { AVMerger } from '../../adapters/types'
import { ProviderCallError } from '../../adapters/types'
import { buildCaptionAssFile } from '../../adapters/avMerger'
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
  isTrackFailed,
  type TrackRow,
  type PipelineRow,
} from '../../db'
import { hasExceededMaxAttempts, isReadyToRetry, MAX_ATTEMPTS } from '../../lib/backoff'

// FFmpeg render is the longest-running external call in the whole pipeline
// (ARCHITECTURE.MD §3.1) — generous poll timeout, unlike the ~1-3 min
// windows used for image/video-clip generation.
const POLL_INTERVAL_MS = 10_000
const POLL_TIMEOUT_MS = 20 * 60 * 1000

// Supabase Storage's real upload ceiling — empirically confirmed 50MB
// succeeds, 52MB fails ("object exceeded the maximum allowed size"), see
// avMerger.ts's CAPPED_VIDEO_ENCODE_ARGS for the bitrate math this bounds.
// Targeting 50MB, not 52MB, since the gap between the two was never itself
// tested. Whichever pass is the true FINAL render for a track (mux when
// there are no captions, caption-burn when there are) gets checked against
// this after its quality-tier (CRF) attempt — CRF has no size ceiling of
// its own, so this is the only place that actually verifies the real
// output fits before it's escalated to the deterministic capped fallback
// or uploaded.
const SAFE_UPLOAD_BYTES = 50_000_000

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
 *
 * `trackId` cancellation check (2026-09-22, P0 fix) — this file's own
 * header already flagged that a render "never persists a resumable
 * provider_ref before polling... no interruption point in between" across
 * its several passes; this closes that specific gap for cancellation
 * (still not a real checkpoint/resume mechanism for a crash mid-pass, which
 * remains the documented limitation). See isTrackFailed's header (db.ts)
 * and generateSceneVisual.ts's own pollUntilDone for the full reasoning.
 */
async function pollUntilDone(
  merger: AVMerger,
  jobRef: { providerRef: string },
  label: 'duration-match' | 'video-concat' | 'audio-concat' | 'mux' | 'caption',
  client: SupabaseClient,
  trackId: string,
): Promise<
  | { fileBuffer: Buffer; elapsedMs: number }
  | { failed: true; detail: string; elapsedMs: number }
  | { timedOut: true; elapsedMs: number }
  | { cancelled: true; elapsedMs: number }
> {
  const startedAt = Date.now()
  const elapsed = () => Date.now() - startedAt
  const elapsedSec = () => (elapsed() / 1000).toFixed(1)
  console.log(`[render:${label}] job ${jobRef.providerRef} submitted, polling every ${POLL_INTERVAL_MS / 1000}s`)

  const deadline = startedAt + POLL_TIMEOUT_MS
  let pollCount = 0
  while (Date.now() < deadline) {
    if (await isTrackFailed(client, trackId)) {
      console.log(`[render:${label}] cancelled at ${elapsedSec()}s — stopping poll early`)
      return { cancelled: true, elapsedMs: elapsed() }
    }
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
        // The REAL AssemblyAI-measured duration, once transcribeAudio.ts
        // has run (it overwrites synthesizeVoice.ts's word-count estimate
        // in this same column) — falls back to whatever's stored if a
        // track somehow reached here without that write, which shouldn't
        // happen (transcribe_captions is a hard gate before awaiting_shared).
        // This is the ONLY duration submitSceneDurationMatch needs now —
        // see buildSceneDurationMatchCommand's header (avMerger.ts) for why
        // the clip's own assumed generated length was dropped 2026-09-21
        // (it was the root cause of a real caption/audio desync).
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
        const jobRef = await avMerger.submitSceneDurationMatch(input.clipUrl, input.audioDurationSeconds)
        const outcome = await pollUntilDone(avMerger, jobRef, 'duration-match', client, track.id)
        if ('cancelled' in outcome) return { cancelled: true as const }
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
    // Any scene cancelling mid-poll means the whole render stops here — a
    // plain `return` inside this function's own try block skips the catch
    // below, so no failure is recorded on top of whatever already marked
    // the track 'failed' (a real provider failure or /video/cancel), and
    // Pass 1a/1b/2/3 (the rest of the render, all still ahead) never start.
    if (matchedScenes.some((m) => 'cancelled' in m)) {
      console.log(`[render:duration-match] cancelled — stopping render, not recording a failure`)
      return { ran: true }
    }
    const scenePairs = matchedScenes as { clipUrl: string; audioUrl: string }[]

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
      pollUntilDone(avMerger, videoJobRef, 'video-concat', client, track.id),
      pollUntilDone(avMerger, audioJobRef, 'audio-concat', client, track.id),
    ])
    if ('cancelled' in videoOutcome || 'cancelled' in audioOutcome) {
      console.log(`[render:video/audio-concat] cancelled — stopping render, not recording a failure`)
      return { ran: true }
    }
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
    // purely to hand this provider URLs for them. totalDurationSeconds
    // (sum of every scene's real audio length — the same value each
    // scene's own duration-match pass targeted above) is what
    // submitMux's fade-to-black/silence needs to know where "the end" is
    // — see avMerger.ts's buildMuxCommand.
    const totalDurationSeconds = sceneRenderInputs.reduce((sum, s) => sum + s.audioDurationSeconds, 0)
    const [videoTempUrl, audioTempUrl] = await Promise.all([
      uploader.uploadBuffer(`${pipeline.job_id}/${track.language}-video-tmp.mp4`, videoOutcome.fileBuffer, 'video/mp4'),
      uploader.uploadBuffer(`${pipeline.job_id}/${track.language}-audio-tmp.mp4`, audioOutcome.fileBuffer, 'video/mp4'),
    ])
    const muxJobRef = await avMerger.submitMux(videoTempUrl, audioTempUrl, totalDurationSeconds)
    const muxOutcome = await pollUntilDone(avMerger, muxJobRef, 'mux', client, track.id)
    if ('cancelled' in muxOutcome) {
      console.log(`[render:mux] cancelled — stopping render, not recording a failure`)
      return { ran: true }
    }
    if (!('fileBuffer' in muxOutcome)) {
      const detail = 'failed' in muxOutcome ? muxOutcome.detail : 'FFmpeg mux pass poll timed out'
      throw new ProviderCallError('upload-post', null, `${detail} (after ${(muxOutcome.elapsedMs / 1000).toFixed(1)}s)`)
    }

    // Pass 3: only when there are caption cues to burn in — a render with
    // no captions is already done after the mux pass. Burning captions via
    // ffmpeg's `subtitles=` filter reading an uploaded ASS file (see
    // avMerger.ts's buildCaptionAssFile) — not inline drawtext — is what
    // keeps real narration text out of the command string entirely (a
    // real render was rejected by upload-post.com's command filter over
    // an ordinary word, see that function's header). The ASS file is
    // built and uploaded here (not inside avMerger.ts) for the same
    // reason the mux pass's output is re-hosted at a temp path first: this
    // provider's `files` field takes fetchable URLs, not raw content.
    const assContent = buildCaptionAssFile(captionRow?.timing_data, aspectRatio)
    let finalBuffer = muxOutcome.fileBuffer
    // captionElapsedMs stays null (not 0) when there were no cues, so the
    // success snapshot below can tell "no caption pass ran" apart from "the
    // caption pass ran and finished instantly" — relevant for confirming
    // whether it's specifically the caption pass (re-encoding the WHOLE
    // merged video, not just per-scene clips) that risks the ceiling.
    let captionElapsedMs: number | null = null
    // Which tier actually produced finalBuffer — 'quality' (CRF, the
    // default/first attempt on whichever pass is the true final render)
    // unless the size guard below had to escalate to the deterministic
    // capped fallback. Recorded into output_snapshot for observability.
    let encodeTier: 'quality' | 'capped' = 'quality'
    let cappedElapsedMs: number | null = null

    if (assContent) {
      const [muxTempUrl, assFileUrl] = await Promise.all([
        uploader.uploadBuffer(`${pipeline.job_id}/${track.language}-mux-tmp.mp4`, muxOutcome.fileBuffer, 'video/mp4'),
        uploader.uploadBuffer(
          `${pipeline.job_id}/${track.language}-captions-tmp.ass`,
          Buffer.from(assContent, 'utf-8'),
          'text/plain',
        ),
      ])
      const captionJobRef = await avMerger.submitCaptionBurn(muxTempUrl, assFileUrl)
      const captionOutcome = await pollUntilDone(avMerger, captionJobRef, 'caption', client, track.id)
      if ('cancelled' in captionOutcome) {
        console.log(`[render:caption] cancelled — stopping render, not recording a failure`)
        return { ran: true }
      }
      if (!('fileBuffer' in captionOutcome)) {
        const detail = 'failed' in captionOutcome ? captionOutcome.detail : 'FFmpeg caption pass poll timed out'
        throw new ProviderCallError('upload-post', null, `${detail} (after ${(captionOutcome.elapsedMs / 1000).toFixed(1)}s)`)
      }
      finalBuffer = captionOutcome.fileBuffer
      captionElapsedMs = captionOutcome.elapsedMs

      // Caption-burn's output IS the final render for a captioned track —
      // this is the only point that needs the size guard, not the
      // intermediate mux buffer above (that one's just an input to this
      // pass, never uploaded on its own). See SAFE_UPLOAD_BYTES's header.
      if (finalBuffer.length > SAFE_UPLOAD_BYTES) {
        console.log(
          `[render:caption] quality-tier output ${finalBuffer.length} bytes exceeds SAFE_UPLOAD_BYTES ` +
            `(${SAFE_UPLOAD_BYTES}) — escalating to the capped fallback`,
        )
        const cappedJobRef = await avMerger.submitCaptionBurnCapped(muxTempUrl, assFileUrl)
        const cappedOutcome = await pollUntilDone(avMerger, cappedJobRef, 'caption', client, track.id)
        if ('cancelled' in cappedOutcome) {
          console.log(`[render:caption] cancelled during capped fallback — stopping render, not recording a failure`)
          return { ran: true }
        }
        if (!('fileBuffer' in cappedOutcome)) {
          const detail = 'failed' in cappedOutcome ? cappedOutcome.detail : 'FFmpeg capped caption pass poll timed out'
          throw new ProviderCallError('upload-post', null, `${detail} (after ${(cappedOutcome.elapsedMs / 1000).toFixed(1)}s)`)
        }
        if (cappedOutcome.fileBuffer.length > SAFE_UPLOAD_BYTES) {
          // Should be unreachable given CAPPED_VIDEO_ENCODE_ARGS's own
          // worst-case math — a hard failure here means that math's
          // assumption broke, not a normal retryable condition, so this
          // deliberately isn't a silent upload of an oversized file.
          throw new Error(
            `render: capped caption-burn fallback still produced ${cappedOutcome.fileBuffer.length} bytes, over ` +
              `SAFE_UPLOAD_BYTES (${SAFE_UPLOAD_BYTES})`,
          )
        }
        finalBuffer = cappedOutcome.fileBuffer
        captionElapsedMs = cappedOutcome.elapsedMs
        cappedElapsedMs = cappedOutcome.elapsedMs
        encodeTier = 'capped'
      }
    } else if (muxOutcome.fileBuffer.length > SAFE_UPLOAD_BYTES) {
      // No captions — mux's own output IS the final render, so it's the
      // one that needs the size guard here instead.
      console.log(
        `[render:mux] quality-tier output ${muxOutcome.fileBuffer.length} bytes exceeds SAFE_UPLOAD_BYTES ` +
          `(${SAFE_UPLOAD_BYTES}) — escalating to the capped fallback`,
      )
      const cappedJobRef = await avMerger.submitMuxCapped(videoTempUrl, audioTempUrl, totalDurationSeconds)
      const cappedOutcome = await pollUntilDone(avMerger, cappedJobRef, 'mux', client, track.id)
      if ('cancelled' in cappedOutcome) {
        console.log(`[render:mux] cancelled during capped fallback — stopping render, not recording a failure`)
        return { ran: true }
      }
      if (!('fileBuffer' in cappedOutcome)) {
        const detail = 'failed' in cappedOutcome ? cappedOutcome.detail : 'FFmpeg capped mux pass poll timed out'
        throw new ProviderCallError('upload-post', null, `${detail} (after ${(cappedOutcome.elapsedMs / 1000).toFixed(1)}s)`)
      }
      if (cappedOutcome.fileBuffer.length > SAFE_UPLOAD_BYTES) {
        throw new Error(
          `render: capped mux fallback still produced ${cappedOutcome.fileBuffer.length} bytes, over ` +
            `SAFE_UPLOAD_BYTES (${SAFE_UPLOAD_BYTES})`,
        )
      }
      finalBuffer = cappedOutcome.fileBuffer
      cappedElapsedMs = cappedOutcome.elapsedMs
      encodeTier = 'capped'
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
        `, encodeTier=${encodeTier}, ${scenes.length} scenes, ${finalBuffer.length} bytes`,
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
      // capture worker stdout at the time. encodeTier/cappedElapsedMs are
      // the SAFE_UPLOAD_BYTES size guard's own observability — lets a real
      // rollout confirm how often the quality-first CRF pass actually
      // needs to escalate, without cross-referencing worker stdout.
      outputSnapshot: {
        fileUrl: permanentUrl,
        sceneCount: scenes.length,
        outputBytes: finalBuffer.length,
        videoConcatElapsedMs: videoOutcome.elapsedMs,
        audioConcatElapsedMs: audioOutcome.elapsedMs,
        muxElapsedMs: muxOutcome.elapsedMs,
        captionElapsedMs,
        encodeTier,
        cappedElapsedMs,
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
