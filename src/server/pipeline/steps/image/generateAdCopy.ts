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
import { BRAND_PROFILE, composeAdCopySystemPrompt } from '../../prompts/index'

export interface AdCopyJobInput {
  topic: string
  category: string
  /** Resolved text of the job's selected content_angle, or undefined. */
  angleBrief?: string
  /** The same assembled scene text used to build the shared photo (image.ts's
   *  photoScene()) — folded into the prompt so the on-image headline/
   *  subtitle stay cohesive with the photo's actual scene. */
  scene?: string
}

/**
 * Shared, pipeline-scoped step for image_post pipelines with
 * image_style: 'infographic' ONLY (see tickPipelines in index.ts — 'photo'
 * style pipelines skip this entirely and go created -> generating exactly
 * as before). Mirrors generateOutline.ts's created -> drafting ->
 * generating transition exactly, so the headline/subtitle rendered directly
 * onto the photo comes from a real, idempotent LLM call instead of a crude
 * topic-truncation fallback — and so generate_caption (per-language) has a
 * durable, already-succeeded place to read the same headline/subtitle from,
 * to keep every language's caption cohesive with the image's on-image text.
 */
export async function runGenerateAdCopy(
  client: SupabaseClient,
  pipeline: PipelineRow,
  input: AdCopyJobInput,
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
    'generate_ad_copy',
    generation,
  )

  if (!alreadySucceeded) {
    const attemptNumber = working.retry_count + 1
    try {
      const result = await scriptGenerator.generate({
        systemPrompt: composeAdCopySystemPrompt(BRAND_PROFILE, {
          category: input.category,
          angleBrief: input.angleBrief,
          scene: input.scene,
        }),
        userPrompt: `Topic: ${input.topic}\nCategory: ${input.category}`,
      })
      await recordStepAttempt(client, {
        contentPipelineId: pipeline.id,
        stepName: 'generate_ad_copy',
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
        stepName: 'generate_ad_copy',
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

  // Advance to shared-photo generation regardless of whether this call did
  // the work or found it already done (resumed worker case) — mirrors
  // generateOutline.ts.
  await claimPipeline(client, pipeline.id, 'drafting', 'generating')
  return { ran: true }
}
