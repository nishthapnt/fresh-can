import type { SupabaseClient } from '@supabase/supabase-js'
import type { ImageGenerator, VideoGenerator } from '../adapters/types.js'
import { ProviderCallError } from '../adapters/types.js'
import type { VideoStorageUploader } from '../adapters/storage.js'
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
} from '../db.js'
import { hasExceededMaxAttempts, isReadyToRetry, MAX_ATTEMPTS } from '../lib/backoff.js'
import { BRAND_PROFILE, composeSceneImagePrompt, composeSceneVideoPrompt } from '../prompts/index.js'

const IMAGE_POLL_INTERVAL_MS = 2000
const IMAGE_POLL_TIMEOUT_MS = 60_000
// Kling clips take meaningfully longer than a still image to generate.
const VIDEO_POLL_INTERVAL_MS = 5000
const VIDEO_POLL_TIMEOUT_MS = 180_000

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
    })

    const jobRef = await imageGenerator.submit({ prompt, referenceImageUrl: characterRefUrl })
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
      const permanentUrl = await uploader.uploadFromUrl(
        `${pipeline.job_id}/scene-${scene.scene_number}-clip.mp4`,
        outcome.fileUrl,
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
 * Recomputes scenes_visuals_ready_count from the actual asset rows every
 * tick (never an in-memory increment) — self-correcting under retries or
 * concurrent workers, and flips the pipeline to 'ready' ("visuals_ready" in
 * prose) once every scene has both assets ready.
 */
export async function runGenerateSceneVisual(
  client: SupabaseClient,
  pipeline: PipelineRow,
  characterRefUrl: string,
  imageGenerator: ImageGenerator,
  videoGenerator: VideoGenerator,
  uploader: VideoStorageUploader,
  backoffBaseDelayMs = 5000,
): Promise<{ ran: boolean }> {
  if (pipeline.status !== 'generating') return { ran: false }

  const generation = pipeline.current_generation
  const scenes = await getVideoScenes(client, pipeline.id, generation)
  if (scenes.length === 0) return { ran: false }

  let anyRan = false
  for (const scene of scenes) {
    const assets = await getVisualAssets(client, pipeline.id, generation)
    const imageAsset = findAsset(assets, scene.id, 'scene_image')
    const clipAsset = findAsset(assets, scene.id, 'scene_video_clip')

    if (clipAsset?.status === 'ready') continue // this scene is fully done

    if (!imageAsset || imageAsset.status !== 'ready') {
      const ran = await runSceneImageStep(
        client,
        pipeline,
        scene,
        characterRefUrl,
        imageGenerator,
        uploader,
        backoffBaseDelayMs,
      )
      anyRan = anyRan || ran
      continue // this scene's video clip needs the image first — next tick
    }

    const ran = await runSceneVideoClipStep(
      client,
      pipeline,
      scene,
      imageAsset.file_url!,
      videoGenerator,
      uploader,
      backoffBaseDelayMs,
    )
    anyRan = anyRan || ran
  }

  // Recompute readiness from the actual rows — never an increment, so a
  // retried step or a second worker picking up the same pipeline can't
  // double-count or drift.
  const finalAssets = await getVisualAssets(client, pipeline.id, generation)
  const readyCount = scenes.filter((scene) => {
    const img = findAsset(finalAssets, scene.id, 'scene_image')
    const clip = findAsset(finalAssets, scene.id, 'scene_video_clip')
    return img?.status === 'ready' && clip?.status === 'ready'
  }).length

  if (readyCount === scenes.length) {
    await claimPipeline(client, pipeline.id, 'generating', 'ready', {
      scenes_visuals_ready_count: readyCount,
      current_step: 'visuals_ready',
    })
  } else if (readyCount !== pipeline.scenes_visuals_ready_count) {
    // Progress-counter refresh only — not a state transition, no claim
    // semantics needed.
    await client
      .from('content_pipelines')
      .update({ scenes_visuals_ready_count: readyCount, updated_at: new Date().toISOString() })
      .eq('id', pipeline.id)
  }

  return { ran: anyRan }
}
