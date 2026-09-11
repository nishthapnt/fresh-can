import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { env } from './env.js'

export function createServiceClient(): SupabaseClient {
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)
}

export interface PipelineRow {
  id: string
  job_id: string
  content_type: string
  current_generation: number
  status: string
  current_step: string | null
  retry_count: number
  last_error: string | null
  /** Optional guidance from the Regenerate dialog for the shared visual (image_post's photo). */
  regen_instructions?: string | null
  created_at: string
  updated_at: string
}

export interface TrackRow {
  id: string
  content_pipeline_id: string
  language: 'EN' | 'FR'
  status: string
  current_step: string | null
  master_generation_used: number
  retry_count: number
  last_error: string | null
  /** Optional guidance from the Regenerate dialog for this track's copy (blog only). */
  regen_instructions?: string | null
  created_at: string
  updated_at: string
}

export interface VisualAssetRow {
  id: string
  content_pipeline_id: string
  generation: number
  asset_type: string
  status: string
  provider_ref: string | null
  file_url: string | null
  attempt_number: number
  updated_at: string
}

type StepStatus = 'running' | 'succeeded' | 'failed_retryable' | 'failed_terminal'

interface StepScope {
  contentPipelineId?: string
  contentLanguageTrackId?: string
}

function scopedQuery<T extends { eq: (col: string, val: string) => T }>(
  query: T,
  scope: StepScope,
): T {
  if (scope.contentPipelineId) return query.eq('content_pipeline_id', scope.contentPipelineId)
  if (scope.contentLanguageTrackId) {
    return query.eq('content_language_track_id', scope.contentLanguageTrackId)
  }
  throw new Error('StepScope requires contentPipelineId or contentLanguageTrackId')
}

/** Compare-and-swap claim. Returns the updated row if this call won the race, null if the row was not in fromStatus (already claimed by someone else, or in the wrong state). */
export async function claimPipeline(
  client: SupabaseClient,
  id: string,
  fromStatus: string,
  toStatus: string,
  extra: Record<string, unknown> = {},
): Promise<PipelineRow | null> {
  const { data, error } = await client
    .from('content_pipelines')
    .update({ status: toStatus, updated_at: new Date().toISOString(), ...extra })
    .eq('id', id)
    .eq('status', fromStatus)
    .select()
    .maybeSingle()
  if (error) throw error
  return data as PipelineRow | null
}

export async function claimTrack(
  client: SupabaseClient,
  id: string,
  fromStatus: string,
  toStatus: string,
  extra: Record<string, unknown> = {},
): Promise<TrackRow | null> {
  const { data, error } = await client
    .from('content_language_tracks')
    .update({ status: toStatus, updated_at: new Date().toISOString(), ...extra })
    .eq('id', id)
    .eq('status', fromStatus)
    .select()
    .maybeSingle()
  if (error) throw error
  return data as TrackRow | null
}

export async function markPipelineFailed(
  client: SupabaseClient,
  id: string,
  errorMessage: string,
): Promise<void> {
  const { error } = await client
    .from('content_pipelines')
    .update({ status: 'failed', last_error: errorMessage, updated_at: new Date().toISOString() })
    .eq('id', id)
  if (error) throw error
}

export async function markTrackFailed(
  client: SupabaseClient,
  id: string,
  errorMessage: string,
): Promise<void> {
  const { error } = await client
    .from('content_language_tracks')
    .update({ status: 'failed', last_error: errorMessage, updated_at: new Date().toISOString() })
    .eq('id', id)
  if (error) throw error
}

/** Bumps retry_count/last_error without changing status — used when a step fails but hasn't exhausted its retry cap yet. */
export async function recordPipelineRetryableFailure(
  client: SupabaseClient,
  id: string,
  retryCount: number,
  errorMessage: string,
): Promise<void> {
  const { error } = await client
    .from('content_pipelines')
    .update({ retry_count: retryCount, last_error: errorMessage, updated_at: new Date().toISOString() })
    .eq('id', id)
  if (error) throw error
}

export async function recordTrackRetryableFailure(
  client: SupabaseClient,
  id: string,
  retryCount: number,
  errorMessage: string,
): Promise<void> {
  const { error } = await client
    .from('content_language_tracks')
    .update({ retry_count: retryCount, last_error: errorMessage, updated_at: new Date().toISOString() })
    .eq('id', id)
  if (error) throw error
}

/** Idempotency check — per docs/DATABASE_DESIGN.md §2.5.2. Call before doing any provider work. */
export async function hasSucceededStep(
  client: SupabaseClient,
  scope: StepScope,
  stepName: string,
  generation: number,
): Promise<boolean> {
  const query = scopedQuery(
    client
      .from('pipeline_steps')
      .select('id')
      .eq('step_name', stepName)
      .eq('generation', generation)
      .eq('status', 'succeeded')
      .limit(1),
    scope,
  )
  const { data, error } = await query
  if (error) throw error
  return (data?.length ?? 0) > 0
}

/** Reads the output of the most recent succeeded attempt of a given step — e.g. generate_copy reads generate_outline's output this way. */
export async function getLastSucceededStepOutput(
  client: SupabaseClient,
  scope: StepScope,
  stepName: string,
  generation: number,
): Promise<unknown | null> {
  const query = scopedQuery(
    client
      .from('pipeline_steps')
      .select('output_snapshot')
      .eq('step_name', stepName)
      .eq('generation', generation)
      .eq('status', 'succeeded')
      .order('created_at', { ascending: false })
      .limit(1),
    scope,
  )
  const { data, error } = await query.maybeSingle()
  if (error) throw error
  return (data?.output_snapshot as unknown) ?? null
}

/**
 * Same as getLastSucceededStepOutput but ignores generation entirely — for a
 * step that only ever succeeds ONCE per pipeline and must never be
 * re-looked-up at a bumped generation number. generate_outline is the
 * concrete case: it always writes at the pipeline's original generation
 * (typically 1), but a blog visual-only regeneration
 * (src/app/api/jobs/[jobId]/blog/regenerate/route.ts) bumps
 * content_pipelines.current_generation without ever re-running outline —
 * looking that output up by the bumped generation permanently finds
 * nothing after the first regen, silently degrading an 'infographic'-style
 * post's on-image headline/subtitle to the crude topic-truncation fallback.
 * "Most recent succeeded, any generation" always resolves to the one real
 * row instead.
 */
export async function getLastSucceededStepOutputAnyGeneration(
  client: SupabaseClient,
  scope: StepScope,
  stepName: string,
): Promise<unknown | null> {
  const query = scopedQuery(
    client
      .from('pipeline_steps')
      .select('output_snapshot')
      .eq('step_name', stepName)
      .eq('status', 'succeeded')
      .order('created_at', { ascending: false })
      .limit(1),
    scope,
  )
  const { data, error } = await query.maybeSingle()
  if (error) throw error
  return (data?.output_snapshot as unknown) ?? null
}

export async function recordStepAttempt(
  client: SupabaseClient,
  input: {
    contentPipelineId?: string
    contentLanguageTrackId?: string
    stepName: string
    generation: number
    attemptNumber: number
    status: StepStatus
    provider?: string
    inputSnapshot?: unknown
    outputSnapshot?: unknown
    errorMessage?: string
  },
): Promise<void> {
  const finished = (['succeeded', 'failed_retryable', 'failed_terminal'] as StepStatus[]).includes(
    input.status,
  )
  const { error } = await client.from('pipeline_steps').insert({
    content_pipeline_id: input.contentPipelineId ?? null,
    content_language_track_id: input.contentLanguageTrackId ?? null,
    step_name: input.stepName,
    generation: input.generation,
    attempt_number: input.attemptNumber,
    status: input.status,
    provider: input.provider ?? null,
    input_snapshot: input.inputSnapshot ?? null,
    output_snapshot: input.outputSnapshot ?? null,
    error_message: input.errorMessage ?? null,
    started_at: new Date().toISOString(),
    finished_at: finished ? new Date().toISOString() : null,
  })
  if (error) throw error
}

export async function upsertVisualAsset(
  client: SupabaseClient,
  input: {
    contentPipelineId: string
    generation: number
    assetType: 'hero_image' | 'inline_image' | 'photo'
    status: 'pending' | 'generating' | 'ready' | 'failed'
    providerRef?: string
    fileUrl?: string
    attemptNumber?: number
  },
): Promise<VisualAssetRow> {
  const { data, error } = await client
    .from('content_visual_assets')
    .upsert(
      {
        content_pipeline_id: input.contentPipelineId,
        generation: input.generation,
        asset_type: input.assetType,
        status: input.status,
        provider_ref: input.providerRef ?? null,
        file_url: input.fileUrl ?? null,
        attempt_number: input.attemptNumber ?? 1,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'content_pipeline_id,asset_type,generation' },
    )
    .select()
    .single()
  if (error) throw error
  return data as VisualAssetRow
}

export async function getVisualAssets(
  client: SupabaseClient,
  contentPipelineId: string,
  generation: number,
): Promise<VisualAssetRow[]> {
  const { data, error } = await client
    .from('content_visual_assets')
    .select('*')
    .eq('content_pipeline_id', contentPipelineId)
    .eq('generation', generation)
  if (error) throw error
  return (data ?? []) as VisualAssetRow[]
}

/**
 * Writes a Blog track's draft. Relies on content_drafts' EXISTING
 * (job_id, content_type, language) unique constraint for one-row-per-track
 * — deliberately not adding a new unique constraint on
 * content_language_track_id, since every Blog row also carries job_id/
 * content_type/language (denormalized, per docs/DECISIONS.md #6), and those
 * three values already uniquely identify one track. Reusing the existing
 * constraint instead of adding a redundant one.
 */
/**
 * Writes an image_post track's result straight to generated_content — no
 * content_drafts staging step, since image_post has never had an
 * edit-before-approve UI (approval there is a confirm-and-move-on click,
 * not a save-then-approve flow like Blog).
 *
 * Writes to BOTH the direct columns (image_url/caption/hashtags/alt_text)
 * AND output_data redundantly: a live-data audit found real image_post rows
 * using both patterns inconsistently across different n8n runs, and
 * getImageLibrary() (src/services/contentService.ts) checks direct columns
 * first, output_data as fallback — writing both is the only way to be
 * compatible with every existing reader without picking a side.
 */
export async function upsertImageGeneratedContent(
  client: SupabaseClient,
  input: {
    jobId: string
    language: 'EN' | 'FR'
    contentPipelineId: string
    contentLanguageTrackId: string
    photoUrl: string
    caption: string
    hashtags: string[]
    altText: string
    topic: string
    category: string
    /** Only set for 'infographic'-style jobs — the shared generate_ad_copy
     *  headline/subtitle, exactly as rendered onto the image. Written into
     *  output_data (no direct column exists for these) so the dashboard's
     *  existing headline_text/subtitle_text display card (page.tsx's
     *  imgField lookups) is populated instead of always empty. */
    headlineText?: string | null
    subtitleText?: string | null
  },
): Promise<void> {
  const hashtagsStr = input.hashtags.map((h) => (h.startsWith('#') ? h : `#${h}`)).join(' ')
  const { error } = await client.from('generated_content').upsert(
    {
      job_id: input.jobId,
      content_type: 'image_post',
      language: input.language,
      content_pipeline_id: input.contentPipelineId,
      content_language_track_id: input.contentLanguageTrackId,
      file_url: input.photoUrl || null,
      status: 'completed',
      is_ready: true,
      image_url: input.photoUrl || null,
      caption: input.caption,
      hashtags: hashtagsStr,
      alt_text: input.altText,
      topic: input.topic,
      category: input.category,
      output_data: {
        image_url: input.photoUrl || null,
        caption: input.caption,
        hashtags: hashtagsStr,
        alt_text: input.altText,
        headline_text: input.headlineText ?? null,
        subtitle_text: input.subtitleText ?? null,
      },
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'job_id,content_type,language' },
  )
  if (error) throw error
}

export async function upsertBlogDraft(
  client: SupabaseClient,
  input: {
    jobId: string
    language: 'EN' | 'FR'
    contentLanguageTrackId: string
    draftData: Record<string, unknown>
  },
): Promise<void> {
  const { error } = await client.from('content_drafts').upsert(
    {
      job_id: input.jobId,
      content_type: 'blog',
      language: input.language,
      content_language_track_id: input.contentLanguageTrackId,
      draft_data: input.draftData,
      is_approved: false,
      status: 'draft_ready',
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'job_id,content_type,language' },
  )
  if (error) throw error
}
