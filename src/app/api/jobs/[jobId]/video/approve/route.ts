import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

function getSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  return createClient(url, key)
}

type VideoLanguage = 'EN' | 'FR'

// BOTH is a request-level concept only — resolved here into 1 or 2 discrete
// language tracks, exactly like blog/image's own resolveRequestedLanguages.
// The literal string 'BOTH' never reaches a track row, and there is no
// separate `video_approve_both` code path — a two-element array IS what
// BOTH means (ARCHITECTURE.MD §9/§11).
function resolveRequestedLanguages(jobLanguage: string, override?: unknown): VideoLanguage[] {
  if (Array.isArray(override)) {
    const valid = override.filter((l): l is VideoLanguage => l === 'EN' || l === 'FR')
    if (valid.length > 0) return Array.from(new Set(valid))
  }
  if (jobLanguage === 'BOTH') return ['EN', 'FR']
  if (jobLanguage === 'FR') return ['FR']
  return ['EN']
}

const UNIQUE_VIOLATION = '23505'

// Locks the master script (draft_ready -> approved) and creates one
// content_language_track row per requested language, all in this one call —
// unlike blog/image's /generate, which creates tracks immediately since
// those types have no pre-generation approval gate. This is the ONLY place
// video's language tracks get created; the worker does not create them.
//
// M1 scope: this route only performs the state transition + track creation.
// It does not yet enqueue generate_character_ref (M2) — a track created
// here simply sits at 'waiting_on_shared' until that step exists.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ jobId: string }> },
) {
  const { jobId } = await params
  const supabase = getSupabase()

  const { data: job, error: jobErr } = await supabase
    .from('content_jobs')
    .select('id, language')
    .eq('id', jobId)
    .single()

  if (jobErr || !job) {
    return NextResponse.json({ error: 'Job not found' }, { status: 404 })
  }

  const { data: pipeline, error: pErr } = await supabase
    .from('content_pipelines')
    .select('*')
    .eq('job_id', jobId)
    .eq('content_type', 'video')
    .maybeSingle()

  if (pErr) {
    return NextResponse.json({ error: pErr.message }, { status: 500 })
  }
  if (!pipeline) {
    return NextResponse.json({ error: 'No video pipeline for this job — call /video/generate first' }, { status: 404 })
  }

  // Idempotency: already approved (or further along) — return the existing
  // tracks instead of erroring, same pattern as blog/image's /generate.
  if (pipeline.status !== 'draft_ready') {
    if (pipeline.status === 'created' || pipeline.status === 'drafting') {
      return NextResponse.json(
        { error: `Script is not ready yet (pipeline status: ${pipeline.status})` },
        { status: 409 },
      )
    }
    const { data: tracks } = await supabase
      .from('content_language_tracks')
      .select('*')
      .eq('content_pipeline_id', pipeline.id)
    return NextResponse.json({ pipeline, tracks: tracks ?? [], created: false })
  }

  let body: { requestedLanguages?: unknown } = {}
  try {
    const text = await req.text()
    if (text) body = JSON.parse(text)
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const requestedLanguages = resolveRequestedLanguages(job.language as string, body.requestedLanguages)

  // CAS claim — loses gracefully to a concurrent approve call instead of
  // double-approving or creating duplicate tracks.
  const { data: claimed, error: claimErr } = await supabase
    .from('content_pipelines')
    .update({ status: 'approved', updated_at: new Date().toISOString() })
    .eq('id', pipeline.id)
    .eq('status', 'draft_ready')
    .select()
    .maybeSingle()

  if (claimErr) {
    return NextResponse.json({ error: claimErr.message }, { status: 500 })
  }
  if (!claimed) {
    // Lost the race — another request already approved this pipeline.
    const { data: current } = await supabase.from('content_pipelines').select('*').eq('id', pipeline.id).single()
    const { data: tracks } = await supabase
      .from('content_language_tracks')
      .select('*')
      .eq('content_pipeline_id', pipeline.id)
    return NextResponse.json({ pipeline: current ?? pipeline, tracks: tracks ?? [], created: false })
  }

  const { data: tracks, error: tErr } = await supabase
    .from('content_language_tracks')
    .insert(
      requestedLanguages.map((language) => ({
        content_pipeline_id: claimed.id,
        language,
        master_generation_used: claimed.current_generation,
      })),
    )
    .select()

  if (tErr) {
    if (tErr.code === UNIQUE_VIOLATION) {
      const { data: racedTracks } = await supabase
        .from('content_language_tracks')
        .select('*')
        .eq('content_pipeline_id', claimed.id)
      return NextResponse.json({ pipeline: claimed, tracks: racedTracks ?? [], created: false })
    }
    return NextResponse.json({ error: tErr.message }, { status: 500 })
  }

  return NextResponse.json({ pipeline: claimed, tracks: tracks ?? [], created: true })
}
