import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { validateBlogDraftSaveRequest } from '@/server/pipeline/steps/blog/saveDraft'

function getSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  return createClient(url, key)
}

// Decouples saving a blog draft edit from Approve. Before this route,
// page.tsx's handleContentApprove was the ONLY place a blog edit ever got
// persisted — it bundled the save into the same PATCH /api/jobs/[jobId]/draft
// call it used to approve, so an edit made and then abandoned (navigating
// away without clicking Approve) was silently lost, only ever having lived
// in blogEdit's React state.
//
// Deliberately a new, blog-specific route rather than adding a guard to
// that existing generic PATCH route — that route is also used by
// image_post's own save-on-approve path (draft/route.ts defaults
// content_type to 'video', a sign it was never meant to carry per-content-
// type behavior), so changing its behavior risks an unrelated regression
// there. This route hard-blocks (409) once the draft is already approved,
// matching video's POST /video/script gate — an edit after approval would
// silently diverge from the hero/inline images already generated against
// the old copy.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ jobId: string }> },
) {
  const { jobId } = await params

  let rawBody: unknown
  try {
    rawBody = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const validated = validateBlogDraftSaveRequest(rawBody)
  if ('error' in validated) {
    return NextResponse.json({ error: validated.error }, { status: 400 })
  }
  const { language, draftData } = validated.request

  const supabase = getSupabase()

  const { data: draft, error: dErr } = await supabase
    .from('content_drafts')
    .select('*')
    .eq('job_id', jobId)
    .eq('content_type', 'blog')
    .eq('language', language)
    .maybeSingle()
  if (dErr) return NextResponse.json({ error: dErr.message }, { status: 500 })
  if (!draft) return NextResponse.json({ error: `No ${language} blog draft for this job` }, { status: 404 })

  if (draft.is_approved) {
    return NextResponse.json(
      { error: 'This draft is already approved and can no longer be edited' },
      { status: 409 },
    )
  }

  const { data: updated, error: uErr } = await supabase
    .from('content_drafts')
    .update({
      draft_data: draftData,
      is_edited: true,
      updated_at: new Date().toISOString(),
    })
    .eq('id', draft.id)
    .select()
    .single()
  if (uErr) return NextResponse.json({ error: uErr.message }, { status: 500 })

  return NextResponse.json({ draft: updated })
}
