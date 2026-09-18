import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

function getSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  return createClient(url, key)
}

const CANCELLED_MESSAGE = 'Cancelled by user'

// Mirrors worker/src/db.ts's markJobFailedIfNotAlreadyTerminal — this route
// runs in the Next.js app, a separate package from the worker, so the logic
// is duplicated rather than imported. Never downgrades a job already at a
// genuinely terminal, successful state.
async function markJobFailedIfNotAlreadyTerminal(
  supabase: ReturnType<typeof getSupabase>,
  jobId: string,
): Promise<void> {
  const { data: job, error } = await supabase.from('content_jobs').select('status').eq('id', jobId).single()
  if (error) throw error
  if (job.status === 'ready' || job.status === 'posted' || job.status === 'failed') return
  const { error: updateErr } = await supabase
    .from('content_jobs')
    .update({ status: 'failed', updated_at: new Date().toISOString() })
    .eq('id', jobId)
  if (updateErr) throw updateErr
}

// Same pattern as video/cancel/route.ts — reuses the existing 'failed'
// status rather than adding a new 'cancelled' value (no migration needed).
// Blog is on Inngest now (src/inngest/functions/blog.ts): its retry loops
// re-fetch the pipeline/track row and check for 'failed' between every
// step, so this still stops it — at the same granularity as before (a
// step already in flight, e.g. mid-KIE-poll, still runs to completion; only
// the NEXT step is skipped). Not a true Inngest cancelOn signal (which
// could interrupt mid-step) — that's a possible future improvement, not
// required for parity with the old worker-poll-exclusion behavior.
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ jobId: string }> },
) {
  const { jobId } = await params
  const supabase = getSupabase()

  const { data: pipeline, error: pErr } = await supabase
    .from('content_pipelines')
    .select('*')
    .eq('job_id', jobId)
    .eq('content_type', 'blog')
    .maybeSingle()

  if (pErr) {
    return NextResponse.json({ error: pErr.message }, { status: 500 })
  }
  if (!pipeline) {
    return NextResponse.json({ error: 'No blog pipeline for this job' }, { status: 404 })
  }

  const { data: tracks, error: tErr } = await supabase
    .from('content_language_tracks')
    .select('id, status')
    .eq('content_pipeline_id', pipeline.id)
  if (tErr) {
    return NextResponse.json({ error: tErr.message }, { status: 500 })
  }

  const isTerminal = (status: string) => status === 'ready' || status === 'failed'
  // pipeline.status === 'ready' only means the shared hero/inline images are
  // done — it says nothing about whether a per-language draft is still
  // being written. Genuinely nothing-to-cancel requires the pipeline AND
  // every existing track to already be terminal.
  const nothingToCancel = isTerminal(pipeline.status) && (tracks ?? []).every((t) => isTerminal(t.status))
  if (nothingToCancel && pipeline.status === 'ready') {
    return NextResponse.json({ error: 'This blog post has already finished generating' }, { status: 409 })
  }

  // Only fail the shared pipeline itself if it isn't done yet — a pipeline
  // that's genuinely 'ready' (visuals complete) stays 'ready' even when
  // cancelling an in-flight per-language draft.
  if (!isTerminal(pipeline.status)) {
    const { error: updatePipelineErr } = await supabase
      .from('content_pipelines')
      .update({ status: 'failed', last_error: CANCELLED_MESSAGE, updated_at: new Date().toISOString() })
      .eq('id', pipeline.id)
    if (updatePipelineErr) {
      return NextResponse.json({ error: updatePipelineErr.message }, { status: 500 })
    }
  }

  const { error: updateTracksErr } = await supabase
    .from('content_language_tracks')
    .update({ status: 'failed', last_error: CANCELLED_MESSAGE, updated_at: new Date().toISOString() })
    .eq('content_pipeline_id', pipeline.id)
    .not('status', 'in', '(ready,failed)')

  if (updateTracksErr) {
    return NextResponse.json({ error: updateTracksErr.message }, { status: 500 })
  }

  // Every path reaching here means the blog post did NOT fully succeed (the
  // early 409 above is the only "genuinely all-ready" exit) — propagate that
  // to the job level so it can't get stuck showing "generating" forever.
  await markJobFailedIfNotAlreadyTerminal(supabase, jobId)

  return NextResponse.json({ success: true })
}
