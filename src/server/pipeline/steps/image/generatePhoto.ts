import type { SupabaseClient } from '@supabase/supabase-js'
import type { ImageGenerator } from '../../adapters/types'
import { ProviderCallError } from '../../adapters/types'
import type { PhotoStorageUploader } from '../../adapters/storage'
import {
  claimPipeline,
  hasSucceededStep,
  recordStepAttempt,
  markPipelineFailed,
  upsertVisualAsset,
  getVisualAssets,
  type PipelineRow,
} from '../../db'
import { hasExceededMaxAttempts, isReadyToRetry, MAX_ATTEMPTS } from '../../lib/backoff'

const POLL_INTERVAL_MS = 2000
// Raised from 60s (2026-09-17) — same fix as blog/generateVisualImage.ts's
// identical constant: a too-short timeout abandons a KIE (nano-banana-2)
// job that's still genuinely rendering, burning a retry (and its credits)
// on a duplicate generation instead of just waiting a bit longer.
const POLL_TIMEOUT_MS = 360_000

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
 * Shared, pipeline-scoped step — image_post's ONE shared visual (unlike
 * Blog's hero+inline pair, so no 2-item fan-in needed here). Also owns the
 * created -> generating transition directly, since image_post has no
 * outline/drafting step to gate on (unlike Blog's generate_outline) —
 * there's nothing else this pipeline needs before starting the photo.
 *
 * Downloads the provider's (ephemeral) result and re-uploads it to
 * permanent storage before marking the asset ready — see
 * adapters/storage.ts for why this matters.
 */
export async function runGeneratePhoto(
  client: SupabaseClient,
  pipeline: PipelineRow,
  prompt: string,
  imageGenerator: ImageGenerator,
  uploader: PhotoStorageUploader,
  backoffBaseDelayMs = 5000,
  referenceImageUrl?: string,
): Promise<{ ran: boolean }> {
  const generation = pipeline.current_generation
  const stepName = 'generate_photo'

  const alreadySucceeded = await hasSucceededStep(
    client,
    { contentPipelineId: pipeline.id },
    stepName,
    generation,
  )

  if (!alreadySucceeded) {
    if (pipeline.status === 'created') {
      const claimed = await claimPipeline(client, pipeline.id, 'created', 'generating')
      if (!claimed) return { ran: false } // lost the race to another worker
    } else if (pipeline.status !== 'generating') {
      return { ran: false } // wrong state entirely for this step
    }

    const existingAssets = await getVisualAssets(client, pipeline.id, generation)
    const existing = existingAssets.find((a) => a.asset_type === 'photo')

    // Defense against a stray late re-invocation racing an already-succeeded
    // attempt (observed live: a second call started ~21s after the first had
    // already written a 'ready' asset and advanced the pipeline to 'ready' —
    // hasSucceededStep's pipeline_steps check should have short-circuited
    // this above, but confirming against content_visual_assets itself here
    // too means a spurious extra attempt can never downgrade an
    // already-succeeded asset back to 'failed' and wipe its file_url.
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

      // Before burning a new KIE generation, check whether the PREVIOUS
      // attempt's job actually finished after we stopped watching it — e.g.
      // our own poll timeout gave up while KIE was still rendering, or the
      // worker crashed mid-poll. Skipping this would mean paying for the
      // abandoned job AND the new one this retry is about to submit (see
      // POLL_TIMEOUT_MS's own history for a real case of this).
      if (existing.provider_ref) {
        try {
          const recheck = await imageGenerator.poll({ providerRef: existing.provider_ref })
          if (recheck.status === 'ready') {
            const permanentUrl = await uploader.upload(pipeline.job_id, recheck.fileUrl)
            await upsertVisualAsset(client, {
              contentPipelineId: pipeline.id,
              generation,
              assetType: 'photo',
              status: 'ready',
              providerRef: existing.provider_ref,
              fileUrl: permanentUrl,
              attemptNumber: existing.attempt_number,
            })
            await recordStepAttempt(client, {
              contentPipelineId: pipeline.id,
              stepName,
              generation,
              attemptNumber: existing.attempt_number,
              status: 'succeeded',
              provider: 'kie',
              outputSnapshot: { fileUrl: permanentUrl },
            })
            return { ran: true }
          }
          // 'pending' or 'failed' — the abandoned job genuinely isn't
          // usable; fall through to submitting a fresh one below.
        } catch {
          // Provider lookup itself failed (e.g. the task expired/was
          // purged) — fall through to a fresh submit.
        }
      }

      attemptNumber = existing.attempt_number + 1
    }
    // else: no row yet, or status === 'pending' — treat as a fresh first attempt

    let jobRef: { providerRef: string } | undefined
    try {
      await upsertVisualAsset(client, {
        contentPipelineId: pipeline.id,
        generation,
        assetType: 'photo',
        status: 'generating',
        attemptNumber,
      })

      jobRef = await imageGenerator.submit({ prompt, referenceImageUrl })
      // Persist the provider ref as soon as we have it — before the (up to
      // POLL_TIMEOUT_MS) poll loop below — so a crash or timeout here still
      // leaves the retry check above something to recover from next time.
      await upsertVisualAsset(client, {
        contentPipelineId: pipeline.id,
        generation,
        assetType: 'photo',
        status: 'generating',
        providerRef: jobRef.providerRef,
        attemptNumber,
      })

      const outcome = await pollUntilDone(imageGenerator, jobRef)

      if ('fileUrl' in outcome) {
        const permanentUrl = await uploader.upload(pipeline.job_id, outcome.fileUrl)
        await upsertVisualAsset(client, {
          contentPipelineId: pipeline.id,
          generation,
          assetType: 'photo',
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
        assetType: 'photo',
        status: 'failed',
        // Keep the provider ref (if we got one) so the next retry's
        // recheck above can still find this job and adopt it if it
        // finishes after we've given up on it.
        providerRef: jobRef?.providerRef,
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

  // Advance to ready regardless of whether this call did the work or found
  // it already done (resumed worker case) — mirrors generateOutline.ts.
  await claimPipeline(client, pipeline.id, 'generating', 'ready')
  return { ran: true }
}
