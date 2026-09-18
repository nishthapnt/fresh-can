import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { inngest } from '@/inngest/client'

function getSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  return createClient(url, key)
}

// Video has two independent regenerate scopes, same reasoning as Blog's
// 'visual'/'copy' split (ARCHITECTURE.MD §10.1): "script" redoes the
// semantic scene plan itself (and therefore every language's narration,
// which was keyed off it); "visuals" redoes only the character reference +
// per-scene images/clips, leaving the scene plan and narration text
// untouched. Deliberately never conflated into one action — a picture tweak
// must never force a full script/narration rewrite, or vice versa.
const VALID_SCOPES = ['script', 'visuals'] as const
type RegenerateScope = (typeof VALID_SCOPES)[number]
function isValidScope(v: unknown): v is RegenerateScope {
  return typeof v === 'string' && (VALID_SCOPES as readonly string[]).includes(v)
}

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

  const scope = body.scope ?? 'visuals'
  if (!isValidScope(scope)) {
    return NextResponse.json({ error: `scope must be one of: ${VALID_SCOPES.join(', ')}` }, { status: 400 })
  }
  const instructions =
    typeof body.instructions === 'string' && body.instructions.trim() ? body.instructions.trim() : null

  const { data: pipeline, error: pErr } = await supabase
    .from('content_pipelines')
    .select('*')
    .eq('job_id', jobId)
    .eq('content_type', 'video')
    .maybeSingle()
  if (pErr) return NextResponse.json({ error: pErr.message }, { status: 500 })
  if (!pipeline) return NextResponse.json({ error: 'No video pipeline for this job' }, { status: 404 })

  if (scope === 'script') {
    return regenerateScript(supabase, pipeline, instructions)
  }
  return regenerateVisuals(supabase, pipeline, instructions)
}

// scope: "script" — the semantic scene plan itself is being redone. Full
// reset: bumps current_generation, sends the pipeline back to 'created' so
// generate_script runs fresh (writing a brand-new scene plan at the new
// generation, worker/src/steps/generateScript.ts), and resets EVERY
// language track back to 'waiting_on_shared' — audio/captions were all
// keyed off the old scene plan's narration_intent, so none of it can be
// preserved (ARCHITECTURE.MD §10.1).
async function regenerateScript(
  supabase: ReturnType<typeof getSupabase>,
  pipeline: Record<string, unknown>,
  instructions: string | null,
) {
  const newGeneration = (pipeline.current_generation as number) + 1

  const { data: updatedPipeline, error: uErr } = await supabase
    .from('content_pipelines')
    .update({
      current_generation: newGeneration,
      status: 'created',
      current_step: null,
      retry_count: 0,
      last_error: null,
      scenes_total: null,
      scenes_visuals_ready_count: 0,
      regen_instructions: instructions,
      updated_at: new Date().toISOString(),
    })
    .eq('id', pipeline.id as string)
    .select()
    .single()
  if (uErr) return NextResponse.json({ error: uErr.message }, { status: 500 })

  const { data: resetTracks, error: tErr } = await supabase
    .from('content_language_tracks')
    .update({
      status: 'waiting_on_shared',
      master_generation_used: newGeneration,
      current_step: null,
      retry_count: 0,
      last_error: null,
      updated_at: new Date().toISOString(),
    })
    .eq('content_pipeline_id', pipeline.id as string)
    .select()
  if (tErr) return NextResponse.json({ error: tErr.message }, { status: 500 })

  // Video runs on Inngest now (src/inngest/functions/video.ts) — nothing
  // polls for these status changes anymore. Generation-scoped ids (not just
  // pipeline/track id) so this regen's events are distinct from the
  // original send and aren't deduped away.
  await inngest.send({
    id: `${updatedPipeline.id}:video.generate:gen${newGeneration}`,
    name: 'content/video.generate',
    data: { pipelineId: updatedPipeline.id, jobId: updatedPipeline.job_id },
  })
  if (resetTracks && resetTracks.length > 0) {
    await inngest.send(
      resetTracks.map((track) => ({
        id: `${track.id}:video.track.render:gen${newGeneration}`,
        name: 'content/video.track.render' as const,
        data: { trackId: track.id, pipelineId: updatedPipeline.id, jobId: updatedPipeline.job_id },
      })),
    )
  }

  return NextResponse.json({ pipeline: updatedPipeline, tracks: resetTracks ?? [] })
}

// scope: "visuals" — only reachable once the shared layer has actually
// finished ('ready') or died trying ('failed'); redoing it while it's still
// mid-flight doesn't make sense. The scene PLAN is not rewritten (unchanged
// from whatever generation generate_script last actually ran at — see
// worker/src/db.ts's getVideoScenes, which reads "latest generation
// present" rather than an exact match for exactly this reason), only
// character_ref/scene_image/scene_video_clip get regenerated, at the newly
// bumped generation.
//
// Simplification, documented rather than hidden: language tracks are fully
// reset here too (not left "stale" for a render-only pass) — a track's
// audio/captions are tied to the SAME master_generation_used this bump
// advances, and preserving them across a visuals regen would need a
// second, independent "audio generation" fence distinct from this
// "visuals generation" one, plus render reads that tolerate audio being
// older than the visuals it's paired with. That's a real, buildable
// optimization (the stale/re-render-only path ARCHITECTURE.MD §6.5
// describes) — not implemented yet in favor of a simpler, correctly-
// working full reset. Cost: a modest amount of re-spent ElevenLabs/
// AssemblyAI usage per visuals regen. Never a correctness risk.
async function regenerateVisuals(
  supabase: ReturnType<typeof getSupabase>,
  pipeline: Record<string, unknown>,
  instructions: string | null,
) {
  if (pipeline.status !== 'ready' && pipeline.status !== 'failed') {
    return NextResponse.json(
      {
        error: `Pipeline is '${pipeline.status}' — can only regenerate visuals once the shared layer has finished ('ready') or failed`,
      },
      { status: 409 },
    )
  }

  const { data: allScenes, error: scenesErr } = await supabase
    .from('video_scenes')
    .select('generation')
    .eq('content_pipeline_id', pipeline.id as string)
    .order('generation', { ascending: false })
  if (scenesErr) return NextResponse.json({ error: scenesErr.message }, { status: 500 })
  const latestGeneration = allScenes?.[0]?.generation
  const scenesTotal = (allScenes ?? []).filter((s) => s.generation === latestGeneration).length
  if (scenesTotal === 0) {
    return NextResponse.json(
      { error: 'No scene plan found for this pipeline — cannot regenerate visuals' },
      { status: 409 },
    )
  }

  const newGeneration = (pipeline.current_generation as number) + 1

  const { data: updatedPipeline, error: uErr } = await supabase
    .from('content_pipelines')
    .update({
      current_generation: newGeneration,
      // Skips 'created'/'drafting'/'approved' entirely — generate_script
      // never reruns for this scope, so there's nothing to draft or
      // approve again. Jumping straight to 'generating' is the same
      // shortcut blog/image/route.ts's regenerateVisual already uses:
      // generateCharacterRef/generateSceneVisual's claim logic proceeds
      // directly off status === 'generating', regardless of how it got
      // there.
      status: 'generating',
      current_step: null,
      retry_count: 0,
      last_error: null,
      scenes_total: scenesTotal,
      scenes_visuals_ready_count: 0,
      regen_instructions: instructions,
      updated_at: new Date().toISOString(),
    })
    .eq('id', pipeline.id as string)
    .select()
    .single()
  if (uErr) return NextResponse.json({ error: uErr.message }, { status: 500 })

  const { data: resetTracks, error: tErr } = await supabase
    .from('content_language_tracks')
    .update({
      status: 'waiting_on_shared',
      master_generation_used: newGeneration,
      current_step: null,
      retry_count: 0,
      last_error: null,
      updated_at: new Date().toISOString(),
    })
    .eq('content_pipeline_id', pipeline.id as string)
    .select()
  if (tErr) return NextResponse.json({ error: tErr.message }, { status: 500 })

  // Video runs on Inngest now (src/inngest/functions/video.ts) — nothing
  // polls for these status changes anymore. Generation-scoped ids so this
  // regen's events are distinct from the original approval's sends.
  await inngest.send({
    id: `${updatedPipeline.id}:video.approve:gen${newGeneration}`,
    name: 'content/video.approve',
    data: { pipelineId: updatedPipeline.id, jobId: updatedPipeline.job_id },
  })
  if (resetTracks && resetTracks.length > 0) {
    await inngest.send(
      resetTracks.map((track) => ({
        id: `${track.id}:video.track.render:gen${newGeneration}`,
        name: 'content/video.track.render' as const,
        data: { trackId: track.id, pipelineId: updatedPipeline.id, jobId: updatedPipeline.job_id },
      })),
    )
  }

  return NextResponse.json({ pipeline: updatedPipeline, tracks: resetTracks ?? [] })
}
