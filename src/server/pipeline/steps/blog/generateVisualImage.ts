import type { SupabaseClient } from '@supabase/supabase-js'
import type { ImageGenerator } from '../../adapters/types'
import { ProviderCallError } from '../../adapters/types'
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
// Raised from 60s (2026-09-17): a real run needed 4 attempts on the hero
// image alone — two of the failures were this timeout firing while KIE
// (nano-banana-2) was still genuinely rendering, not a real provider
// failure. Abandoning a job this early both wastes the attempt budget and
// risks paying for an abandoned generation that completes anyway after we
// stop watching it (see MAX_ATTEMPTS.kie in lib/backoff.ts for the retry cap).
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
 * Shared, pipeline-scoped step — one of two (hero + inline). Both run
 * concurrently once generate_outline succeeds; the pipeline only advances to
 * 'ready' (shared_visual_ready) once BOTH have a 'ready' content_visual_assets
 * row for the current generation — a 2-item fan-in (ARCHITECTURE.MD §7.1).
 * No silent fallback placeholder on exhausted retries — real failure is
 * recorded (SPECIFICATIONS.md §14 TARGET).
 *
 * Retry/backoff is tracked per-asset (content_visual_assets.attempt_number/
 * updated_at), NOT via the pipeline's shared retry_count — hero and inline
 * are independent generations; sharing one counter would inflate one asset's
 * attempt count from the other's failures. A 'generating' row found on a
 * later call (rather than 'ready') means a prior attempt never resolved
 * (e.g. a worker crash mid-poll) — treated the same as 'failed' for retry
 * purposes, which is what makes this step recoverable after a crash.
 */
export async function runGenerateVisualImage(
  client: SupabaseClient,
  pipeline: PipelineRow,
  assetType: 'hero_image' | 'inline_image',
  prompt: string,
  imageGenerator: ImageGenerator,
  backoffBaseDelayMs = 5000,
  referenceImageUrl?: string,
): Promise<{ ran: boolean }> {
  const generation = pipeline.current_generation
  const stepName = assetType === 'hero_image' ? 'generate_hero_image' : 'generate_inline_image'

  const alreadySucceeded = await hasSucceededStep(
    client,
    { contentPipelineId: pipeline.id },
    stepName,
    generation,
  )

  const existingAssets = await getVisualAssets(client, pipeline.id, generation)
  const existing = existingAssets.find((a) => a.asset_type === assetType)

  // Defense against a stray late re-invocation racing an already-succeeded
  // attempt (observed live in image_post's analogous generatePhoto.ts: a
  // second call started ~21s after the first had already written a 'ready'
  // asset — hasSucceededStep's pipeline_steps check should short-circuit
  // this via `alreadySucceeded` above, but confirming against
  // content_visual_assets itself too means a spurious extra attempt can
  // never downgrade an already-succeeded asset back to 'failed' and wipe
  // its file_url).
  if (!alreadySucceeded && existing?.status !== 'ready') {
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
      // POLL_TIMEOUT_MS's own history above for a real case of this).
      if (existing.provider_ref) {
        try {
          const recheck = await imageGenerator.poll({ providerRef: existing.provider_ref })
          if (recheck.status === 'ready') {
            await upsertVisualAsset(client, {
              contentPipelineId: pipeline.id,
              generation,
              assetType,
              status: 'ready',
              providerRef: existing.provider_ref,
              fileUrl: recheck.fileUrl,
              attemptNumber: existing.attempt_number,
            })
            await recordStepAttempt(client, {
              contentPipelineId: pipeline.id,
              stepName,
              generation,
              attemptNumber: existing.attempt_number,
              status: 'succeeded',
              provider: 'kie',
              outputSnapshot: { fileUrl: recheck.fileUrl },
            })
            await tryAdvanceToSharedVisualReady(client, pipeline.id, generation)
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
        assetType,
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
        assetType,
        status: 'generating',
        providerRef: jobRef.providerRef,
        attemptNumber,
      })

      const outcome = await pollUntilDone(imageGenerator, jobRef)

      if ('fileUrl' in outcome) {
        await upsertVisualAsset(client, {
          contentPipelineId: pipeline.id,
          generation,
          assetType,
          status: 'ready',
          providerRef: jobRef.providerRef,
          fileUrl: outcome.fileUrl,
          attemptNumber,
        })
        await recordStepAttempt(client, {
          contentPipelineId: pipeline.id,
          stepName,
          generation,
          attemptNumber,
          status: 'succeeded',
          provider: 'kie',
          outputSnapshot: { fileUrl: outcome.fileUrl },
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
        assetType,
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
        // This one asset exhausted its retries — the whole pipeline fails,
        // since both hero and inline are required (docs/DECISIONS.md #5).
        await markPipelineFailed(client, pipeline.id, `${assetType}: ${message}`)
      }
      return { ran: true }
    }
  }

  await tryAdvanceToSharedVisualReady(client, pipeline.id, generation)
  return { ran: true }
}

/** 2-item fan-in: only transition once BOTH hero and inline are ready. */
async function tryAdvanceToSharedVisualReady(
  client: SupabaseClient,
  contentPipelineId: string,
  generation: number,
): Promise<void> {
  const assets = await getVisualAssets(client, contentPipelineId, generation)
  const hero = assets.find((a) => a.asset_type === 'hero_image')
  const inline = assets.find((a) => a.asset_type === 'inline_image')
  if (hero?.status === 'ready' && inline?.status === 'ready') {
    await claimPipeline(client, contentPipelineId, 'generating', 'ready')
  }
}
