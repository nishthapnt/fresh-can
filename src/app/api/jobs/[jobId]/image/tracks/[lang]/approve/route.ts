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
// mainly flips the track to 'ready'. The one thing it still must do: if the
// track is 'stale' (a visual regenerate happened after a prior approval),
// reconcile generated_content's photo URL against the CURRENT shared photo
// asset, since finalize_image_content wrote it against whichever generation
// was current at the time and never re-runs on its own for a stale track
// (same "no automatic re-render — user re-approves" design as blog).
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

  if (track.status !== 'draft_ready' && track.status !== 'stale') {
    return NextResponse.json(
      { error: `Track is '${track.status}', must be 'draft_ready' or 'stale' to approve` },
      { status: 409 },
    )
  }

  if (track.status === 'stale') {
    const [{ data: visualAssets, error: vErr }, { data: job, error: jErr }] = await Promise.all([
      supabase
        .from('content_visual_assets')
        .select('*')
        .eq('content_pipeline_id', pipeline.id)
        .eq('generation', pipeline.current_generation),
      supabase.from('content_jobs').select('image_style').eq('id', jobId).maybeSingle(),
    ])
    if (vErr) return NextResponse.json({ error: vErr.message }, { status: 500 })
    if (jErr) return NextResponse.json({ error: jErr.message }, { status: 500 })

    const photo = (visualAssets ?? []).find((a) => a.asset_type === 'photo')
    if (photo?.file_url) {
      const { data: existing } = await supabase
        .from('generated_content')
        .select('output_data')
        .eq('job_id', jobId)
        .eq('content_type', 'image_post')
        .eq('language', lang)
        .maybeSingle()

      const existingOutput = (existing?.output_data as Record<string, unknown> | null) ?? {}
      let headlineText = existingOutput.headline_text ?? null
      let subtitleText = existingOutput.subtitle_text ?? null

      // For 'infographic' jobs, the regenerated photo has a FRESH headline/
      // subtitle baked in (worker/src/steps/generateAdCopy.ts re-runs for the
      // bumped generation) — without re-reading it here, this card kept
      // showing the PREVIOUS generation's text after a photo regen, mismatched
      // against what's actually rendered on the new image.
      if (job?.image_style === 'infographic') {
        const { data: adCopyStep } = await supabase
          .from('pipeline_steps')
          .select('output_snapshot')
          .eq('content_pipeline_id', pipeline.id)
          .eq('step_name', 'generate_ad_copy')
          .eq('generation', pipeline.current_generation)
          .eq('status', 'succeeded')
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle()
        const snap = adCopyStep?.output_snapshot as { headline?: unknown; subtitle?: unknown } | null
        if (typeof snap?.headline === 'string' && snap.headline.trim()) headlineText = snap.headline.trim()
        if (typeof snap?.subtitle === 'string' && snap.subtitle.trim()) subtitleText = snap.subtitle.trim()
      }

      const { error: gErr } = await supabase
        .from('generated_content')
        .update({
          file_url: photo.file_url,
          image_url: photo.file_url,
          output_data: { ...existingOutput, image_url: photo.file_url, headline_text: headlineText, subtitle_text: subtitleText },
          updated_at: new Date().toISOString(),
        })
        .eq('job_id', jobId)
        .eq('content_type', 'image_post')
        .eq('language', lang)
      if (gErr) return NextResponse.json({ error: gErr.message }, { status: 500 })
    }
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
