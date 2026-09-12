import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

function getSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  return createClient(url, key)
}

// Lightweight polling endpoint — ARCHITECTURE.MD §9. Returns the pipeline's
// shared state, the master script draft, its scene plan, every language
// track, and (once M2+ exist) the shared visual assets for the current
// generation — one round trip, same shape as blog/image's status route.
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
    .eq('content_type', 'video')
    .maybeSingle()

  if (pErr) {
    return NextResponse.json({ error: pErr.message }, { status: 500 })
  }
  if (!pipeline) {
    return NextResponse.json({ error: 'No video pipeline for this job' }, { status: 404 })
  }

  const [
    { data: draft, error: dErr },
    { data: scenes, error: sErr },
    { data: tracks, error: tErr },
    { data: visualAssets, error: vErr },
  ] = await Promise.all([
    supabase
      .from('content_drafts')
      .select('*')
      .eq('content_pipeline_id', pipeline.id)
      .maybeSingle(),
    // NOT filtered by pipeline.current_generation — a visuals-only
    // regenerate bumps that without ever rewriting the scene plan (it
    // didn't change), so an exact match would show an empty scene list
    // after every visuals regen. Fetch all and keep only the latest
    // generation actually present, mirroring worker/src/db.ts's
    // getVideoScenes (duplicated here since this route can't import
    // worker code — separate package).
    supabase
      .from('video_scenes')
      .select('*')
      .eq('content_pipeline_id', pipeline.id)
      .order('generation', { ascending: false })
      .order('scene_number', { ascending: true }),
    supabase.from('content_language_tracks').select('*').eq('content_pipeline_id', pipeline.id),
    supabase
      .from('content_visual_assets')
      .select('*')
      .eq('content_pipeline_id', pipeline.id)
      .eq('generation', pipeline.current_generation),
  ])

  if (dErr) return NextResponse.json({ error: dErr.message }, { status: 500 })
  if (sErr) return NextResponse.json({ error: sErr.message }, { status: 500 })
  if (tErr) return NextResponse.json({ error: tErr.message }, { status: 500 })
  if (vErr) return NextResponse.json({ error: vErr.message }, { status: 500 })

  const latestGeneration = scenes?.[0]?.generation
  const currentScenes = (scenes ?? []).filter((s) => s.generation === latestGeneration)

  return NextResponse.json({
    pipeline,
    draft: draft ?? null,
    scenes: currentScenes,
    tracks: tracks ?? [],
    visualAssets: visualAssets ?? [],
  })
}
