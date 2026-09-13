import type { SupabaseClient } from '@supabase/supabase-js'
import type { ImageGenerator, VideoGenerator, SceneClipScaler } from '../../adapters/types.js'
import { ProviderCallError } from '../../adapters/types.js'
import type { VideoStorageUploader } from '../../adapters/storage.js'
import {
  claimPipeline,
  hasSucceededStep,
  recordStepAttempt,
  markPipelineFailed,
  upsertVisualAsset,
  getVisualAssets,
  getVideoScenes,
  type PipelineRow,
  type VideoSceneRow,
  type VisualAssetRow,
} from '../../db.js'
import { hasExceededMaxAttempts, isReadyToRetry, MAX_ATTEMPTS } from '../../lib/backoff.js'
import { BRAND_PROFILE, composeSceneImagePrompt, composeSceneVideoPrompt } from '../../prompts/index.js'

const IMAGE_POLL_INTERVAL_MS = 2000
const IMAGE_POLL_TIMEOUT_MS = 60_000
// Kling clips take meaningfully longer than a still image to generate.
// Raised from 180_000 (2026-09-14): a real 9-scene run had 3 of 9 scenes
// (1, 4, 7) time out on their first poll window at 180s, and scene 7 timed
// out on all 5 retry attempts in a row, exhausting MAX_ATTEMPTS.kie and
// hard-failing the whole shared-visuals phase — burning ~50 minutes and 5
// KIE.ai video-generation charges on one scene with nothing to show for it.
// 360s gives real in-flight generations more room to finish before the
// worker gives up and pays for a fresh attempt.
const VIDEO_POLL_INTERVAL_MS = 5000
const VIDEO_POLL_TIMEOUT_MS = 360_000
// A per-scene downscale pass (via upload-post.com's FFmpeg Editor API, same
// provider as the render step) used to run here before each clip is
// stored. A previous version of this existed, was removed, then
// reintroduced (2026-09-13) — the removal was based on a wrong diagnosis:
// every attempt was actually crashing INSTANTLY on a full_command shape
// mismatch ({input0} instead of the bare {input} a single-file command
// needs — see avMerger.ts's buildScaleCommand), and a separate bug in this
// adapter's poll() (checking for the wrong-case status strings) meant we
// never saw that crash — every attempt just looked like a ~5-8min timeout
// instead. Both bugs are fixed now. Reintroduced because un-downscaled
// clips are a real problem on their own: a real 8-scene 9:16 render's raw
// clips (native resolution, no bitrate cap) summed to 140.6MB and failed
// to re-upload past Supabase Storage's project-wide size limit when the
// render step tried to re-host its own concat output. Downscaling each
// clip to its aspect ratio's standard delivery resolution before it's ever
// stored keeps the eventual concatenated file well within that limit,
// without a perceptible quality loss (nothing downstream displays more
// than that resolution anyway).
const SCALE_POLL_INTERVAL_MS = 5000
// Real evidence (2026-09-13) that a single-file re-encode via this same
// provider completes in under a second (buildVideoConcatCommand's own
// 2-scene concat took 0.73-0.77s) — a single clip's downscale should be at
// least as fast. Generous margin over that anyway, rather than a tight
// timeout, since we don't yet have a real timing sample for a full-length
// (~10s) clip specifically.
const SCALE_POLL_TIMEOUT_MS = 3 * 60_000

// Standard delivery resolution per aspect ratio — what TikTok/Reels/Shorts
// (and this app's own preview players, src/lib/aspectRatioClass.ts) all
// treat as the real display size regardless of how many more pixels a
// generated clip happens to natively carry.
const SCALE_TARGETS: Record<'9:16' | '1:1' | '16:9', { width: number; height: number }> = {
  '9:16': { width: 1080, height: 1920 },
  '1:1': { width: 1080, height: 1080 },
  '16:9': { width: 1920, height: 1080 },
}

async function pollImageUntilDone(
  imageGenerator: ImageGenerator,
  jobRef: { providerRef: string },
): Promise<{ fileUrl: string } | { failed: true; detail: string } | { timedOut: true }> {
  const deadline = Date.now() + IMAGE_POLL_TIMEOUT_MS
  while (Date.now() < deadline) {
    const result = await imageGenerator.poll(jobRef)
    if (result.status === 'ready') return { fileUrl: result.fileUrl }
    if (result.status === 'failed') return { failed: true, detail: result.detail }
    await new Promise((resolve) => setTimeout(resolve, IMAGE_POLL_INTERVAL_MS))
  }
  return { timedOut: true }
}

async function pollVideoUntilDone(
  videoGenerator: VideoGenerator,
  jobRef: { providerRef: string },
): Promise<{ fileUrl: string } | { failed: true; detail: string } | { timedOut: true }> {
  const deadline = Date.now() + VIDEO_POLL_TIMEOUT_MS
  while (Date.now() < deadline) {
    const result = await videoGenerator.poll(jobRef)
    if (result.status === 'ready') return { fileUrl: result.fileUrl }
    if (result.status === 'failed') return { failed: true, detail: result.detail }
    await new Promise((resolve) => setTimeout(resolve, VIDEO_POLL_INTERVAL_MS))
  }
  return { timedOut: true }
}

async function pollScaleUntilDone(
  scaler: SceneClipScaler,
  jobRef: { providerRef: string },
): Promise<{ fileBuffer: Buffer } | { failed: true; detail: string } | { timedOut: true }> {
  const deadline = Date.now() + SCALE_POLL_TIMEOUT_MS
  while (Date.now() < deadline) {
    const result = await scaler.poll(jobRef)
    if (result.status === 'ready') return { fileBuffer: result.fileBuffer }
    if (result.status === 'failed') return { failed: true, detail: result.detail }
    await new Promise((resolve) => setTimeout(resolve, SCALE_POLL_INTERVAL_MS))
  }
  return { timedOut: true }
}

/** Kling 2.6 only accepts "5" or "10" — round the scene's planned budget to
 *  whichever is closer, per ARCHITECTURE.MD §4.2's "duration is a budget,
 *  not an exact figure" framing. */
function pickDurationSeconds(targetDurationMs: number): '5' | '10' {
  return targetDurationMs > 7500 ? '10' : '5'
}

function findAsset(
  assets: VisualAssetRow[],
  sceneId: string,
  assetType: 'scene_image' | 'scene_video_clip',
): VisualAssetRow | undefined {
  return assets.find((a) => a.video_scene_id === sceneId && a.asset_type === assetType)
}

async function runSceneImageStep(
  client: SupabaseClient,
  pipeline: PipelineRow,
  scene: VideoSceneRow,
  characterRefUrl: string,
  imageGenerator: ImageGenerator,
  uploader: VideoStorageUploader,
  backoffBaseDelayMs: number,
  aspectRatio?: '9:16' | '1:1' | '16:9',
): Promise<boolean> {
  const generation = pipeline.current_generation
  const alreadySucceeded = await hasSucceededStep(
    client,
    { contentPipelineId: pipeline.id },
    `generate_scene_visual:image:${scene.scene_number}`,
    generation,
  )
  if (alreadySucceeded) return false

  const assets = await getVisualAssets(client, pipeline.id, generation)
  const existing = findAsset(assets, scene.id, 'scene_image')
  if (existing?.status === 'ready') return false

  let attemptNumber = 1
  if (existing && (existing.status === 'failed' || existing.status === 'generating')) {
    const ready = isReadyToRetry({
      lastError: 'previous attempt did not succeed',
      retryCount: existing.attempt_number,
      updatedAt: new Date(existing.updated_at),
      baseDelayMs: backoffBaseDelayMs,
    })
    if (!ready) return false
    attemptNumber = existing.attempt_number + 1
  }

  const stepName = `generate_scene_visual:image:${scene.scene_number}`
  try {
    await upsertVisualAsset(client, {
      contentPipelineId: pipeline.id,
      generation,
      assetType: 'scene_image',
      videoSceneId: scene.id,
      status: 'generating',
      attemptNumber,
    })

    const { prompt } = composeSceneImagePrompt(BRAND_PROFILE, {
      pipelineId: pipeline.id,
      sceneNumber: scene.scene_number,
      visualDescription: scene.visual_description,
      shotNotes: scene.shot_notes,
      characterRefUrl,
      regenInstructions: pipeline.regen_instructions,
    })

    const jobRef = await imageGenerator.submit({ prompt, referenceImageUrl: characterRefUrl, aspectRatio })
    const outcome = await pollImageUntilDone(imageGenerator, jobRef)

    if ('fileUrl' in outcome) {
      const permanentUrl = await uploader.uploadFromUrl(
        `${pipeline.job_id}/scene-${scene.scene_number}-image.png`,
        outcome.fileUrl,
      )
      await upsertVisualAsset(client, {
        contentPipelineId: pipeline.id,
        generation,
        assetType: 'scene_image',
        videoSceneId: scene.id,
        status: 'ready',
        providerRef: jobRef.providerRef,
        fileUrl: permanentUrl,
        attemptNumber,
      })
      await recordStepAttempt(client, {
        contentPipelineId: pipeline.id,
        stepName,
        generation,
        attemptNumber,
        status: 'succeeded',
        provider: 'kie',
        outputSnapshot: { fileUrl: permanentUrl },
      })
    } else {
      const detail = 'failed' in outcome ? outcome.detail : 'KIE.ai poll timed out'
      throw new ProviderCallError('kie', null, detail)
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await upsertVisualAsset(client, {
      contentPipelineId: pipeline.id,
      generation,
      assetType: 'scene_image',
      videoSceneId: scene.id,
      status: 'failed',
      attemptNumber,
    })
    await recordStepAttempt(client, {
      contentPipelineId: pipeline.id,
      stepName,
      generation,
      attemptNumber,
      status: 'failed_retryable',
      provider: 'kie',
      errorMessage: message,
    })
    if (hasExceededMaxAttempts(attemptNumber, MAX_ATTEMPTS.kie)) {
      await markPipelineFailed(client, pipeline.id, `scene ${scene.scene_number} image: ${message}`)
    }
  }
  return true
}

async function runSceneVideoClipStep(
  client: SupabaseClient,
  pipeline: PipelineRow,
  scene: VideoSceneRow,
  sceneImageUrl: string,
  videoGenerator: VideoGenerator,
  uploader: VideoStorageUploader,
  backoffBaseDelayMs: number,
  scaler: SceneClipScaler,
  aspectRatio: '9:16' | '1:1' | '16:9' = '9:16',
): Promise<boolean> {
  const generation = pipeline.current_generation
  const alreadySucceeded = await hasSucceededStep(
    client,
    { contentPipelineId: pipeline.id },
    `generate_scene_visual:clip:${scene.scene_number}`,
    generation,
  )
  if (alreadySucceeded) return false

  const assets = await getVisualAssets(client, pipeline.id, generation)
  const existing = findAsset(assets, scene.id, 'scene_video_clip')
  if (existing?.status === 'ready') return false

  let attemptNumber = 1
  if (existing && (existing.status === 'failed' || existing.status === 'generating')) {
    const ready = isReadyToRetry({
      lastError: 'previous attempt did not succeed',
      retryCount: existing.attempt_number,
      updatedAt: new Date(existing.updated_at),
      baseDelayMs: backoffBaseDelayMs,
    })
    if (!ready) return false
    attemptNumber = existing.attempt_number + 1
  }

  const stepName = `generate_scene_visual:clip:${scene.scene_number}`
  try {
    await upsertVisualAsset(client, {
      contentPipelineId: pipeline.id,
      generation,
      assetType: 'scene_video_clip',
      videoSceneId: scene.id,
      status: 'generating',
      attemptNumber,
    })

    const prompt = composeSceneVideoPrompt({
      visualDescription: scene.visual_description,
      shotNotes: scene.shot_notes,
    })
    const jobRef = await videoGenerator.submit({
      prompt,
      referenceImageUrl: sceneImageUrl,
      durationSeconds: pickDurationSeconds(scene.target_duration_ms),
    })
    const outcome = await pollVideoUntilDone(videoGenerator, jobRef)

    if ('fileUrl' in outcome) {
      const target = SCALE_TARGETS[aspectRatio]
      const scaleJobRef = await scaler.submitScale(outcome.fileUrl, target.width, target.height)
      const scaleOutcome = await pollScaleUntilDone(scaler, scaleJobRef)
      if (!('fileBuffer' in scaleOutcome)) {
        const detail = 'failed' in scaleOutcome ? scaleOutcome.detail : 'downscale poll timed out'
        throw new ProviderCallError('upload_post', null, detail)
      }

      const permanentUrl = await uploader.uploadBuffer(
        `${pipeline.job_id}/scene-${scene.scene_number}-clip.mp4`,
        scaleOutcome.fileBuffer,
        'video/mp4',
      )
      await upsertVisualAsset(client, {
        contentPipelineId: pipeline.id,
        generation,
        assetType: 'scene_video_clip',
        videoSceneId: scene.id,
        status: 'ready',
        providerRef: jobRef.providerRef,
        fileUrl: permanentUrl,
        attemptNumber,
      })
      await recordStepAttempt(client, {
        contentPipelineId: pipeline.id,
        stepName,
        generation,
        attemptNumber,
        status: 'succeeded',
        provider: 'kie',
        outputSnapshot: { fileUrl: permanentUrl },
      })
    } else {
      const detail = 'failed' in outcome ? outcome.detail : 'KIE.ai poll timed out'
      throw new ProviderCallError('kie', null, detail)
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await upsertVisualAsset(client, {
      contentPipelineId: pipeline.id,
      generation,
      assetType: 'scene_video_clip',
      videoSceneId: scene.id,
      status: 'failed',
      attemptNumber,
    })
    await recordStepAttempt(client, {
      contentPipelineId: pipeline.id,
      stepName,
      generation,
      attemptNumber,
      status: 'failed_retryable',
      provider: 'kie',
      errorMessage: message,
    })
    if (hasExceededMaxAttempts(attemptNumber, MAX_ATTEMPTS.kie)) {
      await markPipelineFailed(client, pipeline.id, `scene ${scene.scene_number} clip: ${message}`)
    }
  }
  return true
}

/**
 * Recomputes scenes_visuals_ready_count from the actual asset rows and
 * persists it — always a full recompute, never an in-memory increment, so
 * a retried step or a second worker touching the same pipeline can't
 * double-count or drift. `lastPersistedCount`/`announcedInProgress` are
 * only a cheap "did this specific value change since the last write THIS
 * call made" guard against redundant writes — not the source of truth.
 *
 * Called after EVERY scene in runGenerateSceneVisual's loop below, not
 * once at the very end — see that function's header for why that
 * distinction is load-bearing, not cosmetic.
 */
async function refreshVisualsProgress(
  client: SupabaseClient,
  pipeline: PipelineRow,
  scenes: VideoSceneRow[],
  generation: number,
  lastPersistedCount: number,
  announcedInProgress: boolean,
): Promise<{ lastPersistedCount: number; announcedInProgress: boolean; reachedReady: boolean }> {
  const assets = await getVisualAssets(client, pipeline.id, generation)
  const readyCount = scenes.filter((scene) => {
    const img = findAsset(assets, scene.id, 'scene_image')
    const clip = findAsset(assets, scene.id, 'scene_video_clip')
    return img?.status === 'ready' && clip?.status === 'ready'
  }).length

  if (readyCount === scenes.length) {
    // CAS — a no-op if another call already made this same transition
    // (e.g. this function reaching the ready count on what turns out to be
    // its last, redundant loop iteration after an earlier iteration's
    // refresh already flipped the pipeline to 'ready').
    await claimPipeline(client, pipeline.id, 'generating', 'ready', {
      scenes_visuals_ready_count: readyCount,
      current_step: 'visuals_ready',
    })
    return { lastPersistedCount: readyCount, announcedInProgress: true, reachedReady: true }
  }

  if (readyCount !== lastPersistedCount || !announcedInProgress) {
    await client
      .from('content_pipelines')
      .update({
        scenes_visuals_ready_count: readyCount,
        current_step: 'generating_scene_visuals',
        updated_at: new Date().toISOString(),
      })
      .eq('id', pipeline.id)
    return { lastPersistedCount: readyCount, announcedInProgress: true, reachedReady: false }
  }

  return { lastPersistedCount, announcedInProgress, reachedReady: false }
}

/**
 * Shared, pipeline-scoped step — fanned per scene (ARCHITECTURE.MD §4.2
 * step 4, §7.1's fan-in, minus the queue framing this codebase doesn't
 * have). For each of this pipeline's video_scenes rows: scene_image first
 * (Flux Kontext editing FROM the character_ref asset — see
 * generateCharacterRef.ts — never a fresh, independent reference), then
 * scene_video_clip (Kling image-to-video animating FROM that exact
 * scene_image). Neither sub-step imports anything from a track-scoped step
 * file, and neither is reachable from a per-language trigger — this is what
 * makes "EN and FR share the identical scene visuals" a structural fact,
 * not a convention.
 *
 * Each scene's image/clip step does its own real, blocking submit+poll
 * (up to 60s for an image, 180s for a clip — see pollImageUntilDone/
 * pollVideoUntilDone above), so one call to this function can legitimately
 * run for many minutes working through every scene in this for loop
 * before ever returning. refreshVisualsProgress is called after EVERY
 * scene specifically because of that: without it, content_pipelines'
 * scenes_visuals_ready_count/current_step — which the dashboard's "Shared
 * production" card (src/app/dashboard/jobs/[job_id]/page.tsx) reads
 * verbatim — would stay frozen at whatever they were when this call
 * began until the ENTIRE loop finished, making a real, steadily-progressing
 * generation look completely stalled the whole time. Confirmed live: a
 * real 8-scene job sat at "generating character ref · 0/8 scenes ready"
 * for 16+ minutes while 7 of 8 scene clips actually succeeded underneath,
 * because the old code only wrote back once, after every scene was done.
 */
export async function runGenerateSceneVisual(
  client: SupabaseClient,
  pipeline: PipelineRow,
  characterRefUrl: string,
  imageGenerator: ImageGenerator,
  videoGenerator: VideoGenerator,
  uploader: VideoStorageUploader,
  scaler: SceneClipScaler,
  backoffBaseDelayMs = 5000,
  aspectRatio?: '9:16' | '1:1' | '16:9',
): Promise<{ ran: boolean }> {
  if (pipeline.status !== 'generating') return { ran: false }

  const generation = pipeline.current_generation
  const scenes = await getVideoScenes(client, pipeline.id)
  if (scenes.length === 0) return { ran: false }

  let lastPersistedCount = pipeline.scenes_visuals_ready_count
  let announcedInProgress = pipeline.current_step === 'generating_scene_visuals'

  let anyRan = false
  for (const scene of scenes) {
    const assets = await getVisualAssets(client, pipeline.id, generation)
    const imageAsset = findAsset(assets, scene.id, 'scene_image')
    const clipAsset = findAsset(assets, scene.id, 'scene_video_clip')

    if (clipAsset?.status !== 'ready') {
      if (!imageAsset || imageAsset.status !== 'ready') {
        const ran = await runSceneImageStep(
          client,
          pipeline,
          scene,
          characterRefUrl,
          imageGenerator,
          uploader,
          backoffBaseDelayMs,
          aspectRatio,
        )
        anyRan = anyRan || ran
      } else {
        const ran = await runSceneVideoClipStep(
          client,
          pipeline,
          scene,
          imageAsset.file_url!,
          videoGenerator,
          uploader,
          backoffBaseDelayMs,
          scaler,
          aspectRatio,
        )
        anyRan = anyRan || ran
      }
    }

    const refreshed = await refreshVisualsProgress(
      client,
      pipeline,
      scenes,
      generation,
      lastPersistedCount,
      announcedInProgress,
    )
    lastPersistedCount = refreshed.lastPersistedCount
    announcedInProgress = refreshed.announcedInProgress
    if (refreshed.reachedReady) break // every scene done — nothing left for remaining iterations to find
  }

  return { ran: anyRan }
}
