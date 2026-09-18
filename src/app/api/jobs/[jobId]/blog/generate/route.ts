import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { inngest } from '@/inngest/client'

// Same pattern as the other server-side routes (draft/route.ts,
// n8n/trigger/route.ts): prefer the service-role key, fall back to anon.
// Unlike the legacy tables, the new pipeline tables have RLS actually
// enforced (confirmed live — see docs/IMPLEMENTATION_PLAN.md Phase 1), so
// this route only functions with a real SUPABASE_SERVICE_ROLE_KEY; the
// fallback exists for consistency with the rest of the codebase, not
// because it would actually work here.
function getSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  return createClient(url, key)
}

type BlogLanguage = 'EN' | 'FR'

// BOTH is a request-level concept only — resolved here into 1 or 2 discrete
// language tracks. The literal string 'BOTH' never reaches a track row.
// SPECIFICATIONS.md §5.
function resolveRequestedLanguages(
  jobLanguage: string,
  override?: unknown,
): BlogLanguage[] {
  if (Array.isArray(override)) {
    const valid = override.filter((l): l is BlogLanguage => l === 'EN' || l === 'FR')
    if (valid.length > 0) return Array.from(new Set(valid))
  }
  if (jobLanguage === 'BOTH') return ['EN', 'FR']
  if (jobLanguage === 'FR') return ['FR']
  return ['EN']
}

const UNIQUE_VIOLATION = '23505'

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
  // pipeline rather than erroring or creating a duplicate — covers both the
  // simple "called twice" case and, via the unique-violation catch below, a
  // genuine race between two near-simultaneous requests. Sends the Inngest
  // event again too (deterministic id, so Inngest dedupes a genuine repeat)
  // — self-heals a pipeline stuck at 'created' if the very first call
  // crashed after inserting the row but before the send below ever ran.
  const existing = await fetchPipelineWithTracks(supabase, jobId)
  if (existing) {
    await sendBlogGenerateEvent(existing.pipeline.id as string, jobId)
    return NextResponse.json({ ...existing, created: false })
  }

  const { data: pipeline, error: pErr } = await supabase
    .from('content_pipelines')
    .insert({ job_id: jobId, content_type: 'blog' })
    .select()
    .single()

  if (pErr) {
    if (pErr.code === UNIQUE_VIOLATION) {
      const racedResult = await fetchPipelineWithTracks(supabase, jobId)
      if (racedResult) {
        await sendBlogGenerateEvent(racedResult.pipeline.id as string, jobId)
        return NextResponse.json({ ...racedResult, created: false })
      }
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

  await sendBlogGenerateEvent(pipeline.id, jobId)

  return NextResponse.json({ pipeline, tracks: tracks ?? [], created: true })
}

// Deterministic event id (not random) so a duplicate send for the same
// pipeline — a client retry, or the self-heal call above — is deduped by
// Inngest instead of starting a second concurrent run. Belt-and-suspenders
// alongside blog.ts's own concurrency limit and claimPipeline's CAS.
async function sendBlogGenerateEvent(pipelineId: string, jobId: string): Promise<void> {
  await inngest.send({
    id: `${pipelineId}:blog.generate`,
    name: 'content/blog.generate',
    data: { pipelineId, jobId },
  })
}

async function fetchPipelineWithTracks(
  supabase: ReturnType<typeof getSupabase>,
  jobId: string,
): Promise<{ pipeline: Record<string, unknown>; tracks: Record<string, unknown>[] } | null> {
  const { data: pipeline } = await supabase
    .from('content_pipelines')
    .select('*')
    .eq('job_id', jobId)
    .eq('content_type', 'blog')
    .maybeSingle()

  if (!pipeline) return null

  const { data: tracks } = await supabase
    .from('content_language_tracks')
    .select('*')
    .eq('content_pipeline_id', pipeline.id)

  return { pipeline, tracks: tracks ?? [] }
}
