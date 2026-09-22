import type { SupabaseClient } from '@supabase/supabase-js'
import type { ScriptGenerator } from '../../adapters/types'
import { hasSucceededStep, getLastSucceededStepOutput, recordStepAttempt } from '../../db'
import { composeReferenceCopySystemPrompt } from '../../prompts/index'
import type { BrandProfile } from '../../prompts/types'

export interface OutlineSection {
  heading: string
  summary: string
}

export interface ReferenceCopyInput {
  title: string
  sections: OutlineSection[]
}

export interface ReferenceCopyOutput {
  coreMessage: string
  inlineHighlight: { heading: string; visualMoment: string }
}

/** Derives a safe reference copy directly from the outline's own data, with
 *  no LLM call — used both as the fallback when generation fails, and as
 *  the whole answer for a pre-existing job with no sections to expand.
 *  Never blocks the pipeline: this is exactly today's behavior (images
 *  grounded only in the outline's own headline/summary), so falling back to
 *  it is a no-regression floor, not a degraded state. */
/** Exported for unit testing — see generateReferenceCopy.test.ts. */
export function deriveFromOutline(input: ReferenceCopyInput): ReferenceCopyOutput {
  const first = input.sections[0]
  return {
    coreMessage: input.title,
    inlineHighlight: first
      ? { heading: first.heading, visualMoment: first.summary }
      : { heading: '', visualMoment: '' },
  }
}

/** Exported for unit testing — see generateReferenceCopy.test.ts. */
export function normalizeReferenceCopyOutput(parsed: unknown, input: ReferenceCopyInput): ReferenceCopyOutput | null {
  if (!parsed || typeof parsed !== 'object') return null
  const p = parsed as Record<string, unknown>
  if (typeof p.coreMessage !== 'string' || p.coreMessage.trim() === '') return null
  const highlight = p.inlineHighlight
  if (!highlight || typeof highlight !== 'object') return null
  const h = highlight as Record<string, unknown>
  if (typeof h.heading !== 'string' || typeof h.visualMoment !== 'string') return null
  // The heading must actually match one of the real outline sections —
  // otherwise composeBlogImage would have nothing genuine to point the
  // inline image at.
  const matchedSection = input.sections.find((s) => s.heading === h.heading)
  if (!matchedSection) return null
  return { coreMessage: p.coreMessage, inlineHighlight: { heading: h.heading, visualMoment: h.visualMoment } }
}

/**
 * Layer 2 addition (PROMPT_REFACTOR_BRIEF.md §9.3) — the shared pass
 * between the outline and hero/inline image generation. Same lightweight
 * idempotency pattern as steps/shared/interpretIntent.ts and
 * steps/image/planImage.ts: no claim, no backoff loop, since this doesn't
 * gate any pipeline status transition — blog.ts's existing
 * created/drafting/generating machinery is completely unchanged by this
 * step's existence. A failed or malformed response falls back to
 * deriveFromOutline (today's exact behavior) rather than blocking the
 * pipeline — this step is meant to improve the images, never become a new
 * way for a blog job to fail.
 */
export async function generateReferenceCopy(
  client: SupabaseClient,
  scope: { contentPipelineId: string },
  generation: number,
  scriptGenerator: ScriptGenerator,
  brand: BrandProfile,
  input: ReferenceCopyInput,
): Promise<ReferenceCopyOutput> {
  if (input.sections.length === 0) {
    // A pre-existing job whose outline predates the parseable sections
    // schema (or a genuinely section-less outline) — nothing to expand.
    return deriveFromOutline(input)
  }

  const alreadySucceeded = await hasSucceededStep(client, scope, 'generate_reference_copy', generation)
  if (alreadySucceeded) {
    const cached = await getLastSucceededStepOutput(client, scope, 'generate_reference_copy', generation)
    const normalized = normalizeReferenceCopyOutput(cached, input)
    if (normalized) return normalized
    // Cached row doesn't parse against THIS input — shouldn't happen since
    // the outline is fixed per generation, but regenerate rather than trust
    // a stale mismatch blindly.
  }

  try {
    const result = await scriptGenerator.generate({
      systemPrompt: composeReferenceCopySystemPrompt(brand, { title: input.title, sections: input.sections }),
      userPrompt: `Title: ${input.title}\nSections: ${input.sections.map((s) => s.heading).join(', ')}`,
      stepName: 'generate_reference_copy',
    })
    const output = normalizeReferenceCopyOutput(result.parsed, input)
    if (!output) {
      await recordStepAttempt(client, {
        ...scope,
        stepName: 'generate_reference_copy',
        generation,
        attemptNumber: 1,
        status: 'failed_retryable',
        provider: 'openai',
        errorMessage: 'Malformed JSON, or inlineHighlight.heading did not match a real outline section',
      })
      return deriveFromOutline(input)
    }
    await recordStepAttempt(client, {
      ...scope,
      stepName: 'generate_reference_copy',
      generation,
      attemptNumber: 1,
      status: 'succeeded',
      provider: 'openai',
      outputSnapshot: output,
    })
    return output
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await recordStepAttempt(client, {
      ...scope,
      stepName: 'generate_reference_copy',
      generation,
      attemptNumber: 1,
      status: 'failed_retryable',
      provider: 'openai',
      errorMessage: message,
    })
    return deriveFromOutline(input)
  }
}
