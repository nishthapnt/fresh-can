import type { SupabaseClient } from '@supabase/supabase-js'
import {
  claimTrack,
  hasSucceededStep,
  getLastSucceededStepOutput,
  getVisualAssets,
  upsertImageGeneratedContent,
  recordStepAttempt,
  markJobReadyIfAllContentComplete,
  type TrackRow,
  type PipelineRow,
} from '../../db'
import type { ImageStyle } from '../../prompts/index'
import { parseAdCopy } from '../../lib/adCopy'

export interface ImageJobMeta {
  topic: string
  category: string
  /** When 'infographic', the shared generate_ad_copy step's headline/
   *  subtitle are also written to generated_content (headline_text/
   *  subtitle_text in output_data) so the dashboard's existing headline/
   *  subtitle display card is populated — previously always empty for
   *  image_post since nothing wrote those fields. */
  imageStyle?: ImageStyle
}

/**
 * Per-language-track step — gated on BOTH this track's caption AND the
 * pipeline's shared photo being ready, mirroring Blog's finalize_draft.
 * Unlike Blog, there's no content_drafts staging step here: image_post has
 * never had an edit-before-approve UI (approval there is a
 * confirm-and-move-on click), so this writes straight to generated_content,
 * matching today's UX exactly.
 */
export async function runFinalizeImageContent(
  client: SupabaseClient,
  pipeline: PipelineRow,
  track: TrackRow,
  jobId: string,
  jobMeta: ImageJobMeta,
): Promise<{ ran: boolean }> {
  if (pipeline.status !== 'ready') return { ran: false } // shared photo not ready yet

  const generation = track.master_generation_used
  const captionReady = await hasSucceededStep(
    client,
    { contentLanguageTrackId: track.id },
    'generate_caption',
    generation,
  )
  if (!captionReady) return { ran: false }

  const alreadyDone = await hasSucceededStep(
    client,
    { contentLanguageTrackId: track.id },
    'finalize_image_content',
    generation,
  )
  if (alreadyDone) return { ran: true }

  const captionOutput = (await getLastSucceededStepOutput(
    client,
    { contentLanguageTrackId: track.id },
    'generate_caption',
    generation,
  )) as Record<string, unknown> | null

  const visualAssets = await getVisualAssets(client, pipeline.id, pipeline.current_generation)
  const photo = visualAssets.find((a) => a.asset_type === 'photo')

  const hashtags = Array.isArray(captionOutput?.hashtags)
    ? (captionOutput!.hashtags as unknown[]).map(String)
    : []

  let headlineText: string | null = null
  let subtitleText: string | null = null
  if (jobMeta.imageStyle === 'infographic') {
    const adCopyOutput = await getLastSucceededStepOutput(
      client,
      { contentPipelineId: pipeline.id },
      'generate_ad_copy',
      pipeline.current_generation,
    )
    const adCopy = parseAdCopy(adCopyOutput, '', '')
    headlineText = adCopy.headline || null
    subtitleText = adCopy.subtitle || null
  }

  await upsertImageGeneratedContent(client, {
    jobId,
    language: track.language,
    contentPipelineId: pipeline.id,
    contentLanguageTrackId: track.id,
    photoUrl: photo?.file_url ?? '',
    caption: typeof captionOutput?.caption === 'string' ? captionOutput.caption : '',
    hashtags,
    altText: typeof captionOutput?.alt_text === 'string' ? captionOutput.alt_text : '',
    topic: jobMeta.topic,
    category: jobMeta.category,
    headlineText,
    subtitleText,
  })

  // Re-check right before the (non-idempotent) attempt-log insert below —
  // same defense as finalizeDraft.ts's own (see that file's comment for the
  // full reasoning): narrows, rather than eliminates, the window for two
  // overlapping worker PROCESSES to both record a 'finalize_image_content'
  // success for this track/generation. upsertImageGeneratedContent above is
  // a natural-key upsert and safe to race; recordStepAttempt is a plain
  // insert and isn't.
  const stillNotDone = !(await hasSucceededStep(
    client,
    { contentLanguageTrackId: track.id },
    'finalize_image_content',
    generation,
  ))
  if (stillNotDone) {
    await recordStepAttempt(client, {
      contentLanguageTrackId: track.id,
      stepName: 'finalize_image_content',
      generation,
      attemptNumber: 1,
      status: 'succeeded',
      outputSnapshot: { written: true },
    })
  }

  const claimed = await claimTrack(client, track.id, 'generating', 'draft_ready')
  if (!claimed) {
    console.error(`[finalizeImageContent] lost the 'generating' -> 'draft_ready' claim race for track ${track.id} — likely two overlapping worker processes`)
  }
  // image_post writes generated_content right here, above (no separate
  // approve-gated write like blog) — so THIS is the moment content_jobs'
  // aggregate completeness check must run, not the later track-approve click.
  await markJobReadyIfAllContentComplete(client, jobId)

  return { ran: true }
}
