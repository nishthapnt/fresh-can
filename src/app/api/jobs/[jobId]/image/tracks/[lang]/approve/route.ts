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

// Unlike blog, finalize_image_content already writes generated_content
// directly (no edit-before-approve stage for image_post) — so approval here
// just flips the track to 'ready'.
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

  if (track.status !== 'draft_ready') {
    return NextResponse.json(
      { error: `Track is '${track.status}', must be 'draft_ready' to approve` },
      { status: 409 },
    )
  }

  const { data: updatedTrack, error: uErr } = await supabase
    .from('content_language_tracks')
    .update({ status: 'ready', updated_at: new Date().toISOString() })
    .eq('id', track.id)
    .select()
    .single()
  if (uErr) return NextResponse.json({ error: uErr.message }, { status: 500 })

  return NextResponse.json({ track: updatedTrack })
}
