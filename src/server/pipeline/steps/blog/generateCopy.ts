import type { SupabaseClient } from '@supabase/supabase-js'
import type { ScriptGenerator } from '../../adapters/types'
import {
  claimTrack,
  hasSucceededStep,
  getLastSucceededStepOutput,
  recordStepAttempt,
  recordTrackRetryableFailure,
  markTrackFailed,
  type TrackRow,
} from '../../db'
import { hasExceededMaxAttempts, isReadyToRetry, MAX_ATTEMPTS } from '../../lib/backoff'
import { BRAND_PROFILE, composeCopySystemPrompt } from '../../prompts/index'

export interface CopyJobInput {
  topic: string
  category: string
  /** The dashboard's optional "Your Scene Idea" field (content_jobs.
   *  scene_notes) — previously only threaded into image_post's photo
   *  prompt; see composeCopySystemPrompt for how it's used here. */
  sceneNotes?: string | null
}

/**
 * composeCopySystemPrompt's schema asks for "has_inline_image": true on
 * exactly one section — a soft instruction, not a validated constraint.
 * Confirmed live (2026-09-17): the model sometimes leaves every section
 * false, which silently drops the inline image from the rendered post even
 * though it was generated (and paid for) — finalizeDraft.ts's draft_data
 * still gets a valid images.inline.url, but generateBlogHTML's per-section
 * `if (sec.has_inline_image && ...)` check never fires for any section.
 * Self-heals here, at the source, so the corrected flag is what actually
 * gets persisted to pipeline_steps and read by every later consumer
 * (finalizeDraft.ts, a resumed worker, a regen) — rather than patching it
 * again downstream every place this output gets read.
 */
export function ensureExactlyOneInlineImageSection(parsed: unknown): unknown {
  if (!parsed || typeof parsed !== 'object') return parsed
  const content = (parsed as Record<string, unknown>).content
  if (!content || typeof content !== 'object') return parsed
  const sections = (content as Record<string, unknown>).sections
  if (!Array.isArray(sections) || sections.length === 0) return parsed

  const flaggedCount = sections.filter(
    (s) => s && typeof s === 'object' && (s as Record<string, unknown>).has_inline_image === true,
  ).length
  if (flaggedCount === 1) return parsed // already correct — nothing to do

  // 0 flagged (model dropped it entirely) or >1 (model flagged more than
  // one) — pick the middle section as a reasonable structural default
  // (roughly midway through the article, matching the prompt's own "best
  // fit for a supporting photo" intent) and force every other section false.
  const fallbackIndex = Math.floor(sections.length / 2)
  const correctedSections = sections.map((s, i) => ({
    ...(s && typeof s === 'object' ? s : {}),
    has_inline_image: i === fallbackIndex,
  }))

  return {
    ...parsed,
    content: { ...content, sections: correctedSections },
  }
}

/**
 * Per-language-track step — gated ONLY on generate_outline having succeeded,
 * not on the shared visuals (copy text doesn't need image URLs — only
 * finalize_draft does). Leaves the track in 'generating' on success;
 * finalize_draft is the separate step that advances it to draft_ready once
 * both this AND the shared visuals are ready.
 *
 * Same fresh-claim-vs-retry distinction as generateOutline.ts: a track
 * already in 'generating' with a recorded last_error is a retry, gated by
 * the backoff window (isReadyToRetry) — not a second claim, which would
 * always fail once the first claim has happened and silently strand the
 * track without ever advancing retry_count or reaching failed_terminal.
 */
export async function runGenerateCopy(
  client: SupabaseClient,
  track: TrackRow,
  outlinePipelineId: string,
  outlineGeneration: number,
  input: CopyJobInput,
  scriptGenerator: ScriptGenerator,
  backoffBaseDelayMs = 5000,
): Promise<{ ran: boolean }> {
  const outlineReady = await hasSucceededStep(
    client,
    { contentPipelineId: outlinePipelineId },
    'generate_outline',
    outlineGeneration,
  )
  if (!outlineReady) return { ran: false } // not our turn yet

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
    'generate_copy',
    generation,
  )
  if (alreadySucceeded) return { ran: true }

  const outline = await getLastSucceededStepOutput(
    client,
    { contentPipelineId: outlinePipelineId },
    'generate_outline',
    outlineGeneration,
  )

  const attemptNumber = working.retry_count + 1
  try {
    const result = await scriptGenerator.generate({
      // Schema (post_title/content/seo field names) MUST match
      // blogEditFromDraft() in src/app/dashboard/jobs/[job_id]/page.tsx
      // exactly — that parser drops any field it doesn't recognize instead
      // of erroring, so an under-specified schema here doesn't fail loudly,
      // it silently loses content (confirmed live: gpt-4o-mini wrote real
      // per-section body text under "summary" instead of "paragraphs", and
      // a plain string for "cta" instead of an object, and every section
      // rendered heading-only as a result). See composeCopySystemPrompt for
      // the exact schema text — kept there, not duplicated here.
      systemPrompt: composeCopySystemPrompt(BRAND_PROFILE, {
        language: track.language,
        category: input.category,
        sceneNotes: input.sceneNotes,
        regenInstructions: track.regen_instructions,
      }),
      userPrompt: `Topic: ${input.topic}\nCategory: ${input.category}\nOutline: ${JSON.stringify(outline)}`,
      stepName: 'generate_copy',
    })
    const outputSnapshot = result.parsed ? ensureExactlyOneInlineImageSection(result.parsed) : { raw: result.raw }
    await recordStepAttempt(client, {
      contentLanguageTrackId: track.id,
      stepName: 'generate_copy',
      generation,
      attemptNumber,
      status: 'succeeded',
      provider: 'openai',
      outputSnapshot,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await recordStepAttempt(client, {
      contentLanguageTrackId: track.id,
      stepName: 'generate_copy',
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
