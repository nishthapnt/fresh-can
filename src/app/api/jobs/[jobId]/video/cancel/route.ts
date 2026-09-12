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
// genuinely terminal, successful state; content_jobs.status is a single
// flat field shared across every content type in a multi-type job (a
// known, pre-existing coarseness — see ARCHITECTURE.MD §6.2), so this only
// ever moves a job TOWARD 'failed', never away from a success it already
// reached.
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

// Reuses the existing 'failed' status rather than adding a new 'cancelled'
// value (no migration needed) — the worker's own polling queries
// (worker/src/index.ts's tickPipelines/tickTracks) already exclude
// 'failed' pipelines/tracks entirely, so this is a genuine, immediate stop,
// not just a UI-side hide. last_error is set to a distinguishing message so
// the dashboard (and anyone reading pipeline_steps/content_pipelines later)
// can tell "the user stopped this" apart from a real provider failure.
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
    .eq('content_type', 'video')
    .maybeSingle()

  if (pErr) {
    return NextResponse.json({ error: pErr.message }, { status: 500 })
  }
  if (!pipeline) {
    return NextResponse.json({ error: 'No video pipeline for this job' }, { status: 404 })
  }

  const { data: tracks, error: tErr } = await supabase
    .from('content_language_tracks')
    .select('id, status')
    .eq('content_pipeline_id', pipeline.id)
  if (tErr) {
    return NextResponse.json({ error: tErr.message }, { status: 500 })
  }

  const isTerminal = (status: string) => status === 'ready' || status === 'failed'
  // pipeline.status === 'ready' only means the SHARED visuals are done —
  // it says nothing about whether any language track (audio/captions/
  // render) is still in flight. Genuinely nothing-to-cancel requires the
  // pipeline AND every existing track to already be terminal.
  const nothingToCancel = isTerminal(pipeline.status) && (tracks ?? []).every((t) => isTerminal(t.status))
  if (nothingToCancel && pipeline.status === 'ready') {
    return NextResponse.json({ error: 'This video has already finished generating' }, { status: 409 })
  }

  // Only fail the shared pipeline itself if IT isn't done yet — a pipeline
  // that's genuinely 'ready' (visuals complete) stays 'ready' even when
  // cancelling in-flight tracks; there's nothing wrong with the shared
  // asset, only the per-language work is being stopped.
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

  // Every path reaching here means the video did NOT fully succeed (the
  // early 409 above is the only "genuinely all-ready" exit) — propagate
  // that to the job level so it can't get stuck showing "generating"
  // forever, the exact bug a live job hit (content_pipelines/
  // content_language_tracks had already failed, but content_jobs.status
  // never left 'generating' since nothing had ever written 'failed' there).
  await markJobFailedIfNotAlreadyTerminal(supabase, jobId)

  return NextResponse.json({ success: true })
}
