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
  /** video-only fan-in counters (supabase/migrations/20260912000000) — null/0
   *  and unused for blog/image_post. See generateSceneVisual.ts. */
  scenes_total: number | null
  scenes_visuals_ready_count: number
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
  video_scene_id: string | null
  updated_at: string
}

export interface VideoSceneRow {
  id: string
  content_pipeline_id: string
  generation: number
  scene_number: number
  visual_description: string
  shot_notes: string | null
  narration_intent: unknown
  target_duration_ms: number
  created_at: string
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

/**
 * Deliberately NOT a `.upsert(..., {onConflict})` call. content_visual_assets'
 * uniqueness (supabase/migrations/20260912000000) is enforced by two PARTIAL
 * unique indexes (split on whether video_scene_id is null), and Postgres
 * only accepts a partial index as an ON CONFLICT arbiter when the conflict
 * clause restates the index's exact predicate — which supabase-js's
 * `onConflict` column-list string cannot express. Using it anyway silently
 * broke this function for EVERY caller, not just video's new ones (confirmed
 * live: `there is no unique or exclusion constraint matching the ON CONFLICT
 * specification`, reproduced against Blog/Image's own existing calls the
 * moment this migration was applied). Select-then-write instead: functionally
 * identical idempotency, with a unique-violation catch for the genuine race
 * (two workers inserting the same natural key at once) — the same pattern
 * the API routes already use for their own idempotent-insert races.
 */
export async function upsertVisualAsset(
  client: SupabaseClient,
  input: {
    contentPipelineId: string
    generation: number
    assetType: 'hero_image' | 'inline_image' | 'photo' | 'character_ref' | 'scene_image' | 'scene_video_clip'
    status: 'pending' | 'generating' | 'ready' | 'failed'
    /** Set only for scene_image/scene_video_clip — identifies which of the
     *  two partial indexes' natural key this row belongs to. */
    videoSceneId?: string
    providerRef?: string
    fileUrl?: string
    attemptNumber?: number
  },
): Promise<VisualAssetRow> {
  const UNIQUE_VIOLATION = '23505'
  const row = {
    content_pipeline_id: input.contentPipelineId,
    generation: input.generation,
    asset_type: input.assetType,
    status: input.status,
    ...(input.videoSceneId ? { video_scene_id: input.videoSceneId } : {}),
    provider_ref: input.providerRef ?? null,
    file_url: input.fileUrl ?? null,
    attempt_number: input.attemptNumber ?? 1,
    updated_at: new Date().toISOString(),
  }

  async function findByNaturalKey(): Promise<{ id: string } | null> {
    let query = client
      .from('content_visual_assets')
      .select('id')
      .eq('content_pipeline_id', input.contentPipelineId)
      .eq('asset_type', input.assetType)
      .eq('generation', input.generation)
    query = input.videoSceneId ? query.eq('video_scene_id', input.videoSceneId) : query.is('video_scene_id', null)
    const { data, error } = await query.maybeSingle()
    if (error) throw error
    return data
  }

  const existing = await findByNaturalKey()

  if (existing) {
    const { data, error } = await client
      .from('content_visual_assets')
      .update(row)
      .eq('id', existing.id)
      .select()
      .single()
    if (error) throw error
    return data as VisualAssetRow
  }

  const { data, error } = await client.from('content_visual_assets').insert(row).select().single()
  if (!error) return data as VisualAssetRow
  if (error.code !== UNIQUE_VIOLATION) throw error

  // Lost a race to another worker inserting the same natural key between
  // our SELECT and INSERT — fetch its row and update it instead of failing.
  const raced = await findByNaturalKey()
  if (!raced) throw error
  const { data: updated, error: updateErr } = await client
    .from('content_visual_assets')
    .update(row)
    .eq('id', raced.id)
    .select()
    .single()
  if (updateErr) throw updateErr
  return updated as VisualAssetRow
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
/**
 * Writes a video track's final render. Like upsertVisualAsset,
 * deliberately NOT a `.upsert(..., {onConflict})` call —
 * `generated_content_track_key` is a PARTIAL unique index (`WHERE
 * content_language_track_id IS NOT NULL`), which hits the exact same
 * ON-CONFLICT-can't-target-a-partial-index issue that broke
 * upsertVisualAsset the moment its migration was applied. Select-then-write
 * instead, with the same unique-violation race fallback.
 */
export async function upsertVideoGeneratedContent(
  client: SupabaseClient,
  input: {
    jobId: string
    language: 'EN' | 'FR'
    contentPipelineId: string
    contentLanguageTrackId: string
    fileUrl: string
    sceneCount: number
  },
): Promise<void> {
  const UNIQUE_VIOLATION = '23505'
  const row = {
    job_id: input.jobId,
    content_type: 'video',
    language: input.language,
    content_pipeline_id: input.contentPipelineId,
    content_language_track_id: input.contentLanguageTrackId,
    file_url: input.fileUrl,
    status: 'completed',
    output_data: { language: input.language, total_scenes: input.sceneCount },
    updated_at: new Date().toISOString(),
  }

  const { data: existing, error: findErr } = await client
    .from('generated_content')
    .select('id')
    .eq('content_language_track_id', input.contentLanguageTrackId)
    .maybeSingle()
  if (findErr) throw findErr

  if (existing) {
    const { error } = await client.from('generated_content').update(row).eq('id', existing.id)
    if (error) throw error
    return
  }

  const { error } = await client.from('generated_content').insert(row)
  if (!error) return
  if (error.code !== UNIQUE_VIOLATION) throw error

  const { data: raced, error: raceErr } = await client
    .from('generated_content')
    .select('id')
    .eq('content_language_track_id', input.contentLanguageTrackId)
    .maybeSingle()
  if (raceErr) throw raceErr
  if (!raced) throw error
  const { error: updateErr } = await client.from('generated_content').update(row).eq('id', raced.id)
  if (updateErr) throw updateErr
}

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

/**
 * Writes Video's ONE master script+scene draft. content_pipeline_id is set,
 * content_language_track_id is left null (there is no per-language video
 * draft — the script is approved once, at the project level,
 * ARCHITECTURE.MD §6.4). `language` is set to the job's own intent-only
 * value (EN|FR|BOTH) purely for read compatibility with the existing
 * (job_id, content_type, language) unique constraint — reusing it the same
 * way upsertBlogDraft reuses it for per-track rows, rather than adding a new
 * constraint. It is NOT a real per-language scoping key for this row.
 */
export async function upsertVideoScriptDraft(
  client: SupabaseClient,
  input: {
    jobId: string
    language: string
    contentPipelineId: string
    draftData: Record<string, unknown>
  },
): Promise<void> {
  const { error } = await client.from('content_drafts').upsert(
    {
      job_id: input.jobId,
      content_type: 'video',
      language: input.language,
      content_pipeline_id: input.contentPipelineId,
      draft_data: input.draftData,
      is_approved: false,
      status: 'draft_ready',
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'job_id,content_type,language' },
  )
  if (error) throw error
}

export async function upsertVideoScenes(
  client: SupabaseClient,
  input: {
    contentPipelineId: string
    generation: number
    scenes: Array<{
      sceneNumber: number
      visualDescription: string
      shotNotes: string | null
      narrationIntent: unknown
      targetDurationMs: number
    }>
  },
): Promise<void> {
  const { error } = await client.from('video_scenes').upsert(
    input.scenes.map((s) => ({
      content_pipeline_id: input.contentPipelineId,
      generation: input.generation,
      scene_number: s.sceneNumber,
      visual_description: s.visualDescription,
      shot_notes: s.shotNotes,
      narration_intent: s.narrationIntent,
      target_duration_ms: s.targetDurationMs,
    })),
    { onConflict: 'content_pipeline_id,generation,scene_number' },
  )
  if (error) throw error
}

export async function getVideoScenes(
  client: SupabaseClient,
  contentPipelineId: string,
  generation: number,
): Promise<VideoSceneRow[]> {
  const { data, error } = await client
    .from('video_scenes')
    .select('*')
    .eq('content_pipeline_id', contentPipelineId)
    .eq('generation', generation)
    .order('scene_number', { ascending: true })
  if (error) throw error
  return (data ?? []) as VideoSceneRow[]
}

export interface VideoSceneAudioRow {
  id: string
  content_language_track_id: string
  video_scene_id: string
  generation: number
  narration_text: string | null
  file_url: string | null
  duration_ms: number | null
  provider_ref: string | null
  status: string
  attempt_number: number
  created_at: string
  updated_at: string
}

/**
 * `video_scene_audio`'s unique constraint (content_language_track_id,
 * video_scene_id, generation) is a PLAIN constraint, not a partial index
 * like content_visual_assets' — so, unlike upsertVisualAsset, a normal
 * `.upsert(..., {onConflict})` is safe here.
 */
export async function upsertVideoSceneAudio(
  client: SupabaseClient,
  input: {
    contentLanguageTrackId: string
    videoSceneId: string
    generation: number
    status: 'pending' | 'generating' | 'ready' | 'failed'
    narrationText?: string
    fileUrl?: string
    durationMs?: number
    providerRef?: string
    attemptNumber?: number
  },
): Promise<VideoSceneAudioRow> {
  const { data, error } = await client
    .from('video_scene_audio')
    .upsert(
      {
        content_language_track_id: input.contentLanguageTrackId,
        video_scene_id: input.videoSceneId,
        generation: input.generation,
        status: input.status,
        ...(input.narrationText !== undefined ? { narration_text: input.narrationText } : {}),
        ...(input.fileUrl !== undefined ? { file_url: input.fileUrl } : {}),
        ...(input.durationMs !== undefined ? { duration_ms: input.durationMs } : {}),
        ...(input.providerRef !== undefined ? { provider_ref: input.providerRef } : {}),
        attempt_number: input.attemptNumber ?? 1,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'content_language_track_id,video_scene_id,generation' },
    )
    .select()
    .single()
  if (error) throw error
  return data as VideoSceneAudioRow
}

export async function getVideoSceneAudioRows(
  client: SupabaseClient,
  contentLanguageTrackId: string,
  generation: number,
): Promise<VideoSceneAudioRow[]> {
  const { data, error } = await client
    .from('video_scene_audio')
    .select('*')
    .eq('content_language_track_id', contentLanguageTrackId)
    .eq('generation', generation)
  if (error) throw error
  return (data ?? []) as VideoSceneAudioRow[]
}

export interface VideoCaptionRow {
  id: string
  content_language_track_id: string
  generation: number
  provider_ref: string | null
  timing_data: unknown
  file_url: string | null
  status: string
  attempt_number: number
  created_at: string
  updated_at: string
}

/** `video_captions`' unique constraint (content_language_track_id,
 *  generation) is also a plain constraint — onConflict upsert is safe. */
export async function upsertVideoCaptions(
  client: SupabaseClient,
  input: {
    contentLanguageTrackId: string
    generation: number
    timingData: unknown
    status: 'pending' | 'generating' | 'ready' | 'failed'
    fileUrl?: string
  },
): Promise<VideoCaptionRow> {
  const { data, error } = await client
    .from('video_captions')
    .upsert(
      {
        content_language_track_id: input.contentLanguageTrackId,
        generation: input.generation,
        timing_data: input.timingData,
        status: input.status,
        file_url: input.fileUrl ?? null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'content_language_track_id,generation' },
    )
    .select()
    .single()
  if (error) throw error
  return data as VideoCaptionRow
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
