import type { SupabaseClient } from '@supabase/supabase-js'
import type { ScriptGenerator } from '../../adapters/types'
import { hasSucceededStep, getLastSucceededStepOutput, recordStepAttempt } from '../../db'
import { composeIntentSystemPrompt } from '../../prompts/index'
import type { BrandProfile, CreativeBrief } from '../../prompts/types'

export interface IntentInterpretationInput {
  contentType: 'video' | 'image_post' | 'blog'
  topic: string
  category: string
  targetAudience: string
  /** The dashboard's "Your Scene Idea" field — the admin's raw idea this
   *  step interprets. Optional/nullable for a pre-existing job created
   *  before the field became required. */
  sceneNotes?: string | null
}

/** Returned when interpretation fails or returns malformed JSON — a
 *  neutral, unhelpful-but-safe brief rather than a thrown error. This step
 *  is meant to IMPROVE generation (Phase 3 onward), not become a new single
 *  point of failure for a pipeline that worked fine without it before. */
const NEUTRAL_FALLBACK_BRIEF: CreativeBrief = {
  intent: '',
  coreMessage: '',
  audience: '',
  emotionalTone: '',
  desiredResponse: '',
  unitRelevance: {
    value: 'none',
    rationale: 'Fallback: intent interpretation failed or returned malformed JSON.',
  },
  improvements: '',
  constraintsFromAdmin: '',
}

const UNIT_RELEVANCE_VALUES = new Set(['central', 'incidental', 'none'])

/** Exported for unit testing — see interpretIntent.test.ts. */
export function normalizeCreativeBrief(parsed: unknown): CreativeBrief | null {
  if (!parsed || typeof parsed !== 'object') return null
  const p = parsed as Record<string, unknown>

  const unitRelevanceRaw = p.unitRelevance
  if (!unitRelevanceRaw || typeof unitRelevanceRaw !== 'object') return null
  const ur = unitRelevanceRaw as Record<string, unknown>
  if (typeof ur.value !== 'string' || !UNIT_RELEVANCE_VALUES.has(ur.value) || typeof ur.rationale !== 'string') {
    return null
  }

  const requiredStrings = [
    'intent',
    'coreMessage',
    'audience',
    'emotionalTone',
    'desiredResponse',
    'improvements',
    'constraintsFromAdmin',
  ] as const
  for (const field of requiredStrings) {
    if (typeof p[field] !== 'string') return null
  }

  return {
    intent: p.intent as string,
    coreMessage: p.coreMessage as string,
    audience: p.audience as string,
    emotionalTone: p.emotionalTone as string,
    desiredResponse: p.desiredResponse as string,
    unitRelevance: { value: ur.value as CreativeBrief['unitRelevance']['value'], rationale: ur.rationale },
    improvements: p.improvements as string,
    constraintsFromAdmin: p.constraintsFromAdmin as string,
  }
}

/**
 * Layer 1 (PROMPT_REFACTOR_BRIEF.md §4.2) — turns the admin's raw idea into
 * a structured creative brief, shared by all three content types. Callers
 * wrap this in their own `step.run()` for Inngest-level replay safety;
 * idempotency/audit beyond that comes from the same `pipeline_steps` ledger
 * every other step uses (`hasSucceededStep`/`recordStepAttempt`), but
 * deliberately WITHOUT generate_outline/generate_script's claim/backoff-loop
 * machinery — that exists to gate `content_pipelines.status` across
 * multiple retry attempts, which this single non-polling OpenAI call has no
 * need for.
 *
 * Not yet consumed by any composer (this is Phase 2 of
 * PROMPT_REFACTOR_BRIEF.md's refactor) — the output is generated and logged
 * to `pipeline_steps.output_snapshot` for inspection now, ready for Phase 3
 * to wire into the planning steps (blog outline, video script, image plan).
 */
export async function interpretIntent(
  client: SupabaseClient,
  scope: { contentPipelineId: string },
  generation: number,
  scriptGenerator: ScriptGenerator,
  brand: BrandProfile,
  input: IntentInterpretationInput,
): Promise<CreativeBrief> {
  const alreadySucceeded = await hasSucceededStep(client, scope, 'interpret_intent', generation)
  if (alreadySucceeded) {
    const cached = await getLastSucceededStepOutput(client, scope, 'interpret_intent', generation)
    const normalized = normalizeCreativeBrief(cached)
    if (normalized) return normalized
    // Cached row exists but doesn't parse as a CreativeBrief — shouldn't
    // happen (only ever written by this same function) — fall through and
    // regenerate rather than trust it blindly.
  }

  try {
    const result = await scriptGenerator.generate({
      systemPrompt: composeIntentSystemPrompt(brand, input.contentType),
      userPrompt:
        `Topic: ${input.topic}\nCategory: ${input.category}\nAudience: ${input.targetAudience}` +
        (input.sceneNotes ? `\nAdmin's own idea: ${input.sceneNotes}` : ''),
      stepName: 'interpret_intent',
    })
    const brief = normalizeCreativeBrief(result.parsed)
    if (!brief) {
      await recordStepAttempt(client, {
        ...scope,
        stepName: 'interpret_intent',
        generation,
        attemptNumber: 1,
        status: 'failed_retryable',
        provider: 'openai',
        errorMessage: 'Malformed or incomplete JSON from intent interpretation',
      })
      return NEUTRAL_FALLBACK_BRIEF
    }
    await recordStepAttempt(client, {
      ...scope,
      stepName: 'interpret_intent',
      generation,
      attemptNumber: 1,
      status: 'succeeded',
      provider: 'openai',
      outputSnapshot: brief,
    })
    return brief
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await recordStepAttempt(client, {
      ...scope,
      stepName: 'interpret_intent',
      generation,
      attemptNumber: 1,
      status: 'failed_retryable',
      provider: 'openai',
      errorMessage: message,
    })
    return NEUTRAL_FALLBACK_BRIEF
  }
}
