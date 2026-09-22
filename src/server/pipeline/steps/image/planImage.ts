import type { SupabaseClient } from '@supabase/supabase-js'
import type { ScriptGenerator } from '../../adapters/types'
import { hasSucceededStep, getLastSucceededStepOutput, recordStepAttempt } from '../../db'
import { composeImagePlanSystemPrompt } from '../../prompts/index'
import type { BrandProfile, CreativeBrief, ImagePostPlan, ImageStyle } from '../../prompts/types'

export interface PlanImageInput {
  imageStyle: ImageStyle
  /** The same assembled scene text composePhotoPrompt is built around — see
   *  image.ts's photoScene(). */
  scene: string
  creativeBrief?: CreativeBrief
}

/** Returned when planning fails or returns malformed JSON — a minimal,
 *  safe plan (no unit, no on-image text) rather than a thrown error. Same
 *  fail-open philosophy as interpretIntent.ts's NEUTRAL_FALLBACK_BRIEF: this
 *  step is meant to improve generation, not become a new single point of
 *  failure for a pipeline that worked fine without it before Phase 3. */
function neutralFallbackPlan(imageStyle: ImageStyle, headline?: string, subtitle?: string): ImagePostPlan {
  return {
    designIntent: '',
    subject: '',
    composition: '',
    unitPresence: 'none',
    unitPresenceRationale: 'Fallback: image planning failed or returned malformed JSON.',
    setting: 'unrelated',
    containsFood: false,
    textPlan: imageStyle === 'infographic' && headline && subtitle ? { headline, subtitle } : null,
    safeZone: 'top-right',
  }
}

const UNIT_PRESENCE_VALUES = new Set(['none', 'background', 'featured'])
const SETTING_VALUES = new Set(['exterior', 'interior', 'unrelated'])

/** Exported for unit testing — see planImage.test.ts. */
export function normalizeImagePostPlan(parsed: unknown): ImagePostPlan | null {
  if (!parsed || typeof parsed !== 'object') return null
  const p = parsed as Record<string, unknown>

  if (
    typeof p.designIntent !== 'string' ||
    typeof p.subject !== 'string' ||
    typeof p.composition !== 'string' ||
    typeof p.unitPresence !== 'string' ||
    !UNIT_PRESENCE_VALUES.has(p.unitPresence) ||
    typeof p.unitPresenceRationale !== 'string' ||
    p.unitPresenceRationale.trim() === '' ||
    typeof p.setting !== 'string' ||
    !SETTING_VALUES.has(p.setting) ||
    typeof p.containsFood !== 'boolean'
  ) {
    return null
  }

  let textPlan: ImagePostPlan['textPlan'] = null
  if (p.textPlan && typeof p.textPlan === 'object') {
    const tp = p.textPlan as Record<string, unknown>
    if (typeof tp.headline === 'string' && typeof tp.subtitle === 'string') {
      textPlan = { headline: tp.headline, subtitle: tp.subtitle }
    }
  }

  return {
    designIntent: p.designIntent,
    subject: p.subject,
    composition: p.composition,
    unitPresence: p.unitPresence as ImagePostPlan['unitPresence'],
    unitPresenceRationale: p.unitPresenceRationale,
    setting: p.setting as ImagePostPlan['setting'],
    containsFood: p.containsFood,
    castDescription: typeof p.castDescription === 'string' && p.castDescription !== '' ? p.castDescription : undefined,
    textPlan,
    safeZone: 'top-right',
  }
}

/**
 * Layer 2 (PROMPT_REFACTOR_BRIEF.md §4.3) — image_post's plan. image_post
 * had no planning step of its own before Phase 3; this runs for both
 * 'photo' and 'infographic' styles (previously only infographic got any
 * planning pass at all, via generate_ad_copy). Same lightweight idempotency
 * pattern as steps/shared/interpretIntent.ts — the pipeline_steps ledger for
 * audit, no claim/backoff-loop machinery, since this doesn't need to gate
 * content_pipelines.status itself (image.ts's existing ad-copy/photo
 * generation flow still owns that, unchanged).
 *
 * Not yet consumed by composePhotoPrompt/composeAdCopySystemPrompt (Phase 4
 * wires it in) — generated and logged now.
 */
export async function planImage(
  client: SupabaseClient,
  scope: { contentPipelineId: string },
  generation: number,
  scriptGenerator: ScriptGenerator,
  brand: BrandProfile,
  input: PlanImageInput,
): Promise<ImagePostPlan> {
  const alreadySucceeded = await hasSucceededStep(client, scope, 'plan_image', generation)
  if (alreadySucceeded) {
    const cached = await getLastSucceededStepOutput(client, scope, 'plan_image', generation)
    const normalized = normalizeImagePostPlan(cached)
    if (normalized) return normalized
    // Cached row exists but doesn't parse — shouldn't happen (only ever
    // written by this same function) — fall through and regenerate.
  }

  try {
    const result = await scriptGenerator.generate({
      systemPrompt: composeImagePlanSystemPrompt(brand, { imageStyle: input.imageStyle, scene: input.scene }, input.creativeBrief),
      userPrompt: `Scene: ${input.scene}\nImage style: ${input.imageStyle}`,
      stepName: 'plan_image',
    })
    const plan = normalizeImagePostPlan(result.parsed)
    if (!plan) {
      await recordStepAttempt(client, {
        ...scope,
        stepName: 'plan_image',
        generation,
        attemptNumber: 1,
        status: 'failed_retryable',
        provider: 'openai',
        errorMessage: 'Malformed or incomplete JSON from image planning',
      })
      return neutralFallbackPlan(input.imageStyle)
    }
    await recordStepAttempt(client, {
      ...scope,
      stepName: 'plan_image',
      generation,
      attemptNumber: 1,
      status: 'succeeded',
      provider: 'openai',
      outputSnapshot: plan,
    })
    return plan
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await recordStepAttempt(client, {
      ...scope,
      stepName: 'plan_image',
      generation,
      attemptNumber: 1,
      status: 'failed_retryable',
      provider: 'openai',
      errorMessage: message,
    })
    return neutralFallbackPlan(input.imageStyle)
  }
}
