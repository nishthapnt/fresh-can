import type { SupabaseClient } from '@supabase/supabase-js'
import type { ImageGenerator, ImagePollResult } from '../../adapters/types'
import { ProviderCallError } from '../../adapters/types'
import type { VideoStorageUploader } from '../../adapters/storage'
import {
  claimPipeline,
  hasSucceededStep,
  recordStepAttempt,
  markPipelineFailed,
  upsertVisualAsset,
  getVisualAssets,
  isPipelineFailed,
  type PipelineRow,
} from '../../db'
import { hasExceededMaxAttempts, isReadyToRetry, MAX_ATTEMPTS } from '../../lib/backoff'

const POLL_INTERVAL_MS = 2000
const POLL_TIMEOUT_MS = 60_000

/** Same transient-vs-genuine distinction as generateSceneVisual.ts's shared
 *  pollUntilDone (this step predates that file's version and has never been
 *  unified with it — same reasoning applies here, just not shared code): a
 *  poll() throwing (network blip) means the STATUS CHECK failed, not the
 *  generation itself, so it's retried in place rather than failing the whole
 *  step and burning a fresh paid submission on retry. A 404 is the one
 *  exception — the provider has no record of this task at all, so retrying
 *  the same poll would just burn the timeout window for nothing; treated as
 *  an immediate, definite failure instead.
 *
 *  Cancellation check (2026-09-22, P0 fix) — see isPipelineFailed's header
 *  (db.ts) and generateSceneVisual.ts's own pollUntilDone for the full
 *  reasoning; not duplicated here. */
async function pollUntilDone(
  client: SupabaseClient,
  pipelineId: string,
  imageGenerator: ImageGenerator,
  jobRef: { providerRef: string },
): Promise<{ fileUrl: string } | { failed: true; detail: string } | { timedOut: true } | { cancelled: true }> {
  const deadline = Date.now() + POLL_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (await isPipelineFailed(client, pipelineId)) {
      console.log('[generate_character_ref] cancelled — stopping poll early, task left resumable')
      return { cancelled: true }
    }
    let result: ImagePollResult
    try {
      result = await imageGenerator.poll(jobRef)
    } catch (err) {
      if (err instanceof ProviderCallError && err.httpStatus === 404) {
        console.warn('[generate_character_ref] provider reports task not found (404) — treating as genuinely failed, not transient')
        return { failed: true, detail: err.detail }
      }
      const message = err instanceof Error ? err.message : String(err)
      console.warn(`[generate_character_ref] transient poll error, retrying same job: ${message}`)
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
      continue
    }
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
  aspectRatio?: '9:16' | '1:1' | '16:9',
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
    let jobRef: { providerRef: string } | undefined

    if (existing?.status === 'generating' && existing.provider_ref) {
      // submit() already succeeded and was already billed for this attempt
      // — the worker just never got to observe the result (most commonly:
      // killed/restarted mid-poll by tsx watch or a deploy). Resuming this
      // EXACT task instead of submitting a new one is what makes this step
      // safe to interrupt: an interruption can never turn one paid
      // generation into two. Never gated by backoff below — backoff paces
      // NEW attempts after a CONFIRMED failure, not checking on work
      // already in flight.
      attemptNumber = existing.attempt_number
      jobRef = { providerRef: existing.provider_ref }
      console.log(`[${stepName}] RESUMED existing task ${jobRef.providerRef} (attempt ${attemptNumber}) — no new submission`)
    } else if (existing && (existing.status === 'failed' || existing.status === 'generating')) {
      // status === 'generating' with no provider_ref here means the
      // process died before submit() even returned — nothing was ever
      // billed, so there is genuinely nothing to resume.
      const ready = isReadyToRetry({
        lastError: 'previous attempt did not succeed',
        retryCount: existing.attempt_number,
        updatedAt: new Date(existing.updated_at),
        baseDelayMs: backoffBaseDelayMs,
      })
      if (!ready) return { ran: false } // backoff window hasn't elapsed yet
      attemptNumber = existing.attempt_number + 1
      console.log(`[${stepName}] RETRY — attempt ${existing.attempt_number} left no resumable task, submitting fresh (attempt ${attemptNumber})`)
    }

    try {
      if (!jobRef) {
        await upsertVisualAsset(client, {
          contentPipelineId: pipeline.id,
          generation,
          assetType: 'character_ref',
          status: 'generating',
          attemptNumber,
        })

        console.log(`[${stepName}] NEW SUBMISSION (attempt ${attemptNumber})`)
        jobRef = await imageGenerator.submit({ prompt, referenceImageUrl, aspectRatio })

        // Persist the task id BEFORE polling — this is the fix. Previously
        // this row only ever recorded providerRef on the FINAL, successful
        // upsert below, so an interruption anywhere during the poll below
        // lost the task id forever, making a resume (above) impossible and
        // forcing every retry into a brand-new paid submission.
        await upsertVisualAsset(client, {
          contentPipelineId: pipeline.id,
          generation,
          assetType: 'character_ref',
          status: 'generating',
          providerRef: jobRef.providerRef,
          attemptNumber,
        })
      }

      const outcome = await pollUntilDone(client, pipeline.id, imageGenerator, jobRef)

      if ('cancelled' in outcome) {
        console.log(`[${stepName}] cancelled mid-poll — leaving task ${jobRef.providerRef} resumable, not recording a failure`)
        return { ran: true }
      }

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
      // No providerRef passed here — this attempt's task (whether just
      // submitted or resumed above) is now CONFIRMED done-for (explicit
      // failure, 404, or timeout), so upsertVisualAsset defaults
      // provider_ref back to null. That's deliberate: the next attempt (if
      // any) legitimately needs a fresh, paid submission — there is nothing
      // left to resume.
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
