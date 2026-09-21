import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { inngest } from '@/inngest/client'

function getSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  return createClient(url, key)
}

type VideoLanguage = 'EN' | 'FR'
function isVideoLanguage(v: string): v is VideoLanguage {
  return v === 'EN' || v === 'FR'
}

// Retries a failed video language track. Unlike blog (see
// blog/tracks/[lang]/retry/route.ts, which this mirrors) — where 'failed'
// always means the same one thing ("resume generate_copy") — a video track
// can fail at any of localize_script, synthesize_voice, transcribe_captions,
// or render (src/inngest/functions/video.ts's videoTrackRender), so there's
// no single "resume stage" to reset to the way blog has.
//
// Resets all the way back to 'waiting_on_shared' (the track's true starting
// state) regardless of which stage actually failed, rather than trying to
// figure out the exact furthest-completed stage — safe and cheap because
// every stage's own run function checks hasSucceededStep BEFORE doing any
// real (paid) work: localizeScript.ts/synthesizeVoice.ts/transcribeAudio.ts
// all short-circuit (and, where relevant, self-heal their own claimTrack
// transition) the moment they see their step already succeeded, so
// resetting further back than strictly necessary costs a few extra cheap DB
// writes and Inngest step invocations, never a duplicate OpenAI/ElevenLabs/
// AssemblyAI/KIE.ai/upload-post.com charge. This exact reset-and-resend
// pattern is also the one transcribeAudio.ts's own header already documents
// as a supported manual-recovery path ("confirmed live 2026-09-19 during a
// manual recovery").
//
// retry_count reset to 0 (fresh attempt-budget cycle, same reasoning as
// blog's route) and last_error cleared — unlike blog, video's
// 'waiting_on_shared' branch (localizeScript.ts) claims unconditionally
// without checking last_error/backoff at all, so there's no "invisible to
// the next tick" risk blog's comment warns about; clearing it here just
// keeps the dashboard from showing a stale error while the retry is in
// flight. current_step cleared too, since 'rendering' (or whichever stage
// it failed at) no longer reflects where the track actually is.
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ jobId: string; lang: string }> },
) {
  const { jobId, lang } = await params
  if (!isVideoLanguage(lang)) {
    return NextResponse.json({ error: 'lang must be EN or FR' }, { status: 400 })
  }

  const supabase = getSupabase()

  const { data: pipeline, error: pErr } = await supabase
    .from('content_pipelines')
    .select('*')
    .eq('job_id', jobId)
    .eq('content_type', 'video')
    .maybeSingle()
  if (pErr) return NextResponse.json({ error: pErr.message }, { status: 500 })
  if (!pipeline) return NextResponse.json({ error: 'No video pipeline for this job' }, { status: 404 })

  const { data: track, error: tErr } = await supabase
    .from('content_language_tracks')
    .select('*')
    .eq('content_pipeline_id', pipeline.id)
    .eq('language', lang)
    .maybeSingle()
  if (tErr) return NextResponse.json({ error: tErr.message }, { status: 500 })
  if (!track) return NextResponse.json({ error: `No ${lang} track for this job` }, { status: 404 })

  if (track.status !== 'failed') {
    return NextResponse.json(
      { error: `Track is '${track.status}', can only retry a 'failed' track` },
      { status: 409 },
    )
  }

  // Compare-and-swap on status, mirroring src/server/pipeline/db.ts's
  // claimTrack — guards against a concurrent retry click or an in-flight
  // Inngest run racing in.
  const { data: updated, error: uErr } = await supabase
    .from('content_language_tracks')
    .update({
      status: 'waiting_on_shared',
      retry_count: 0,
      last_error: null,
      current_step: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', track.id)
    .eq('status', 'failed')
    .select()
    .maybeSingle()
  if (uErr) return NextResponse.json({ error: uErr.message }, { status: 500 })
  if (!updated) {
    return NextResponse.json({ error: 'Track status changed concurrently, retry not applied' }, { status: 409 })
  }

  // content_jobs.status is set to 'generating' exactly once, at approval
  // (src/app/dashboard/jobs/[job_id]/page.tsx's onApprove), and after that
  // only ever moves to 'ready' (markJobReadyIfAllContentComplete) or
  // 'failed' (markJobFailedIfNotAlreadyTerminal, cascaded from
  // markTrackFailed) — nothing else ever resets it. Without this, the
  // dashboard's top-level job badge/GlobalProgressBar (which only shows
  // jobs with status='generating') stay stuck on "Failed" even after a
  // successful track retry genuinely puts the job back in progress —
  // confirmed live 2026-09-21: a retried track reached 'rendering' while
  // content_jobs.status was still 'failed' from the original terminal
  // failure. `.eq('status', 'failed')` guards against clobbering some
  // other legitimate state in the (shouldn't-happen) case this job's
  // status changed to something else between the reads above.
  await supabase
    .from('content_jobs')
    .update({ status: 'generating', updated_at: new Date().toISOString() })
    .eq('id', jobId)
    .eq('status', 'failed')

  // The CAS above (not this send) is what prevents a double-fire from a
  // raced concurrent retry click, so updated_at (fresh on every successful
  // CAS) is a safe, simple id suffix here — same reasoning blog's route uses.
  await inngest.send({
    id: `${updated.id}:video.track.render:retry-${updated.updated_at}`,
    name: 'content/video.track.render',
    data: { trackId: updated.id, pipelineId: pipeline.id, jobId },
  })

  return NextResponse.json({ track: updated })
}
