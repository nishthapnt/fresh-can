import type { SupabaseClient } from '@supabase/supabase-js'
import type { ScriptGenerator } from '../../adapters/types.js'
import {
  claimTrack,
  hasSucceededStep,
  getLastSucceededStepOutput,
  recordStepAttempt,
  recordTrackRetryableFailure,
  markTrackFailed,
  type TrackRow,
} from '../../db.js'
import { hasExceededMaxAttempts, isReadyToRetry, MAX_ATTEMPTS } from '../../lib/backoff.js'
import { BRAND_PROFILE, composeCaptionSystemPrompt, type ImageStyle } from '../../prompts/index.js'
import { parseAdCopy } from '../../lib/adCopy.js'

export interface CaptionJobInput {
  topic: string
  category: string
  /** e.g. "Lunenburg, Nova Scotia" — omit/empty for auto-rotation jobs with no manual location. */
  location?: string
  /** Resolved text of the job's selected content_angle, or undefined —
   *  spliced into the caption prompt regardless of imageStyle. */
  angleBrief?: string
  /**
   * Set (along with pipelineGeneration) only for 'infographic'-style jobs.
   * When set, this step gates on the pipeline's shared generate_ad_copy step
   * having succeeded first, and folds its headline/subtitle into the
   * caption prompt so the caption stays cohesive with the image's on-image
   * text. Omit (or 'photo') for the original, ungated behavior — captions
   * for 'photo'-style jobs have nothing shared to wait on.
   */
  imageStyle?: ImageStyle
  pipelineGeneration?: number
}

/**
 * Per-language-track step for image_post. For 'photo'-style jobs (the
 * default), this has nothing to wait on — image_post has no shared text
 * step — so it claims and runs the moment the track exists, concurrently
 * with generate_photo, exactly as before: alt text stays generic
 * (topic/category derived) rather than photo-specific, trading a small
 * amount of accuracy for simpler retries and no cross-step dependency
 * (mirrors how Blog's copy doesn't wait on its images either).
 *
 * For 'infographic'-style jobs, this now DOES have something to wait on:
 * the shared generate_ad_copy step (see generateAdCopy.ts), so the caption
 * can read its headline/subtitle and stay cohesive with the text already
 * baked onto the image, instead of being an independent, unrelated guess at
 * the same topic.
 */
export async function runGenerateCaption(
  client: SupabaseClient,
  track: TrackRow,
  input: CaptionJobInput,
  scriptGenerator: ScriptGenerator,
  backoffBaseDelayMs = 5000,
): Promise<{ ran: boolean }> {
  if (input.imageStyle === 'infographic') {
    if (input.pipelineGeneration === undefined) {
      throw new Error('runGenerateCaption: pipelineGeneration is required when imageStyle is "infographic"')
    }
    const adCopyReady = await hasSucceededStep(
      client,
      { contentPipelineId: track.content_pipeline_id },
      'generate_ad_copy',
      input.pipelineGeneration,
    )
    if (!adCopyReady) return { ran: false } // wait for the shared headline/subtitle so the caption can echo it
  }

  let working: TrackRow

  if (track.status === 'waiting_on_shared') {
    const claimed = await claimTrack(client, track.id, 'waiting_on_shared', 'generating')
    if (!claimed) return { ran: false } // lost the race to another worker
    working = claimed
  } else if (track.status === 'generating') {
    if (!track.last_error) return { ran: false } // no error recorded — already in flight, not our turn
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
  } else {
    return { ran: false } // wrong state entirely for this step
  }

  const generation = track.master_generation_used
  const alreadySucceeded = await hasSucceededStep(
    client,
    { contentLanguageTrackId: track.id },
    'generate_caption',
    generation,
  )
  if (alreadySucceeded) return { ran: true }

  // adCopyReady was already confirmed true above when imageStyle is
  // 'infographic', so this read always finds a real, model-authored
  // headline/subtitle — the fallbacks here are just defensive, not expected
  // to ever actually trigger.
  let adCopy: { headline: string; subtitle: string; coreMessage: string } | null = null
  if (input.imageStyle === 'infographic' && input.pipelineGeneration !== undefined) {
    const adCopyOutput = await getLastSucceededStepOutput(
      client,
      { contentPipelineId: track.content_pipeline_id },
      'generate_ad_copy',
      input.pipelineGeneration,
    )
    adCopy = parseAdCopy(adCopyOutput, input.topic, input.category)
  }

  const attemptNumber = working.retry_count + 1
  try {
    const result = await scriptGenerator.generate({
      systemPrompt: composeCaptionSystemPrompt(BRAND_PROFILE, {
        language: track.language,
        location: input.location,
        angleBrief: input.angleBrief,
        imageHeadline: adCopy?.headline,
        imageSubtitle: adCopy?.subtitle,
        imageCoreMessage: adCopy?.coreMessage,
      }),
      userPrompt: `Topic: ${input.topic}\nCategory: ${input.category}`,
    })
    await recordStepAttempt(client, {
      contentLanguageTrackId: track.id,
      stepName: 'generate_caption',
      generation,
      attemptNumber,
      status: 'succeeded',
      provider: 'openai',
      outputSnapshot: result.parsed ?? { raw: result.raw },
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await recordStepAttempt(client, {
      contentLanguageTrackId: track.id,
      stepName: 'generate_caption',
      generation,
      attemptNumber,
      status: 'failed_retryable',
      provider: 'openai',
      errorMessage: message,
    })
    if (hasExceededMaxAttempts(attemptNumber, MAX_ATTEMPTS.openai)) {
      await markTrackFailed(client, track.id, message)
    } else {
      await recordTrackRetryableFailure(client, track.id, attemptNumber, message)
    }
  }

  return { ran: true }
}
