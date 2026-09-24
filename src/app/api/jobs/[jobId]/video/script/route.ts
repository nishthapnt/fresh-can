import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { getVideoScenes, upsertVideoScenes } from '@/server/pipeline/db'
import { applyScriptEdits, buildScriptSummary } from '@/server/pipeline/steps/video/updateScript'

function getSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  return createClient(url, key)
}

// Lets the user edit each scene's narration text — the actual unit
// generate_script produces and the ONLY thing localize_script/
// synthesize_voice read (see updateScript.ts's own header) — while the
// pipeline is still at 'draft_ready'. Once approved, generate_character_ref/
// generate_scene_visual/the per-track render chain are already consuming the
// current scene plan, so edits are locked (matches video's existing
// single-approval-gate design, ARCHITECTURE.MD §6.4).
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ jobId: string }> },
) {
  const { jobId } = await params
  const supabase = getSupabase()

  let body: { scenes?: unknown } = {}
  try {
    const text = await req.text()
    if (text) body = JSON.parse(text)
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const { data: pipeline, error: pErr } = await supabase
    .from('content_pipelines')
    .select('*')
    .eq('job_id', jobId)
    .eq('content_type', 'video')
    .maybeSingle()
  if (pErr) return NextResponse.json({ error: pErr.message }, { status: 500 })
  if (!pipeline) return NextResponse.json({ error: 'No video pipeline for this job' }, { status: 404 })

  if (pipeline.status !== 'draft_ready') {
    return NextResponse.json(
      { error: `Script can only be edited while the pipeline is draft_ready (current: ${pipeline.status})` },
      { status: 409 },
    )
  }

  const scenes = await getVideoScenes(supabase, pipeline.id)
  if (scenes.length === 0) {
    return NextResponse.json({ error: 'No scenes found for this pipeline' }, { status: 404 })
  }

  const result = applyScriptEdits(scenes, body.scenes)
  if ('error' in result) {
    return NextResponse.json({ error: result.error }, { status: 400 })
  }

  const scenesByNumber = new Map(scenes.map((s) => [s.scene_number, s]))
  await upsertVideoScenes(supabase, {
    contentPipelineId: pipeline.id,
    generation: scenes[0].generation,
    scenes: result.updates.map((u) => {
      const original = scenesByNumber.get(u.sceneNumber)!
      return {
        sceneNumber: u.sceneNumber,
        visualDescription: original.visual_description,
        shotNotes: original.shot_notes,
        narrationIntent: u.narrationIntent,
        targetDurationMs: original.target_duration_ms,
      }
    }),
  })

  // Merge edits into the scene list this same request returns, so the
  // caller can update its own state without a second round trip.
  const updatesByNumber = new Map(result.updates.map((u) => [u.sceneNumber, u.narrationIntent]))
  const mergedScenes = scenes.map((s) =>
    updatesByNumber.has(s.scene_number) ? { ...s, narration_intent: updatesByNumber.get(s.scene_number) } : s,
  )

  // Keep the pre-approval "Script" summary card (content_drafts.draft_data.
  // script) consistent with the per-scene edits that actually drive
  // generation — see updateScript.ts's own header.
  const script = buildScriptSummary(
    mergedScenes.map((s) => ({
      scene_number: s.scene_number,
      narrationText:
        s.narration_intent && typeof (s.narration_intent as Record<string, unknown>).text === 'string'
          ? ((s.narration_intent as Record<string, unknown>).text as string)
          : '',
    })),
  )

  const { data: draft, error: dErr } = await supabase
    .from('content_drafts')
    .select('*')
    .eq('content_pipeline_id', pipeline.id)
    .maybeSingle()
  if (dErr) return NextResponse.json({ error: dErr.message }, { status: 500 })

  let updatedDraft = draft
  if (draft) {
    const { data: newDraft, error: uErr } = await supabase
      .from('content_drafts')
      .update({
        draft_data: { ...(draft.draft_data as Record<string, unknown>), script },
        updated_at: new Date().toISOString(),
      })
      .eq('id', draft.id)
      .select()
      .single()
    if (uErr) return NextResponse.json({ error: uErr.message }, { status: 500 })
    updatedDraft = newDraft
  }

  return NextResponse.json({ scenes: mergedScenes, draft: updatedDraft })
}
