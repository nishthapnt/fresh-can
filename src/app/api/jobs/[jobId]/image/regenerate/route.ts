import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

function getSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  return createClient(url, key)
}

// image_post has exactly one shared layer (the photo) — 'visual' is the
// only legal scope, same reasoning as blog/regenerate/route.ts.
const VALID_SCOPES = ['visual'] as const
type RegenerateScope = (typeof VALID_SCOPES)[number]
function isValidScope(v: unknown): v is RegenerateScope {
  return typeof v === 'string' && (VALID_SCOPES as readonly string[]).includes(v)
}

// Bumps content_pipelines.current_generation. Status target depends on the
// job's image_style: 'photo' goes straight to 'generating' — unlike blog,
// image_post has no drafting step to pass through, runGeneratePhoto
// (worker/src/steps/generatePhoto.ts) handles a pipeline already in
// 'generating' with no existing asset for the new generation as a fresh
// first attempt. 'infographic' instead targets 'created', so tickPipelines
// (worker/src/index.ts) re-runs generate_ad_copy for the bumped generation
// too — without this, a regenerated infographic photo would render a
// brand-new headline/subtitle sourced from the OLD generation's ad copy (or
// worse, the crude topic-truncation fallback if none existed), disconnected
// from whatever the regenerate instructions actually asked for. Per-language
// captions are untouched either way: they're keyed off
// content_language_tracks.master_generation_used, which this route
// deliberately does NOT bump, so a picture change never forces a caption
// rewrite. ready/draft_ready tracks flip to 'stale' — re-approving them (via
// tracks/[lang]/approve) picks up the new shared photo.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ jobId: string }> },
) {
  const { jobId } = await params
  const supabase = getSupabase()

  let body: { scope?: unknown; instructions?: unknown } = {}
  try {
    const text = await req.text()
    if (text) body = JSON.parse(text)
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const scope = body.scope ?? 'visual'
  if (!isValidScope(scope)) {
    return NextResponse.json({ error: `scope must be one of: ${VALID_SCOPES.join(', ')}` }, { status: 400 })
  }
  const instructions =
    typeof body.instructions === 'string' && body.instructions.trim() ? body.instructions.trim() : null

  const [{ data: pipeline, error: pErr }, { data: job, error: jErr }] = await Promise.all([
    supabase
      .from('content_pipelines')
      .select('*')
      .eq('job_id', jobId)
      .eq('content_type', 'image_post')
      .maybeSingle(),
    supabase.from('content_jobs').select('image_style').eq('id', jobId).maybeSingle(),
  ])
  if (pErr) return NextResponse.json({ error: pErr.message }, { status: 500 })
  if (!pipeline) return NextResponse.json({ error: 'No image pipeline for this job' }, { status: 404 })
  if (jErr) return NextResponse.json({ error: jErr.message }, { status: 500 })

  if (pipeline.status !== 'ready' && pipeline.status !== 'failed') {
    return NextResponse.json(
      {
        error: `Pipeline is '${pipeline.status}', can only regenerate the photo once shared generation has finished ('ready') or failed`,
      },
      { status: 409 },
    )
  }

  const nextStatus = job?.image_style === 'infographic' ? 'created' : 'generating'

  const { data: updatedPipeline, error: uErr } = await supabase
    .from('content_pipelines')
    .update({
      current_generation: pipeline.current_generation + 1,
      status: nextStatus,
      retry_count: 0,
      last_error: null,
      // Read by photoScene() in worker/src/index.ts — the Regenerate
      // dialog's "extra instructions" (e.g. "warmer colors").
      regen_instructions: instructions,
      updated_at: new Date().toISOString(),
    })
    .eq('id', pipeline.id)
    .select()
    .single()
  if (uErr) return NextResponse.json({ error: uErr.message }, { status: 500 })

  const { data: staleTracks, error: sErr } = await supabase
    .from('content_language_tracks')
    .update({ status: 'stale', updated_at: new Date().toISOString() })
    .eq('content_pipeline_id', pipeline.id)
    .in('status', ['ready', 'draft_ready'])
    .select()
  if (sErr) return NextResponse.json({ error: sErr.message }, { status: 500 })

  return NextResponse.json({ pipeline: updatedPipeline, staleTracks: staleTracks ?? [] })
}
