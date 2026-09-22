import type { SupabaseClient } from '@supabase/supabase-js'
import type { ScriptGenerator } from '../../adapters/types'
import {
  claimPipeline,
  hasSucceededStep,
  recordStepAttempt,
  recordPipelineRetryableFailure,
  markPipelineFailed,
  type PipelineRow,
} from '../../db'
import { hasExceededMaxAttempts, isReadyToRetry, MAX_ATTEMPTS } from '../../lib/backoff'
import { BRAND_PROFILE, composeOutlineSystemPrompt } from '../../prompts/index'

export interface OutlineJobInput {
  topic: string
  category: string
  targetAudience: string
  /** The dashboard's optional "Your Scene Idea" field (content_jobs.
   *  scene_notes) — previously only threaded into image_post's photo
   *  prompt; see composeOutlineSystemPrompt for how it's used here. */
  sceneNotes?: string | null
}

/**
 * Shared, pipeline-scoped step — runs exactly once per pipeline generation
 * regardless of how many languages were requested. Transitions:
 * created -> drafting (claimed here) -> generating (on success, meaning
 * "generating shared visuals" next).
 *
 * Handles two distinct cases, not just the fresh-claim one: a pipeline in
 * 'created' is claimed via CAS as before; a pipeline already in 'drafting'
 * with a recorded last_error is a RETRY of a previously failed attempt —
 * status alone can't distinguish "another worker has this in flight right
 * now" from "a prior attempt failed and this is eligible for retry", so the
 * backoff window (isReadyToRetry) is what gates re-attempting it, not a
 * second claim.
 */
export async function runGenerateOutline(
  client: SupabaseClient,
  pipeline: PipelineRow,
  input: OutlineJobInput,
  scriptGenerator: ScriptGenerator,
  backoffBaseDelayMs = 5000,
): Promise<{ ran: boolean }> {
  let working: PipelineRow

  if (pipeline.status === 'created') {
    const claimed = await claimPipeline(client, pipeline.id, 'created', 'drafting')
    if (!claimed) return { ran: false } // lost the race to another worker
    working = claimed
  } else if (pipeline.status === 'drafting') {
    if (!pipeline.last_error) return { ran: false } // no error recorded — already in flight, not our turn
    if (
      !isReadyToRetry({
        lastError: pipeline.last_error,
        retryCount: pipeline.retry_count,
        updatedAt: new Date(pipeline.updated_at),
        baseDelayMs: backoffBaseDelayMs,
      })
    ) {
      return { ran: false } // backoff window hasn't elapsed yet
    }
    working = pipeline
  } else {
    return { ran: false } // wrong state entirely for this step
  }

  const generation = working.current_generation
  const alreadySucceeded = await hasSucceededStep(
    client,
    { contentPipelineId: pipeline.id },
    'generate_outline',
    generation,
  )

  if (!alreadySucceeded) {
    const attemptNumber = working.retry_count + 1
    try {
      const result = await scriptGenerator.generate({
        systemPrompt: composeOutlineSystemPrompt(BRAND_PROFILE, input.category, input.sceneNotes),
        userPrompt: `Topic: ${input.topic}\nCategory: ${input.category}\nAudience: ${input.targetAudience}`,
      })
      await recordStepAttempt(client, {
        contentPipelineId: pipeline.id,
        stepName: 'generate_outline',
        generation,
        attemptNumber,
        status: 'succeeded',
        provider: 'openai',
        outputSnapshot: result.parsed ?? { raw: result.raw },
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      await recordStepAttempt(client, {
        contentPipelineId: pipeline.id,
        stepName: 'generate_outline',
        generation,
        attemptNumber,
        status: 'failed_retryable',
        provider: 'openai',
        errorMessage: message,
      })
      if (hasExceededMaxAttempts(attemptNumber, MAX_ATTEMPTS.openai)) {
        await markPipelineFailed(client, pipeline.id, message)
      } else {
        await recordPipelineRetryableFailure(client, pipeline.id, attemptNumber, message)
      }
      return { ran: true }
    }
  }

  // Advance to shared-visual generation regardless of whether this call did
  // the work or found it already done (resumed worker case).
  await claimPipeline(client, pipeline.id, 'drafting', 'generating')
  return { ran: true }
}
