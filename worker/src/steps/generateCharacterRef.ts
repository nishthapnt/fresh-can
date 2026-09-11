import type { SupabaseClient } from '@supabase/supabase-js'
import type { ImageGenerator } from '../adapters/types.js'
import { ProviderCallError } from '../adapters/types.js'
import type { VideoStorageUploader } from '../adapters/storage.js'
import {
  claimPipeline,
  hasSucceededStep,
  recordStepAttempt,
  markPipelineFailed,
  upsertVisualAsset,
  getVisualAssets,
  type PipelineRow,
} from '../db.js'
import { hasExceededMaxAttempts, isReadyToRetry, MAX_ATTEMPTS } from '../lib/backoff.js'

const POLL_INTERVAL_MS = 2000
const POLL_TIMEOUT_MS = 60_000

async function pollUntilDone(
  imageGenerator: ImageGenerator,
  jobRef: { providerRef: string },
): Promise<{ fileUrl: string } | { failed: true; detail: string } | { timedOut: true }> {
  const deadline = Date.now() + POLL_TIMEOUT_MS
  while (Date.now() < deadline) {
    const result = await imageGenerator.poll(jobRef)
    if (result.status === 'ready') return { fileUrl: result.fileUrl }
    if (result.status === 'failed') return { failed: true, detail: result.detail }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
  }
  return { timedOut: true }
}

/**
 * Shared, pipeline-scoped step — runs exactly ONCE per pipeline generation,
 * after approval, regardless of how many languages were requested
 * (ARCHITECTURE.MD §4.1/§4.2 step 3). This is the step that was, in n8n,
 * wrongly nested INSIDE the per-language loop — pulling it out here, before
 * generate_scene_visual and before any language track exists at all, is
 * what structurally prevents EN and FR from ever getting a different
 * character reference.
 *
 * Deliberately does NOT advance the pipeline past 'generating' — unlike
 * generatePhoto.ts (image_post has nothing further to generate). Leaves
 * pipeline.status at 'generating' so generate_scene_visual (same tick or a
 * later one) continues from there; only that step advances to 'ready'
 * (visuals_ready) once every scene is done.
 */
export async function runGenerateCharacterRef(
  client: SupabaseClient,
  pipeline: PipelineRow,
  prompt: string,
  imageGenerator: ImageGenerator,
  uploader: VideoStorageUploader,
  backoffBaseDelayMs = 5000,
  referenceImageUrl?: string,
): Promise<{ ran: boolean }> {
  const generation = pipeline.current_generation
  const stepName = 'generate_character_ref'

  const alreadySucceeded = await hasSucceededStep(
    client,
    { contentPipelineId: pipeline.id },
    stepName,
    generation,
  )

  if (!alreadySucceeded) {
    if (pipeline.status === 'approved') {
      const claimed = await claimPipeline(client, pipeline.id, 'approved', 'generating', {
        current_step: 'generating_character_ref',
      })
      if (!claimed) return { ran: false } // lost the race to another worker
    } else if (pipeline.status !== 'generating') {
      return { ran: false } // wrong state entirely for this step
    }

    const existingAssets = await getVisualAssets(client, pipeline.id, generation)
    const existing = existingAssets.find((a) => a.asset_type === 'character_ref' && !a.video_scene_id)

    // Same defensive re-check as generatePhoto.ts: a stray late retry must
    // never downgrade an already-ready asset back to failed.
    if (existing?.status === 'ready') {
      return { ran: true }
    }

    let attemptNumber = 1
    if (existing && (existing.status === 'failed' || existing.status === 'generating')) {
      const ready = isReadyToRetry({
        lastError: 'previous attempt did not succeed',
        retryCount: existing.attempt_number,
        updatedAt: new Date(existing.updated_at),
        baseDelayMs: backoffBaseDelayMs,
      })
      if (!ready) return { ran: false } // backoff window hasn't elapsed yet
      attemptNumber = existing.attempt_number + 1
    }

    try {
      await upsertVisualAsset(client, {
        contentPipelineId: pipeline.id,
        generation,
        assetType: 'character_ref',
        status: 'generating',
        attemptNumber,
      })

      const jobRef = await imageGenerator.submit({ prompt, referenceImageUrl })
      const outcome = await pollUntilDone(imageGenerator, jobRef)

      if ('fileUrl' in outcome) {
        const permanentUrl = await uploader.uploadFromUrl(
          `${pipeline.job_id}/character-ref.png`,
          outcome.fileUrl,
        )
        await upsertVisualAsset(client, {
          contentPipelineId: pipeline.id,
          generation,
          assetType: 'character_ref',
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
        assetType: 'character_ref',
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
        await markPipelineFailed(client, pipeline.id, message)
      }
      return { ran: true }
    }
  }

  return { ran: true }
}
