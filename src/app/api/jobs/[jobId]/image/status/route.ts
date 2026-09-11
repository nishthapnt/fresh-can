import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

function getSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  return createClient(url, key)
}

// Lightweight polling endpoint, same shape as blog/status/route.ts. Returns
// the pipeline's shared state plus every requested language track and the
// shared photo asset for the current generation, in one round trip.
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ jobId: string }> },
) {
  const { jobId } = await params
  const supabase = getSupabase()

  const { data: pipeline, error: pErr } = await supabase
    .from('content_pipelines')
    .select('*')
    .eq('job_id', jobId)
    .eq('content_type', 'image_post')
    .maybeSingle()

  if (pErr) {
    return NextResponse.json({ error: pErr.message }, { status: 500 })
  }
  if (!pipeline) {
    return NextResponse.json({ error: 'No image pipeline for this job' }, { status: 404 })
  }

  const [{ data: tracks, error: tErr }, { data: visualAssets, error: vErr }] = await Promise.all([
    supabase.from('content_language_tracks').select('*').eq('content_pipeline_id', pipeline.id),
    supabase
      .from('content_visual_assets')
      .select('*')
      .eq('content_pipeline_id', pipeline.id)
      .eq('generation', pipeline.current_generation),
  ])

  if (tErr) return NextResponse.json({ error: tErr.message }, { status: 500 })
  if (vErr) return NextResponse.json({ error: vErr.message }, { status: 500 })

  return NextResponse.json({
    pipeline,
    tracks: tracks ?? [],
    visualAssets: visualAssets ?? [],
  })
}
