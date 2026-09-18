import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

function getSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  return createClient(url, key)
}

type BlogLanguage = 'EN' | 'FR'
function isBlogLanguage(v: string): v is BlogLanguage {
  return v === 'EN' || v === 'FR'
}

function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}

function wordCount(draft: Record<string, unknown>): number {
  const content = asRecord(draft.content)
  const sections = Array.isArray(content.sections) ? (content.sections as Record<string, unknown>[]) : []
  return sections.reduce((n, s) => {
    const paragraphs = Array.isArray(s.paragraphs) ? (s.paragraphs as unknown[]) : []
    return n + paragraphs.join(' ').split(' ').filter(Boolean).length
  }, 0)
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// Success-path counterpart to the worker's markJobReadyIfAllContentComplete
// (worker/src/db.ts) — can't import that directly, since worker/ is a
// separate Node project from this Next.js app. Blog is the only content
// type whose generated_content row is written here (approve-gated) rather
// than automatically by the worker, so this is the one place in src/ that
// needs its own copy of the same aggregate-completeness check. Deliberately
// coarse (content-type presence, not per-language completeness) — see that
// function's own comment for why. Never downgrades a job already at
// 'ready'/'posted'/'failed'.
async function markJobReadyIfAllContentComplete(
  supabase: ReturnType<typeof getSupabase>,
  jobId: string,
): Promise<void> {
  const { data: job, error } = await supabase
    .from('content_jobs')
    .select('status, content_types')
    .eq('id', jobId)
    .single()
  if (error || !job) return
  if (job.status === 'ready' || job.status === 'posted' || job.status === 'failed') return

  const requested = (job.content_types as string[] | null) ?? []
  if (requested.length === 0) return

  const { data: rows, error: rowsErr } = await supabase
    .from('generated_content')
    .select('content_type')
    .eq('job_id', jobId)
  if (rowsErr) return

  const completedTypes = new Set((rows ?? []).map((r) => r.content_type as string))
  if (!requested.every((t) => completedTypes.has(t))) return

  await supabase
    .from('content_jobs')
    .update({ status: 'ready', updated_at: new Date().toISOString() })
    .eq('id', jobId)
}

/**
 * Server-side mirror of LibraryContent.tsx's reconstructBlogHtml() —
 * html_final is normally computed client-side (blogEditToDraftData, via the
 * PATCH /draft save-edits step) ONLY for whichever language tab the browser
 * had open when the user hit Approve. For a BOTH job, that PATCH never runs
 * for the language that wasn't being actively viewed/edited, so its
 * content_drafts row (and, without this, generated_content too) ends up
 * with real structured content but no html_final — confirmed live: a BOTH
 * job's untouched language showed only its SEO excerpt in the Library
 * because html_final was null. Computing it here, from the always-present
 * structured `content` fields, removes the dependency on the client ever
 * having visited that specific language's editor tab.
 */
function reconstructHtml(d: Record<string, unknown>): string {
  const content = asRecord(d.content)
  const intro = typeof content.introduction === 'string' ? content.introduction : ''
  const conclusion = typeof content.conclusion === 'string' ? content.conclusion : ''
  const sections = Array.isArray(content.sections) ? (content.sections as Record<string, unknown>[]) : []
  const ctaRaw = asRecord(content.cta)
  const imgs = asRecord(d.images)
  const inlineImg = asRecord(imgs.inline)

  if (!intro && sections.length === 0) return ''

  let html = '<article class="freshcan-blog-post">'
  if (intro) html += `<p>${esc(intro)}</p>`

  sections.forEach((s, i) => {
    const heading = typeof s.heading === 'string' ? s.heading : ''
    const paras = Array.isArray(s.paragraphs) ? (s.paragraphs as string[]).filter(Boolean) : []
    const h3s = Array.isArray(s.h3s) ? (s.h3s as string[]).filter(Boolean) : []
    const listItems = Array.isArray(s.list_items) ? (s.list_items as string[]).filter(Boolean) : []
    const bq = (s.blockquote as Record<string, unknown> | null) ?? null

    if (heading) html += `<h2>${esc(heading)}</h2>`
    h3s.forEach((h) => { html += `<h3>${esc(h)}</h3>` })
    paras.forEach((p) => { html += `<p>${esc(p)}</p>` })
    if (listItems.length) html += '<ul>' + listItems.map((li) => `<li>${esc(li)}</li>`).join('') + '</ul>'
    if (bq && typeof bq.text === 'string') {
      html += `<blockquote><p>${esc(bq.text)}</p>${bq.cite ? `<cite>${esc(String(bq.cite))}</cite>` : ''}</blockquote>`
    }
    if (i === 0 && typeof inlineImg.url === 'string' && (inlineImg.url as string).startsWith('http')) {
      html += `<figure class="inline-image"><img src="${inlineImg.url as string}" alt="${esc(String(inlineImg.alt ?? ''))}" /></figure>`
    }
  })

  if (conclusion) html += `<p>${esc(conclusion)}</p>`

  if (ctaRaw.heading || ctaRaw.text) {
    html += '<div class="cta-section">'
    if (typeof ctaRaw.heading === 'string') html += `<h2>${esc(ctaRaw.heading)}</h2>`
    if (typeof ctaRaw.text === 'string') html += `<p>${esc(ctaRaw.text)}</p>`
    if (typeof ctaRaw.button_label === 'string' && typeof ctaRaw.button_url === 'string') {
      html += `<a href="${esc(ctaRaw.button_url)}" class="cta-button">${esc(ctaRaw.button_label)}</a>`
    }
    html += '</div>'
  }

  html += '</article>'
  return html
}

// Writes generated_content from the backend — fixes the client-side write
// bug (SPECIFICATIONS.md §11 / ARCHITECTURE.MD §11) where approval logic
// was duplicated in the job detail page component. Mirrors the exact
// output_data shape the Library already reads (src/services/contentService.ts
// getBlogLibrary()).
export async function POST(
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

  // draft_ready: normal path. stale: a visual regeneration happened after a
  // prior approval — re-approving picks up the current shared asset below
  // rather than the (possibly outdated) image URLs baked into draft_data.
  if (track.status !== 'draft_ready' && track.status !== 'stale') {
    return NextResponse.json(
      { error: `Track is '${track.status}', must be 'draft_ready' or 'stale' to approve` },
      { status: 409 },
    )
  }

  const { data: draft, error: dErr } = await supabase
    .from('content_drafts')
    .select('*')
    .eq('job_id', jobId)
    .eq('content_type', 'blog')
    .eq('language', lang)
    .maybeSingle()
  if (dErr) return NextResponse.json({ error: dErr.message }, { status: 500 })
  if (!draft) return NextResponse.json({ error: 'No draft to approve' }, { status: 404 })

  const d = asRecord(draft.draft_data)
  const seo = asRecord(d.seo)
  const draftImages = asRecord(d.images)
  let hero = asRecord(draftImages.hero)
  let inline = asRecord(draftImages.inline)

  // 'stale' means a visual regen happened after this draft was created —
  // captured before the track update below overwrites track.status.
  const wasStale = track.status === 'stale'

  // Pull the current shared visual assets for this pipeline's generation —
  // authoritative over whatever draft_data carried, since a 'stale' track's
  // draft_data may still point at a superseded generation's images.
  const { data: visualAssets, error: vErr } = await supabase
    .from('content_visual_assets')
    .select('*')
    .eq('content_pipeline_id', pipeline.id)
    .eq('generation', pipeline.current_generation)
  if (vErr) return NextResponse.json({ error: vErr.message }, { status: 500 })

  const heroAsset = (visualAssets ?? []).find((a) => a.asset_type === 'hero_image')
  const inlineAsset = (visualAssets ?? []).find((a) => a.asset_type === 'inline_image')
  if (heroAsset?.file_url) hero = { ...hero, url: heroAsset.file_url }
  if (inlineAsset?.file_url) inline = { ...inline, url: inlineAsset.file_url }

  // d.html_final only exists if the client had this exact language's editor
  // tab open and saved edits before approving (blogEditToDraftData via
  // PATCH /draft) — never guaranteed for a BOTH job's second language.
  // Reconstructing from the structured content whenever it's missing means
  // approval always produces real HTML, regardless of what the browser did.
  //
  // For a 'stale' track specifically, ANY existing d.html_final is
  // guaranteed to have been built against the pre-regen images — content_drafts
  // is only ever written once, by finalize_draft, which never re-runs after a
  // visual-only regen (it's gated on the TRACK's master_generation_used,
  // which that regen deliberately never bumps). So a stale approve always
  // reconstructs fresh, from the just-reconciled hero/inline, instead of
  // trusting whatever's already there — otherwise the published post's
  // embedded <img> could permanently point at the old photo even though
  // hero_image_url/inline_image_url below get the new one.
  const htmlFinal = wasStale
    ? reconstructHtml({ ...d, images: { hero, inline } })
    : typeof d.html_final === 'string' && d.html_final ? d.html_final : reconstructHtml(d)

  const { error: gErr } = await supabase.from('generated_content').upsert(
    {
      job_id: jobId,
      content_type: 'blog',
      language: lang,
      file_url: (hero.url as string) || null,
      output_data: {
        post_title: d.post_title ?? '',
        post_slug: d.post_slug ?? '',
        post_excerpt: seo.meta_description ?? '',
        focus_keyword: seo.focus_keyword ?? '',
        html_final: htmlFinal || null,
        hero_image_url: hero.url ?? null,
        inline_image_url: inline.url ?? null,
        images: { hero, inline },
        seo,
        title: d.post_title ?? '',
        slug: d.post_slug ?? '',
        excerpt: seo.meta_description ?? '',
        secondary_keywords: seo.secondary_keywords ?? [],
        word_count: wordCount(d),
      },
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'job_id,content_type,language' },
  )
  if (gErr) return NextResponse.json({ error: gErr.message }, { status: 500 })

  await markJobReadyIfAllContentComplete(supabase, jobId)

  const { data: updatedTrack, error: uErr } = await supabase
    .from('content_language_tracks')
    .update({ status: 'ready', updated_at: new Date().toISOString() })
    .eq('id', track.id)
    .select()
    .single()
  if (uErr) return NextResponse.json({ error: uErr.message }, { status: 500 })

  // Also persist the reconciled images/html back into content_drafts itself
  // (not just the generated_content write above) — otherwise draft_data
  // stays permanently stale after a visual regen: the editor keeps showing
  // the pre-regen photo forever (nothing else ever rewrites draft_data.images
  // — see the htmlFinal comment above), and a second approve of the SAME
  // generation would recompute html_final from stale data all over again.
  // The page's existing content_drafts realtime subscription picks this up
  // automatically, so the editor's preview updates with no frontend change.
  await supabase
    .from('content_drafts')
    .update({
      draft_data: wasStale ? { ...d, images: { hero, inline }, html_final: htmlFinal } : d,
      is_approved: true,
      status: 'approved',
      updated_at: new Date().toISOString(),
    })
    .eq('job_id', jobId)
    .eq('content_type', 'blog')
    .eq('language', lang)

  return NextResponse.json({ track: updatedTrack })
}
