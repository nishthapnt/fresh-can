import type { SupabaseClient } from '@supabase/supabase-js'
import {
  claimTrack,
  hasSucceededStep,
  getLastSucceededStepOutput,
  getVisualAssets,
  upsertBlogDraft,
  recordStepAttempt,
  markJobDraftReadyIfPending,
  type TrackRow,
  type PipelineRow,
} from '../../db'

/**
 * Per-language-track step — the only step gated on BOTH this track's copy
 * AND the pipeline's shared visuals being ready. Assembles draft_data in the
 * exact shape src/app/dashboard/jobs/[job_id]/page.tsx's blogEditFromDraft
 * already expects (post_title/post_slug/content{...}/seo/images{hero,inline})
 * so the existing BlogTabContent editor needs no changes (M5).
 *
 * KNOWN GAP: image alt text is left blank here — the KIE.ai adapter's
 * ImageGenerator interface doesn't produce alt text (it only returns a
 * fileUrl), unlike the current n8n workflow, which does generate real alt
 * text (confirmed in a live sample row during the schema audit). Flagging
 * this rather than silently shipping blank alt attributes; a follow-up
 * would extend the image generation step (or a small dedicated call) to
 * produce it.
 */
export async function runFinalizeDraft(
  client: SupabaseClient,
  pipeline: PipelineRow,
  track: TrackRow,
  jobId: string,
): Promise<{ ran: boolean }> {
  if (pipeline.status !== 'ready') return { ran: false } // shared visuals not ready yet

  const generation = track.master_generation_used
  const copyReady = await hasSucceededStep(
    client,
    { contentLanguageTrackId: track.id },
    'generate_copy',
    generation,
  )
  if (!copyReady) return { ran: false }

  const alreadyDone = await hasSucceededStep(
    client,
    { contentLanguageTrackId: track.id },
    'finalize_draft',
    generation,
  )
  if (alreadyDone) return { ran: true }

  const copyOutput = (await getLastSucceededStepOutput(
    client,
    { contentLanguageTrackId: track.id },
    'generate_copy',
    generation,
  )) as Record<string, unknown> | null

  const visualAssets = await getVisualAssets(client, pipeline.id, pipeline.current_generation)
  const hero = visualAssets.find((a) => a.asset_type === 'hero_image')
  const inline = visualAssets.find((a) => a.asset_type === 'inline_image')

  const draftData = {
    ...(copyOutput ?? {}),
    generated_at: new Date().toISOString(),
    images: {
      hero: { url: hero?.file_url ?? '', alt: '' },
      inline: { url: inline?.file_url ?? '', alt: '' },
    },
  }

  await upsertBlogDraft(client, {
    jobId,
    language: track.language,
    contentLanguageTrackId: track.id,
    draftData,
  })

  // Re-check right before the (non-idempotent) attempt-log insert below —
  // unlike upsertBlogDraft (a natural-key upsert, safe to race),
  // recordStepAttempt is a plain insert with no dedup, so two overlapping
  // invocations of this function (only possible across two worker
  // PROCESSES, e.g. an accidental double-start — a single process's tick
  // loop only calls this once per track per tick) could otherwise both
  // insert a 'finalize_draft' success row. This doesn't eliminate the race
  // (there's still a gap between this check and the insert), but narrows it
  // from "the whole function" to "this one query" — same risk-reduction
  // pattern generateVisualImage.ts's own "stray late re-invocation" defense
  // uses, chosen over adding a new claimed/exclusive DB status (which would
  // need a migration) since nothing here is corrupted by a rare duplicate
  // log row, only the attempt count.
  const stillNotDone = !(await hasSucceededStep(
    client,
    { contentLanguageTrackId: track.id },
    'finalize_draft',
    generation,
  ))
  if (stillNotDone) {
    await recordStepAttempt(client, {
      contentLanguageTrackId: track.id,
      stepName: 'finalize_draft',
      generation,
      attemptNumber: 1,
      status: 'succeeded',
      outputSnapshot: { draftWritten: true },
    })
  }

  const claimed = await claimTrack(client, track.id, 'generating', 'draft_ready')
  if (!claimed) {
    // Another process already moved this track past 'generating' (most
    // likely the same overlapping-invocation scenario above, having won
    // that race too) — our writes above are idempotent/already-covered, so
    // there's nothing left to reconcile, just nothing more to claim here.
    console.error(`[finalizeDraft] lost the 'generating' -> 'draft_ready' claim race for track ${track.id} — likely two overlapping worker processes`)
  }
  await markJobDraftReadyIfPending(client, jobId)

  return { ran: true }
}
