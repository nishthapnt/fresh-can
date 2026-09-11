import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

function getSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  return createClient(url, key)
}

type ImageLanguage = 'EN' | 'FR'
function isImageLanguage(v: string): v is ImageLanguage {
  return v === 'EN' || v === 'FR'
}

// Retries a failed language track. image_post tracks only ever fail inside
// generate_caption (worker/src/steps/generateCaption.ts, after exhausting
// MAX_ATTEMPTS.openai) — so 'failed' always means "resume generate_caption".
//
// retry_count is reset to 0 (not cleared to null) so the worker's next tick
// treats this as a fresh attempt cycle immediately instead of waiting out
// the exhausted run's exponential backoff (worker/src/lib/backoff.ts
// isReadyToRetry — retryCount=0 means "ready now"). last_error is left
// as-is deliberately — generateCaption.ts's retry branch treats a
// 'generating' track with no last_error as "already in flight, not our
// turn", so clearing it here would make the track invisible to the next tick.
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ jobId: string; lang: string }> },
) {
  const { jobId, lang } = await params
  if (!isImageLanguage(lang)) {
    return NextResponse.json({ error: 'lang must be EN or FR' }, { status: 400 })
  }

  const supabase = getSupabase()

  const { data: pipeline, error: pErr } = await supabase
    .from('content_pipelines')
    .select('*')
    .eq('job_id', jobId)
    .eq('content_type', 'image_post')
    .maybeSingle()
  if (pErr) return NextResponse.json({ error: pErr.message }, { status: 500 })
  if (!pipeline) return NextResponse.json({ error: 'No image pipeline for this job' }, { status: 404 })

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

  // Compare-and-swap on status, mirroring worker/src/db.ts's claimTrack —
  // guards against a concurrent retry click or a worker tick racing in.
  const { data: updated, error: uErr } = await supabase
    .from('content_language_tracks')
    .update({ status: 'generating', retry_count: 0, updated_at: new Date().toISOString() })
    .eq('id', track.id)
    .eq('status', 'failed')
    .select()
    .maybeSingle()
  if (uErr) return NextResponse.json({ error: uErr.message }, { status: 500 })
  if (!updated) {
    return NextResponse.json({ error: 'Track status changed concurrently, retry not applied' }, { status: 409 })
  }

  return NextResponse.json({ track: updated })
}
