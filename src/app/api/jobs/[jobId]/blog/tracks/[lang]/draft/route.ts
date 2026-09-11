import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

// Same pattern as generate/route.ts and status/route.ts: prefer the
// service-role key — the new pipeline tables have RLS actually enforced.
function getSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  return createClient(url, key)
}

type BlogLanguage = 'EN' | 'FR'
function isBlogLanguage(v: string): v is BlogLanguage {
  return v === 'EN' || v === 'FR'
}

// Draft-editor read endpoint for one language track (M5,
// docs/IMPLEMENTATION_PLAN.md). draft.draft_data is written by
// worker/src/steps/finalizeDraft.ts in the exact shape
// blogEditFromDraft() in src/app/dashboard/jobs/[job_id]/page.tsx expects.
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ jobId: string; lang: string }> },
) {
  const { jobId, lang } = await params
  if (!isBlogLanguage(lang)) {
    return NextResponse.json({ error: 'lang must be EN or FR' }, { status: 400 })
  }

  const supabase = getSupabase()

  const { data: pipeline, error: pErr } = await supabase
    .from('content_pipelines')
    .select('*')
    .eq('job_id', jobId)
    .eq('content_type', 'blog')
    .maybeSingle()
  if (pErr) return NextResponse.json({ error: pErr.message }, { status: 500 })
  if (!pipeline) return NextResponse.json({ error: 'No blog pipeline for this job' }, { status: 404 })

  const { data: track, error: tErr } = await supabase
    .from('content_language_tracks')
    .select('*')
    .eq('content_pipeline_id', pipeline.id)
    .eq('language', lang)
    .maybeSingle()
  if (tErr) return NextResponse.json({ error: tErr.message }, { status: 500 })
  if (!track) return NextResponse.json({ error: `No ${lang} track for this job` }, { status: 404 })

  const { data: draft, error: dErr } = await supabase
    .from('content_drafts')
    .select('*')
    .eq('job_id', jobId)
    .eq('content_type', 'blog')
    .eq('language', lang)
    .maybeSingle()
  if (dErr) return NextResponse.json({ error: dErr.message }, { status: 500 })

  return NextResponse.json({ pipeline, track, draft: draft ?? null })
}
