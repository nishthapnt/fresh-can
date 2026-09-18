import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { inngest } from '@/inngest/client'

// Same pattern as blog/image's generate routes: prefer the service-role key
// — the pipeline tables have RLS actually enforced.
function getSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  return createClient(url, key)
}

const UNIQUE_VIOLATION = '23505'

// Unlike blog/image's generate routes, this one creates ONLY the
// content_pipelines row — no content_language_tracks yet. Video gates all
// language-specific work behind POST /video/approve (ARCHITECTURE.MD §6.4:
// the script must be reviewed and locked before any expensive per-scene
// generation is requested), so "how many languages were requested" isn't
// known or relevant until that call. The worker (generateScript) picks this
// pipeline up once created and writes the master script + scene plan.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ jobId: string }> },
) {
  const { jobId } = await params
  const supabase = getSupabase()

  const { data: job, error: jobErr } = await supabase
    .from('content_jobs')
    .select('id')
    .eq('id', jobId)
    .single()

  if (jobErr || !job) {
    return NextResponse.json({ error: 'Job not found' }, { status: 404 })
  }

  // Idempotency: a second call for the same job returns the existing
  // pipeline rather than erroring or creating a duplicate. Sends the Inngest
  // event again too (deterministic id, so Inngest dedupes a genuine repeat)
  // — self-heals a pipeline stuck at 'created' if the very first call
  // crashed after inserting the row but before the send below ever ran.
  const { data: existing } = await supabase
    .from('content_pipelines')
    .select('*')
    .eq('job_id', jobId)
    .eq('content_type', 'video')
    .maybeSingle()
  if (existing) {
    await sendVideoGenerateEvent(existing.id as string, jobId)
    return NextResponse.json({ pipeline: existing, created: false })
  }

  const { data: pipeline, error: pErr } = await supabase
    .from('content_pipelines')
    .insert({ job_id: jobId, content_type: 'video' })
    .select()
    .single()

  if (pErr) {
    if (pErr.code === UNIQUE_VIOLATION) {
      const { data: raced } = await supabase
        .from('content_pipelines')
        .select('*')
        .eq('job_id', jobId)
        .eq('content_type', 'video')
        .maybeSingle()
      if (raced) {
        await sendVideoGenerateEvent(raced.id as string, jobId)
        return NextResponse.json({ pipeline: raced, created: false })
      }
    }
    return NextResponse.json({ error: pErr.message }, { status: 500 })
  }

  await sendVideoGenerateEvent(pipeline.id, jobId)

  return NextResponse.json({ pipeline, created: true })
}

// Deterministic event id (not random) so a duplicate send for the same
// pipeline — a client retry, or the self-heal call above — is deduped by
// Inngest instead of starting a second concurrent run. Belt-and-suspenders
// alongside video.ts's own concurrency limit and claimPipeline's CAS.
async function sendVideoGenerateEvent(pipelineId: string, jobId: string): Promise<void> {
  await inngest.send({
    id: `${pipelineId}:video.generate`,
    name: 'content/video.generate',
    data: { pipelineId, jobId },
  })
}
