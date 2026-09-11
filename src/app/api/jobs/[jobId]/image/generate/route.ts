import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

// Same pattern as blog/generate/route.ts: prefer the service-role key — the
// new pipeline tables have RLS actually enforced.
function getSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  return createClient(url, key)
}

type ImageLanguage = 'EN' | 'FR'

// BOTH is a request-level concept only — resolved here into 1 or 2 discrete
// language tracks. This directly fixes the documented live bug
// (ARCHITECTURE.MD §17.4) where a BOTH image post produced one
// generated_content row with EN and FR captions concatenated into a single
// string. The literal string 'BOTH' never reaches a track row.
function resolveRequestedLanguages(
  jobLanguage: string,
  override?: unknown,
): ImageLanguage[] {
  if (Array.isArray(override)) {
    const valid = override.filter((l): l is ImageLanguage => l === 'EN' || l === 'FR')
    if (valid.length > 0) return Array.from(new Set(valid))
  }
  if (jobLanguage === 'BOTH') return ['EN', 'FR']
  if (jobLanguage === 'FR') return ['FR']
  return ['EN']
}

const UNIQUE_VIOLATION = '23505'

// Call this AFTER image_questions has been answered — that clarifying-Q&A
// step is unchanged and still goes through n8n (src/app/dashboard/new/page.tsx).
// This route only creates the pipeline/tracks; the worker does the actual
// photo + caption generation.
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

  let body: { requestedLanguages?: unknown } = {}
  try {
    const text = await req.text()
    if (text) body = JSON.parse(text)
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const requestedLanguages = resolveRequestedLanguages(job.language as string, body.requestedLanguages)

  // Idempotency: a second call for the same job returns the existing
  // pipeline rather than erroring or creating a duplicate.
  const existing = await fetchPipelineWithTracks(supabase, jobId)
  if (existing) {
    return NextResponse.json({ ...existing, created: false })
  }

  const { data: pipeline, error: pErr } = await supabase
    .from('content_pipelines')
    .insert({ job_id: jobId, content_type: 'image_post' })
    .select()
    .single()

  if (pErr) {
    if (pErr.code === UNIQUE_VIOLATION) {
      const racedResult = await fetchPipelineWithTracks(supabase, jobId)
      if (racedResult) return NextResponse.json({ ...racedResult, created: false })
    }
    return NextResponse.json({ error: pErr.message }, { status: 500 })
  }

  const { data: tracks, error: tErr } = await supabase
    .from('content_language_tracks')
    .insert(
      requestedLanguages.map((language) => ({
        content_pipeline_id: pipeline.id,
        language,
        master_generation_used: pipeline.current_generation,
      })),
    )
    .select()

  if (tErr) {
    return NextResponse.json({ error: tErr.message }, { status: 500 })
  }

  return NextResponse.json({ pipeline, tracks: tracks ?? [], created: true })
}

async function fetchPipelineWithTracks(
  supabase: ReturnType<typeof getSupabase>,
  jobId: string,
): Promise<{ pipeline: Record<string, unknown>; tracks: Record<string, unknown>[] } | null> {
  const { data: pipeline } = await supabase
    .from('content_pipelines')
    .select('*')
    .eq('job_id', jobId)
    .eq('content_type', 'image_post')
    .maybeSingle()

  if (!pipeline) return null

  const { data: tracks } = await supabase
    .from('content_language_tracks')
    .select('*')
    .eq('content_pipeline_id', pipeline.id)

  return { pipeline, tracks: tracks ?? [] }
}
