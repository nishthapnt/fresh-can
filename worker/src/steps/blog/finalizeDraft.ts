import type { SupabaseClient } from '@supabase/supabase-js'
import {
  claimTrack,
  hasSucceededStep,
  getLastSucceededStepOutput,
  getVisualAssets,
  upsertBlogDraft,
  recordStepAttempt,
  type TrackRow,
  type PipelineRow,
} from '../../db.js'

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

  await recordStepAttempt(client, {
    contentLanguageTrackId: track.id,
    stepName: 'finalize_draft',
    generation,
    attemptNumber: 1,
    status: 'succeeded',
    outputSnapshot: { draftWritten: true },
  })

  await claimTrack(client, track.id, 'generating', 'draft_ready')

  return { ran: true }
}
