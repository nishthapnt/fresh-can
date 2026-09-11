import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

function getSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  return createClient(url, key)
}

// Blog has two independent regenerate scopes, unlike Image (which only has
// 'visual', one shared layer): 'visual' redoes the shared hero/inline
// images, 'copy' redoes one language track's text. Deliberately never
// conflated into one action — ARCHITECTURE.MD: "Conflating regenerate the
// words and regenerate the picture into one button... is the wrong
// implementation."
const VALID_SCOPES = ['visual', 'copy'] as const
type RegenerateScope = (typeof VALID_SCOPES)[number]
function isValidScope(v: unknown): v is RegenerateScope {
  return typeof v === 'string' && (VALID_SCOPES as readonly string[]).includes(v)
}

type BlogLanguage = 'EN' | 'FR'
function isBlogLanguage(v: unknown): v is BlogLanguage {
  return v === 'EN' || v === 'FR'
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ jobId: string }> },
) {
  const { jobId } = await params
  const supabase = getSupabase()

  let body: { scope?: unknown; lang?: unknown; instructions?: unknown } = {}
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

  const { data: pipeline, error: pErr } = await supabase
    .from('content_pipelines')
    .select('*')
    .eq('job_id', jobId)
    .eq('content_type', 'blog')
    .maybeSingle()
  if (pErr) return NextResponse.json({ error: pErr.message }, { status: 500 })
  if (!pipeline) return NextResponse.json({ error: 'No blog pipeline for this job' }, { status: 404 })

  if (scope === 'copy') {
    return regenerateCopy(supabase, pipeline, body)
  }
  return regenerateVisual(supabase, pipeline)
}

async function regenerateVisual(
  supabase: ReturnType<typeof getSupabase>,
  pipeline: Record<string, unknown>,
) {
  if (pipeline.status !== 'ready' && pipeline.status !== 'failed') {
    return NextResponse.json(
      {
        error: `Pipeline is '${pipeline.status}', can only regenerate visuals once shared generation has finished ('ready') or failed`,
      },
      { status: 409 },
    )
  }

  const { data: updatedPipeline, error: uErr } = await supabase
    .from('content_pipelines')
    .update({
      current_generation: (pipeline.current_generation as number) + 1,
      status: 'generating',
      retry_count: 0,
      last_error: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', pipeline.id as string)
    .select()
    .single()
  if (uErr) return NextResponse.json({ error: uErr.message }, { status: 500 })

  const { data: staleTracks, error: sErr } = await supabase
    .from('content_language_tracks')
    .update({ status: 'stale', updated_at: new Date().toISOString() })
    .eq('content_pipeline_id', pipeline.id as string)
    .in('status', ['ready', 'draft_ready'])
    .select()
  if (sErr) return NextResponse.json({ error: sErr.message }, { status: 500 })

  return NextResponse.json({ pipeline: updatedPipeline, staleTracks: staleTracks ?? [] })
}

// Redoes ONE language track's copy, keeping the shared hero/inline images
// (and every other track) completely untouched. Bumps ONLY this track's
// master_generation_used — a second, independent counter from the
// pipeline's current_generation — which is what makes generate_copy
// (worker/src/steps/generateCopy.ts) treat this as a fresh, never-succeeded
// attempt at the new generation, while generate_outline's already-succeeded
// result (looked up by the unchanged pipeline.current_generation) is reused
// as-is. Resetting straight to 'waiting_on_shared' (not 'generating') is
// deliberate: that's generate_copy's fresh-claim branch, which works
// regardless of last_error — landing on 'generating' with last_error
// cleared would make the track look "already in flight" and never get
// picked up again (see tracks/[lang]/retry/route.ts's comment on the same
// trap).
async function regenerateCopy(
  supabase: ReturnType<typeof getSupabase>,
  pipeline: Record<string, unknown>,
  body: { lang?: unknown; instructions?: unknown },
) {
  if (!isBlogLanguage(body.lang)) {
    return NextResponse.json({ error: 'lang must be EN or FR for scope: copy' }, { status: 400 })
  }
  const instructions = typeof body.instructions === 'string' && body.instructions.trim() ? body.instructions.trim() : null

  const { data: track, error: tErr } = await supabase
    .from('content_language_tracks')
    .select('*')
    .eq('content_pipeline_id', pipeline.id as string)
    .eq('language', body.lang)
    .maybeSingle()
  if (tErr) return NextResponse.json({ error: tErr.message }, { status: 500 })
  if (!track) return NextResponse.json({ error: `No ${body.lang} track for this job` }, { status: 404 })

  if (!['draft_ready', 'ready', 'stale'].includes(track.status)) {
    return NextResponse.json(
      {
        error: `Track is '${track.status}' — copy regeneration needs an existing successful draft. Use tracks/[lang]/retry for a 'failed' track instead.`,
      },
      { status: 409 },
    )
  }

  const { data: updatedTrack, error: uErr } = await supabase
    .from('content_language_tracks')
    .update({
      master_generation_used: (track.master_generation_used as number) + 1,
      status: 'waiting_on_shared',
      retry_count: 0,
      last_error: null,
      regen_instructions: instructions,
      updated_at: new Date().toISOString(),
    })
    .eq('id', track.id)
    .select()
    .single()
  if (uErr) return NextResponse.json({ error: uErr.message }, { status: 500 })

  return NextResponse.json({ track: updatedTrack })
}
