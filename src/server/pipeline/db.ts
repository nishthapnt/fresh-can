import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { env } from './env'

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
  /** scene_video_clip only (supabase/migrations/20260919170000) — the KIE.ai
   *  clip URL captured the moment video generation succeeds, before the
   *  downscale pass runs. See upsertVisualAsset's rawFileUrl param and
   *  generateSceneVisual.ts's runSceneVideoClipStep for why this exists:
   *  it's what lets a downscale-only failure retry without re-paying for a
   *  brand-new KIE video generation. Always null for every other asset_type. */
  raw_file_url: string | null
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

/**
 * Advances a job's aggregate status to 'failed' when one of its
 * pipelines/tracks fails terminally — fixes a real bug found live: a video
 * job whose pipeline/tracks had all genuinely failed stayed at
 * content_jobs.status = 'generating' forever, because nothing ever wrote
 * 'failed' at the job level (the exact "status: 'failed' is never written
 * by anything" gap ARCHITECTURE.MD §3.2 already documented for the old n8n
 * system — it turned out the new worker never closed it either). Called
 * from markPipelineFailed/markTrackFailed below, so it's automatic for
 * blog, image_post, AND video — not a video-specific patch.
 *
 * Never downgrades a job already at a genuinely terminal state ('ready',
 * 'posted', or already 'failed') — content_jobs.status is a single flat
 * field shared across every content type in a multi-type job (a known,
 * pre-existing coarseness, not something this fix attempts to redesign —
 * see ARCHITECTURE.MD §6.2 for the finer-grained aggregate this could
 * become), so this only ever moves a job TOWARD 'failed', never away from
 * a success it's already reached.
 */
async function markJobFailedIfNotAlreadyTerminal(client: SupabaseClient, jobId: string): Promise<void> {
  const { data: job, error } = await client.from('content_jobs').select('status').eq('id', jobId).single()
  if (error) throw error
  if (job.status === 'ready' || job.status === 'posted' || job.status === 'failed') return
  const { error: updateErr } = await client
    .from('content_jobs')
    .update({ status: 'failed', updated_at: new Date().toISOString() })
    .eq('id', jobId)
  if (updateErr) throw updateErr
}

/**
 * Success-path counterpart to markJobFailedIfNotAlreadyTerminal — a gap left
 * when blog/image_post/video moved off n8n: the retired n8n-callback route
 * used to own content_jobs.status entirely (its 'draft_ready' event set this
 * exact value the moment ANY content type's draft was ready), but nothing
 * replaced that when the callback was narrowed to social-posting only.
 * Without this, a job sits at 'pending' forever even after its blog draft
 * genuinely finishes (confirmed live 2026-09-17).
 *
 * Blog-only: image_post and video write generated_content directly with no
 * review stage (see finalizeImageContent.ts/renderLanguageTrack.ts), so they
 * skip 'draft_ready' entirely and go straight to 'ready' via
 * markJobReadyIfAllContentComplete below — exactly mirroring what the old
 * n8n callback did (its 'draft_ready' event was blog-only in practice).
 * Only ever moves 'pending' -> 'draft_ready' — never overwrites a job
 * already further along (or failed).
 */
export async function markJobDraftReadyIfPending(client: SupabaseClient, jobId: string): Promise<void> {
  const { data: job, error } = await client.from('content_jobs').select('status').eq('id', jobId).single()
  if (error) throw error
  if (job.status !== 'pending') return
  const { error: updateErr } = await client
    .from('content_jobs')
    .update({ status: 'draft_ready', updated_at: new Date().toISOString() })
    .eq('id', jobId)
  if (updateErr) throw updateErr
}

/**
 * The other success-path counterpart — advances content_jobs.status to
 * 'ready' once every requested content_type has produced at least one
 * generated_content row. Deliberately coarse (content-type PRESENCE, not
 * per-language completeness) — matches the same acknowledged coarseness
 * markJobFailedIfNotAlreadyTerminal's own comment already documents for this
 * field (content_jobs.status is one flat value shared across a multi-type,
 * multi-language job); the old n8n callback's generic completion check
 * (readyCount >= content_types.length) had this exact same looseness.
 * Never downgrades a job already at 'ready'/'posted'/'failed'.
 */
export async function markJobReadyIfAllContentComplete(client: SupabaseClient, jobId: string): Promise<void> {
  const { data: job, error } = await client
    .from('content_jobs')
    .select('status, content_types')
    .eq('id', jobId)
    .single()
  if (error) throw error
  if (job.status === 'ready' || job.status === 'posted' || job.status === 'failed') return

  const requested = (job.content_types as string[] | null) ?? []
  if (requested.length === 0) return

  const { data: rows, error: rowsErr } = await client
    .from('generated_content')
    .select('content_type')
    .eq('job_id', jobId)
  if (rowsErr) throw rowsErr

  const completedTypes = new Set((rows ?? []).map((r) => r.content_type as string))
  if (!requested.every((t) => completedTypes.has(t))) return

  const { error: updateErr } = await client
    .from('content_jobs')
    .update({ status: 'ready', updated_at: new Date().toISOString() })
    .eq('id', jobId)
  if (updateErr) throw updateErr
}

export async function markPipelineFailed(
  client: SupabaseClient,
  id: string,
  errorMessage: string,
): Promise<void> {
  const { data, error } = await client
    .from('content_pipelines')
    .update({ status: 'failed', last_error: errorMessage, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select('job_id')
    .single()
  if (error) throw error

  // A language track that already finished localize/synthesize/transcribe
  // (sitting at 'awaiting_shared', or mid-render at 'rendering') was never
  // gated on the shared pipeline's own outcome — only on it existing. If
  // the shared visuals fail here, that track's pipeline can never reach
  // 'ready' again, so runRenderLanguageTrack's very first check
  // (pipeline.status !== 'ready') permanently no-ops on it, forever,
  // stranding it at whatever status it was in — confirmed live: exactly
  // this happened to a real track after a scene-visual generation
  // exhausted its retries. Fail every non-terminal track too, same
  // 'Cancelled by user'-style pattern the video/cancel route already uses,
  // so nothing is ever left dangling behind a dead shared pipeline.
  const { error: tErr } = await client
    .from('content_language_tracks')
    .update({ status: 'failed', last_error: `Shared pipeline failed: ${errorMessage}`, updated_at: new Date().toISOString() })
    .eq('content_pipeline_id', id)
    .not('status', 'in', '(ready,failed)')
  if (tErr) throw tErr

  await markJobFailedIfNotAlreadyTerminal(client, data.job_id)
}

export async function markTrackFailed(
  client: SupabaseClient,
  id: string,
  errorMessage: string,
): Promise<void> {
  const { data, error } = await client
    .from('content_language_tracks')
    .update({ status: 'failed', last_error: errorMessage, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select('content_pipeline_id')
    .single()
  if (error) throw error
  const { data: pipeline, error: pErr } = await client
    .from('content_pipelines')
    .select('job_id')
    .eq('id', data.content_pipeline_id)
    .single()
  if (pErr) throw pErr
  await markJobFailedIfNotAlreadyTerminal(client, pipeline.job_id)
}

/** Bumps retry_count/last_error without changing status — used when a step fails but hasn't exhausted its retry cap yet. */
// Cheap liveness check for a long-running poll loop (KIE image/video
// generation and upload-post.com's ffmpeg passes can run for minutes) —
// reads ONLY the status column, not a full row, since this runs on every
// poll tick for as long as a generation is in flight. 'failed' covers BOTH
// a genuine provider failure (markPipelineFailed/markTrackFailed) and an
// explicit user cancellation (POST .../video/cancel, which reuses this
// same status value rather than adding a new one — see that route's own
// header) — a poll loop has no reason to keep working once EITHER has
// happened, so it doesn't need to distinguish which. Added 2026-09-22
// after a real gap: cancelling mid-poll only ever changed the DB row: the
// KIE/upload-post job already submitted kept running (and being billed/
// consuming time) until it finished or timed out on its own, since nothing
// checked for cancellation WHILE a poll loop was already running — only
// the code BETWEEN steps/waves ever re-read pipeline/track status. These
// checks close that gap by making every poll loop itself durable against
// cancellation, not just the code that decides whether to start the next
// one.
//
// Fails OPEN (returns false) on a read error — a transient DB hiccup while
// checking "should I stop?" must never itself abort an otherwise-healthy,
// already-paid-for generation; that generation's own timeout/normal
// completion still applies as the fallback either way.
export async function isPipelineFailed(client: SupabaseClient, pipelineId: string): Promise<boolean> {
  const { data, error } = await client.from('content_pipelines').select('status').eq('id', pipelineId).maybeSingle()
  if (error || !data) return false
  return data.status === 'failed'
}

/** Same as isPipelineFailed, for a content_language_tracks row — the
 *  render/transcription poll loops are track-scoped, not pipeline-scoped. */
export async function isTrackFailed(client: SupabaseClient, trackId: string): Promise<boolean> {
  const { data, error } = await client.from('content_language_tracks').select('status').eq('id', trackId).maybeSingle()
  if (error || !data) return false
  return data.status === 'failed'
}

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

/**
 * Reads back the error_message of a step's most recent failed_retryable
 * attempt — used by generateSceneVisual.ts's targeted-regeneration path
 * (runSceneImageStep) to recover a validation-triggered correction
 * instruction on the NEXT attempt, without a new DB column: recordStepAttempt
 * already persists an errorMessage on every failed attempt (both a genuine
 * provider failure and, as of the image-validation gate, a rejected-by-QA
 * attempt), so this just reads that same existing column back. Returns null
 * if the step has never failed at this generation (the ordinary case).
 */
export async function getLastFailedStepErrorMessage(
  client: SupabaseClient,
  scope: StepScope,
  stepName: string,
  generation: number,
): Promise<string | null> {
  const query = scopedQuery(
    client
      .from('pipeline_steps')
      .select('error_message')
      .eq('step_name', stepName)
      .eq('generation', generation)
      .eq('status', 'failed_retryable')
      .order('created_at', { ascending: false })
      .limit(1),
    scope,
  )
  const { data, error } = await query.maybeSingle()
  if (error) throw error
  return (data?.error_message as string | null) ?? null
}

/** Same lookup as getLastFailedStepErrorMessage, plus that attempt's
 *  output_snapshot — used by generateSceneVisual.ts to recover a
 *  validation-rejected image's URL so the retry can edit it instead of
 *  regenerating from scratch. */
export async function getLastFailedStepAttempt(
  client: SupabaseClient,
  scope: StepScope,
  stepName: string,
  generation: number,
): Promise<{ errorMessage: string | null; outputSnapshot: unknown } | null> {
  const query = scopedQuery(
    client
      .from('pipeline_steps')
      .select('error_message, output_snapshot')
      .eq('step_name', stepName)
      .eq('generation', generation)
      .eq('status', 'failed_retryable')
      .order('created_at', { ascending: false })
      .limit(1),
    scope,
  )
  const { data, error } = await query.maybeSingle()
  if (error) throw error
  if (!data) return null
  return { errorMessage: (data.error_message as string | null) ?? null, outputSnapshot: data.output_snapshot ?? null }
}

/** The video pipeline's shared script/plan blob (content_drafts.draft_data,
 *  written by upsertVideoScriptDraft) — null if the draft row is missing.
 *  Read by generateSceneVisual.ts for the plan-level look/cast_bible. */
export async function getVideoPlanDraftData(
  client: SupabaseClient,
  contentPipelineId: string,
): Promise<Record<string, unknown> | null> {
  const { data, error } = await client
    .from('content_drafts')
    .select('draft_data')
    .eq('content_pipeline_id', contentPipelineId)
    .eq('content_type', 'video')
    .limit(1)
    .maybeSingle()
  if (error) throw error
  const draftData = data?.draft_data
  return draftData && typeof draftData === 'object' ? (draftData as Record<string, unknown>) : null
}

/**
 * How many failed_retryable attempts of `stepName` at `generation` carry an
 * error_message starting with `prefix` — used by generateSceneVisual.ts to
 * give validation-driven regenerations their OWN small budget, separate
 * from the provider-failure budget (MAX_ATTEMPTS.kie) they'd otherwise
 * share. `prefix` is matched literally (LIKE wildcards escaped).
 */
export async function countFailedStepAttemptsWithPrefix(
  client: SupabaseClient,
  scope: StepScope,
  stepName: string,
  generation: number,
  prefix: string,
): Promise<number> {
  const escaped = prefix.replace(/[\\%_]/g, (c) => `\\${c}`)
  // Not routed through scopedQuery(): combining a head:true count-select
  // with .like() defeats its generic `T extends { eq }` inference and
  // TypeScript reports "Type instantiation is excessively deep and
  // possibly infinite" (caught in the Vercel build, not local dev). The
  // scope branch is inlined instead — same logic, no generic to blow up.
  let query = client
    .from('pipeline_steps')
    .select('id', { count: 'exact', head: true })
    .eq('step_name', stepName)
    .eq('generation', generation)
    .eq('status', 'failed_retryable')
    .like('error_message', `${escaped}%`)
  if (scope.contentPipelineId) {
    query = query.eq('content_pipeline_id', scope.contentPipelineId)
  } else if (scope.contentLanguageTrackId) {
    query = query.eq('content_language_track_id', scope.contentLanguageTrackId)
  } else {
    throw new Error('StepScope requires contentPipelineId or contentLanguageTrackId')
  }
  const { count, error } = await query
  if (error) throw error
  return count ?? 0
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
    /** scene_video_clip only — see VisualAssetRow.raw_file_url's own doc
     *  comment. MUST be passed explicitly on every call that should keep an
     *  already-set value (this function always writes the full row, not a
     *  partial patch, so omitting it here wipes any existing value back to
     *  null — the same deliberate reset-by-omission behavior providerRef/
     *  fileUrl already rely on elsewhere in this function). */
    rawFileUrl?: string
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
    raw_file_url: input.rawFileUrl ?? null,
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

/**
 * Returns the pipeline's CURRENT scene plan — the rows at the highest
 * generation present, not an exact match against whatever generation the
 * caller happens to be at. Deliberately NOT generation-exact: a
 * visuals-only regenerate (scope: "visuals") bumps content_pipelines.
 * current_generation without ever re-running generate_script (the scene
 * plan itself didn't change), so an exact-match lookup at the new
 * generation would find nothing, forever. This mirrors the same "any
 * generation" reasoning generate_outline's lookup already uses for Blog
 * (getLastSucceededStepOutputAnyGeneration) — the scene plan is shared,
 * foundational data that only changes when generate_script itself reruns
 * (scope: "script"), not on every regeneration.
 */
export async function getVideoScenes(
  client: SupabaseClient,
  contentPipelineId: string,
): Promise<VideoSceneRow[]> {
  const { data, error } = await client
    .from('video_scenes')
    .select('*')
    .eq('content_pipeline_id', contentPipelineId)
    .order('generation', { ascending: false })
    .order('scene_number', { ascending: true })
  if (error) throw error
  if (!data || data.length === 0) return []
  const latestGeneration = (data[0] as VideoSceneRow).generation
  return (data as VideoSceneRow[]).filter((s) => s.generation === latestGeneration)
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

// ─── Social posting (replaces n8n's social branch — ARCHITECTURE.MD §2.5) ──

export interface SocialPostRow {
  id: string
  job_id: string
  content_type: string
  caption: string
  hashtags: string[]
  platforms: string[]
  status: string
  created_at: string
  updated_at: string
}

export interface SocialPlatformLogRow {
  id: string
  social_post_id: string
  job_id: string | null
  content_type: string
  platform: string
  status: string
  platform_post_id: string | null
  post_url: string | null
  error_message: string | null
  provider_job_ref: string | null
  attempt_count: number
  last_attempted_at: string | null
  created_at: string
  updated_at: string
}

/**
 * social_posts rows the dashboard has approved (src/app/api/social/post's
 * upsertSocialPost sets status='approved') but this worker hasn't submitted
 * to upload-post.com yet. "Not yet submitted" is read off the ABSENCE of any
 * social_platform_logs row for that post, rather than a status flag on
 * social_posts itself — the old n8n flow never created platform-log rows
 * until its callback fired, so there's no existing column to repurpose for
 * this, and adding one would duplicate what "no child rows yet" already
 * tells you for free.
 */
export async function getApprovedSocialPostsAwaitingSubmission(
  client: SupabaseClient,
): Promise<SocialPostRow[]> {
  const { data: posts, error } = await client.from('social_posts').select('*').eq('status', 'approved')
  if (error) throw error
  if (!posts?.length) return []

  const ids = posts.map((p) => p.id as string)
  const { data: logs, error: logErr } = await client
    .from('social_platform_logs')
    .select('social_post_id')
    .in('social_post_id', ids)
  if (logErr) throw logErr

  const alreadySubmitted = new Set((logs ?? []).map((l) => l.social_post_id as string))
  return (posts as SocialPostRow[]).filter((p) => !alreadySubmitted.has(p.id))
}

/**
 * Writes one social_platform_logs row per platform from a single
 * publish() call's outcome — one upload-post.com call covers every
 * selected platform at once (its own platform[] array), but this app
 * tracks per-platform status in separate rows (SocialApprovalCard/
 * PROGRESS.md's per-platform posting history), so the fan-out happens
 * here, not on the provider side. providerJobRef is the SAME value across
 * every row from one call — poll() resolves them all together for
 * exactly that reason (see publishPost.ts).
 */
export async function insertSocialPlatformLogs(
  client: SupabaseClient,
  input: {
    socialPostId: string
    jobId: string
    /** social_platform_logs.content_type is NOT NULL on the live table
     *  (confirmed via its PostgREST schema, 2026-09-17) — the pre-migration
     *  n8n-callback route never set it either, which is very likely why
     *  this table has sat completely empty in production despite 558 real
     *  jobs (TASKS.md/PROGRESS.md): every insert attempt would have failed
     *  the same not-null constraint this fixes. */
    contentType: string
    providerJobRef: string | null
    outcomes: Array<{
      platform: string
      status: 'posted' | 'failed' | 'posting'
      platformPostId?: string
      postUrl?: string
      errorMessage?: string
    }>
  },
): Promise<void> {
  const now = new Date().toISOString()
  const rows = input.outcomes.map((o) => ({
    social_post_id: input.socialPostId,
    job_id: input.jobId,
    content_type: input.contentType,
    platform: o.platform,
    status: o.status,
    platform_post_id: o.platformPostId ?? null,
    post_url: o.postUrl ?? null,
    error_message: o.errorMessage ?? null,
    posted_at: o.status === 'posted' ? now : null,
    failed_at: o.status === 'failed' ? now : null,
    provider_job_ref: input.providerJobRef,
    attempt_count: 1,
    last_attempted_at: now,
    updated_at: now,
  }))
  const { error } = await client.from('social_platform_logs').insert(rows)
  if (error) throw error
}

/** Every social_platform_logs row still awaiting resolution, grouped by
 *  provider_job_ref — one poll() call per group resolves every platform
 *  row that came from the same original publish() call. */
export async function getPostingSocialPlatformLogGroups(
  client: SupabaseClient,
): Promise<Map<string, SocialPlatformLogRow[]>> {
  const { data, error } = await client.from('social_platform_logs').select('*').eq('status', 'posting')
  if (error) throw error

  const groups = new Map<string, SocialPlatformLogRow[]>()
  for (const row of (data ?? []) as SocialPlatformLogRow[]) {
    if (!row.provider_job_ref) continue // shouldn't happen — guards a malformed row from crashing the poll tick
    const group = groups.get(row.provider_job_ref)
    if (group) group.push(row)
    else groups.set(row.provider_job_ref, [row])
  }
  return groups
}

/** Resolves a group of platform-log rows (same provider_job_ref) against
 *  the provider's per-platform result once poll() reports 'ready'. */
export async function resolveSocialPlatformLogs(
  client: SupabaseClient,
  rows: SocialPlatformLogRow[],
  perPlatform: Array<{ platform: string; success: boolean; url?: string; error?: string }>,
): Promise<void> {
  const now = new Date().toISOString()
  for (const row of rows) {
    const outcome = perPlatform.find((p) => p.platform === row.platform)
    const success = outcome?.success ?? false
    const { error } = await client
      .from('social_platform_logs')
      .update({
        status: success ? 'posted' : 'failed',
        post_url: outcome?.url ?? null,
        error_message: success ? null : (outcome?.error ?? 'upload-post.com reported failure'),
        posted_at: success ? now : null,
        failed_at: success ? null : now,
        updated_at: now,
      })
      .eq('id', row.id)
    if (error) throw error
  }
}

/** Flips a still-'posting' row to 'failed' without a provider result —
 *  either the poll call itself errored, or the row exceeded its staleness
 *  cap (see publishPost.ts's STALE_POSTING_MS). This is the direct fix for
 *  the confirmed-live bug (TASKS.md, PROGRESS.md) of rows stuck at
 *  'posting' forever with no error surfaced. */
export async function markSocialPlatformLogFailed(
  client: SupabaseClient,
  rowId: string,
  errorMessage: string,
): Promise<void> {
  const now = new Date().toISOString()
  const { error } = await client
    .from('social_platform_logs')
    .update({ status: 'failed', error_message: errorMessage, failed_at: now, updated_at: now })
    .eq('id', rowId)
  if (error) throw error
}

export async function bumpSocialPlatformLogAttempt(client: SupabaseClient, rowIds: string[]): Promise<void> {
  if (rowIds.length === 0) return
  const { error } = await client
    .from('social_platform_logs')
    .update({ last_attempted_at: new Date().toISOString() })
    .in('id', rowIds)
  if (error) throw error
  // attempt_count increments one row at a time (Postgres has no portable
  // "col = col + 1" via supabase-js's update()) — small batches (one
  // provider job's platform count, at most 3 today) make this a
  // non-issue.
  for (const id of rowIds) {
    const { data, error: readErr } = await client
      .from('social_platform_logs')
      .select('attempt_count')
      .eq('id', id)
      .single()
    if (readErr) throw readErr
    const { error: writeErr } = await client
      .from('social_platform_logs')
      .update({ attempt_count: ((data?.attempt_count as number) ?? 0) + 1 })
      .eq('id', id)
    if (writeErr) throw writeErr
  }
}

/** The already-generated file this post is publicizing — read fresh from
 *  generated_content rather than trusting a value the dashboard's request
 *  happened to carry, same "worker re-derives its own inputs from durable
 *  state" reasoning fetchJobInputs uses for content_jobs. Picks the most
 *  recent row for this (job, content_type) — social_posts has no language
 *  dimension yet (unlike content_language_tracks/generated_content for
 *  every other purpose, ARCHITECTURE.MD §17.4's proposed widening isn't
 *  applied here), so a BOTH-language job's two generated_content rows are
 *  not separately representable at the social layer yet; this is the same
 *  limitation the old n8n flow had, not a regression introduced here.
 *
 * Falls back to `image_url` when `file_url` is null — confirmed live
 * (2026-09-17): pre-migration, n8n-era image_post rows only ever populated
 * `image_url` (never `file_url`), so any such job approved for social
 * posting failed here every time with "nothing to post" despite a real,
 * displayable image existing (src/services/contentService.ts's
 * getImageLibrary already has this exact same fallback, for the same
 * reason). The current worker's upsertImageGeneratedContent writes BOTH
 * columns for new rows, so this fallback only ever matters for that old
 * data, never masks a genuine "nothing was generated" case. */
export async function getGeneratedContentFileUrl(
  client: SupabaseClient,
  jobId: string,
  contentType: string,
): Promise<string | null> {
  const { data, error } = await client
    .from('generated_content')
    .select('file_url, image_url')
    .eq('job_id', jobId)
    .eq('content_type', contentType)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw error
  return (data?.file_url as string | null) ?? (data?.image_url as string | null) ?? null
}

/** Rolls social_posts.status up from its child platform-log rows once
 *  every one of them has reached a terminal state. SocialStatus has no
 *  'partial' value yet (ARCHITECTURE.MD §17.4 proposes one) — until then,
 *  "at least one platform succeeded" reads as 'posted' overall, matching
 *  what SocialApprovalCard already shows today (a per-platform success
 *  list, not an all-or-nothing banner). Only 'failed' if EVERY platform
 *  failed. */
export async function rollupSocialPostStatus(client: SupabaseClient, socialPostId: string): Promise<void> {
  const { data: logs, error } = await client
    .from('social_platform_logs')
    .select('status')
    .eq('social_post_id', socialPostId)
  if (error) throw error
  if (!logs?.length) return

  const allTerminal = logs.every((l) => l.status === 'posted' || l.status === 'failed')
  if (!allTerminal) return

  const anyPosted = logs.some((l) => l.status === 'posted')
  const { error: updateErr } = await client
    .from('social_posts')
    .update({ status: anyPosted ? 'posted' : 'failed', updated_at: new Date().toISOString() })
    .eq('id', socialPostId)
  if (updateErr) throw updateErr
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
