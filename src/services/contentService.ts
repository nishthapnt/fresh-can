import { supabase } from '@/lib/supabase'
import type {
  ContentJob,
  ContentDraft,
  GeneratedContent,
  SocialPost,
  SocialPlatformLog,
  NewContentFormData,
  JobWithAll,
  KPIData,
  ContentType,
  JobStatus,
  PlatformType,
  VideoLibraryItem,
  ImageLibraryItem,
  BlogLibraryItem,
  AspectRatio,
} from '@/types/content'

// ─── Content Jobs ─────────────────────────────────────────────────────────────

export async function createContentJob(
  form: NewContentFormData,
): Promise<ContentJob> {
  const { data, error } = await supabase
    .from('content_jobs')
    .insert({
      topic: form.topic,
      keywords: form.keywords || null,
      category: form.category,
      target_audience: form.target_audience,
      language: form.language,
      content_types: form.content_types,
      status: 'pending',
    })
    .select()
    .single()

  if (error) throw new Error(error.message)
  return data as ContentJob
}

export async function getContentJob(jobId: string): Promise<ContentJob | null> {
  const { data, error } = await supabase
    .from('content_jobs')
    .select('*')
    .eq('id', jobId)
    .single()

  if (error) {
    // PGRST116 = "The result contains 0 rows" → genuinely not found
    if (error.code === 'PGRST116') return null
    throw new Error(error.message)
  }
  return data as ContentJob
}

export async function getRecentJobs(limit = 10): Promise<ContentJob[]> {
  const { data, error } = await supabase
    .from('content_jobs')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit)

  if (error) throw new Error(error.message)
  return (data as ContentJob[]) ?? []
}

export async function updateJobStatus(
  jobId: string,
  status: JobStatus,
): Promise<void> {
  const { error } = await supabase
    .from('content_jobs')
    .update({ status, updated_at: new Date().toISOString() })
    .eq('id', jobId)

  if (error) throw new Error(error.message)
}

export async function getKPIData(): Promise<KPIData> {
  const today = new Date()
  today.setHours(0, 0, 0, 0)

  const [totalRes, draftRes, readyRes, postedRes] = await Promise.all([
    supabase.from('content_jobs').select('id', { count: 'exact', head: true }),
    supabase
      .from('content_jobs')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'draft_ready'),
    supabase
      .from('content_jobs')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'ready'),
    supabase
      .from('social_platform_logs')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'posted')
      .gte('created_at', today.toISOString()),
  ])

  return {
    total_jobs: totalRes.count ?? 0,
    drafts_pending: draftRes.count ?? 0,
    ready_to_post: readyRes.count ?? 0,
    posted_today: postedRes.count ?? 0,
  }
}

// ─── Content Drafts ───────────────────────────────────────────────────────────

export async function getDraftsForJob(
  jobId: string,
): Promise<ContentDraft[]> {
  const { data, error } = await supabase
    .from('content_drafts')
    .select('*')
    .eq('job_id', jobId)
    .order('created_at', { ascending: true })

  if (error) throw new Error(error.message)
  return (data as ContentDraft[]) ?? []
}

export async function updateDraft(
  draftId: string,
  draftData: Record<string, unknown>,
): Promise<void> {
  const { error } = await supabase
    .from('content_drafts')
    .update({ draft_data: draftData, updated_at: new Date().toISOString() })
    .eq('id', draftId)

  if (error) throw new Error(error.message)
}

export async function approveDraft(draftId: string): Promise<void> {
  const { error } = await supabase
    .from('content_drafts')
    .update({
      is_approved: true,
      status: 'approved',
      updated_at: new Date().toISOString(),
    })
    .eq('id', draftId)

  if (error) throw new Error(error.message)
}

// ─── Generated Content ────────────────────────────────────────────────────────

export async function getGeneratedContent(
  jobId: string,
): Promise<GeneratedContent[]> {
  const { data, error } = await supabase
    .from('generated_content')
    .select('*')
    .eq('job_id', jobId)

  if (error) throw new Error(error.message)
  return (data as GeneratedContent[]) ?? []
}

export async function getVideoLibrary(): Promise<VideoLibraryItem[]> {
  const { data, error } = await supabase
    .from('generated_content')
    .select(`
      id,
      job_id,
      file_url,
      output_data,
      created_at,
      language,
      content_jobs!inner (
        topic,
        category,
        status,
        aspect_ratio
      )
    `)
    .eq('content_type', 'video')
    .not('file_url', 'is', null)
    .order('created_at', { ascending: false })

  if (error) throw new Error(error.message)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (data ?? []).map((row: any) => ({
    id:           row.id,
    job_id:       row.job_id,
    video_url:    row.file_url as string,
    output_data:  row.output_data ?? null,
    completed_at: row.created_at as string,
    topic:        (row.content_jobs as { topic: string })?.topic ?? 'Untitled',
    category:     (row.content_jobs as { category: string })?.category ?? '',
    // This row's OWN language ('EN'/'FR', worker/src/db.ts's
    // upsertVideoGeneratedContent) — not content_jobs.language, which is
    // the job's requested intent and is literally the string 'BOTH' for a
    // two-language job, identical on both of its rows. Grouping EN/FR into
    // one toggled card (dashboard/page.tsx's MiniVideoCardGroup, library/
    // LibraryContent.tsx's VideoCardGroup) keys off this field, so reading
    // the job-level value here silently collapsed both rows into a single
    // 'EN' bucket and dropped the FR video from grouping entirely.
    language:     (row.language as string | null) ?? (row.content_jobs as { language?: string })?.language ?? '',
    status:       (row.content_jobs as { status: string })?.status ?? '',
    // Older jobs predate this column (supabase/migrations/20260912120000) —
    // '9:16' is also this app's default going forward, so it's the right
    // fallback for a null/missing value, not just an arbitrary one.
    aspect_ratio: ((row.content_jobs as { aspect_ratio?: string })?.aspect_ratio as AspectRatio | undefined) ?? '9:16',
  }))
}

function resolveStr(row: Record<string, unknown>, ...keys: string[]): string {
  for (const k of keys) {
    const v = row[k]
    if (v && typeof v === 'string') return v
  }
  return ''
}

function resolveHashtags(row: Record<string, unknown>): string[] {
  const raw = row.hashtags ?? (row.output_data as Record<string, unknown> | null)?.hashtags
  if (Array.isArray(raw)) return (raw as unknown[]).map(String)
  if (typeof raw === 'string' && raw) return raw.split(/[\s,]+/).filter(Boolean)
  return []
}

export async function getImageLibrary(): Promise<ImageLibraryItem[]> {
  // Select all columns — the worker (worker/src/db.ts upsertImageGeneratedContent) writes
  // image_url / caption / hashtags as both direct columns and inside output_data
  const { data, error } = await supabase
    .from('generated_content')
    .select(`
      *,
      content_jobs!inner (
        topic,
        category,
        language,
        status
      )
    `)
    .eq('content_type', 'image_post')
    .eq('status', 'completed')
    .order('created_at', { ascending: false })

  if (error) throw new Error(error.message)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (data ?? []).map((row: any) => {
    const r = row as Record<string, unknown>
    const od = (r.output_data ?? {}) as Record<string, unknown>

    // image_url is a direct column written by the worker; fall back to file_url if missing
    const imageUrl = resolveStr(r, 'image_url') || resolveStr(od, 'image_url') || resolveStr(r, 'file_url')

    // hashtags is a plain string "#tag1 #tag2 ..." as written by the worker
    const rawHashtags = r.hashtags ?? od.hashtags
    const hashtags = typeof rawHashtags === 'string' && rawHashtags
      ? rawHashtags.split(/[\s,]+/).filter(Boolean)
      : Array.isArray(rawHashtags) ? (rawHashtags as unknown[]).map(String) : []

    return {
      id:            r.id as string,
      job_id:        r.job_id as string,
      image_url:     imageUrl,
      caption:       resolveStr(r, 'caption') || resolveStr(od, 'caption'),
      hashtags,
      alt_text:      resolveStr(r, 'alt_text') || resolveStr(od, 'alt_text'),
      headline_text: resolveStr(r, 'headline_text') || resolveStr(od, 'headline_text'),
      subtitle_text: resolveStr(r, 'subtitle_text') || resolveStr(od, 'subtitle_text'),
      output_data:   (r.output_data as Record<string, unknown> | null) ?? null,
      completed_at:  resolveStr(r, 'completed_at', 'created_at'),
      topic:         resolveStr(r, 'topic') || (row.content_jobs as { topic: string })?.topic || 'Untitled',
      category:      (row.content_jobs as { category: string })?.category ?? resolveStr(r, 'category'),
      language:      (row.content_jobs as { language: string })?.language ?? resolveStr(r, 'language'),
      status:        resolveStr(r, 'status'),
    }
  }).filter((item) => item.image_url !== '')
}

export async function getBlogLibrary(): Promise<BlogLibraryItem[]> {
  const { data, error } = await supabase
    .from('generated_content')
    .select(`
      id,
      job_id,
      file_url,
      output_data,
      language,
      created_at,
      content_jobs!inner (
        topic,
        category,
        status
      )
    `)
    .eq('content_type', 'blog')
    .order('created_at', { ascending: false })

  if (error) throw new Error(error.message)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (data ?? []).map((row: any) => ({
    id:           row.id,
    job_id:       row.job_id,
    file_url:     row.file_url ?? null,
    output_data:  row.output_data ?? null,
    completed_at: row.created_at as string,
    topic:        (row.content_jobs as { topic: string })?.topic ?? 'Untitled',
    category:     (row.content_jobs as { category: string })?.category ?? '',
    // The row's own actual language (EN/FR) — a BOTH job produces two real
    // generated_content rows now, each with its own language; the job's
    // language field ('BOTH') would misreport BOTH rows identically and
    // give the html_final fallback fetch below nothing to filter on.
    language:     (row.language as string) ?? '',
    status:       (row.content_jobs as { status: string })?.status ?? '',
  }))
}

export async function getAllGeneratedContent(): Promise<GeneratedContent[]> {
  const { data, error } = await supabase
    .from('generated_content')
    .select('*, content_jobs(topic, status, created_at)')
    .order('created_at', { ascending: false })

  if (error) throw new Error(error.message)
  return (data as GeneratedContent[]) ?? []
}

// ─── Social Posts ─────────────────────────────────────────────────────────────

export async function getSocialPostsForJob(
  jobId: string,
): Promise<SocialPost[]> {
  const { data, error } = await supabase
    .from('social_posts')
    .select('*')
    .eq('job_id', jobId)

  if (error) throw new Error(error.message)
  return (data as SocialPost[]) ?? []
}

export async function upsertSocialPost(
  jobId: string,
  contentType: ContentType,
  caption: string,
  hashtags: string[],
  platforms: PlatformType[],
): Promise<SocialPost> {
  const { data, error } = await supabase
    .from('social_posts')
    .upsert(
      {
        job_id: jobId,
        content_type: contentType,
        caption,
        hashtags,
        platforms,
        status: 'approved',
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'job_id,content_type' },
    )
    .select()
    .single()

  if (error) throw new Error(error.message)
  return data as SocialPost
}

// social_posts.status is now written only by worker/src/db.ts's
// rollupSocialPostStatus (ARCHITECTURE.MD §2.5 migration off n8n) — no
// remaining caller writes it from the frontend or an API route, so there's
// no updateSocialPostStatus export here anymore.

// ─── Social Platform Logs ─────────────────────────────────────────────────────

export async function upsertPlatformLog(
  socialPostId: string,
  platform: PlatformType,
  status: string,
  platformPostId?: string,
  postUrl?: string,
  errorMessage?: string,
): Promise<void> {
  const { error } = await supabase.from('social_platform_logs').upsert(
    {
      social_post_id: socialPostId,
      platform,
      status,
      platform_post_id: platformPostId ?? null,
      post_url: postUrl ?? null,
      error_message: errorMessage ?? null,
    },
    { onConflict: 'social_post_id,platform' },
  )

  if (error) throw new Error(error.message)
}

export async function getPlatformLogsForPost(
  socialPostId: string,
): Promise<SocialPlatformLog[]> {
  const { data, error } = await supabase
    .from('social_platform_logs')
    .select('*')
    .eq('social_post_id', socialPostId)

  if (error) throw new Error(error.message)
  return (data as SocialPlatformLog[]) ?? []
}

// ─── Aggregated job view ──────────────────────────────────────────────────────

export async function getJobWithAll(
  jobId: string,
): Promise<JobWithAll | null> {
  const [job, drafts, generated, social] = await Promise.all([
    getContentJob(jobId),
    getDraftsForJob(jobId),
    getGeneratedContent(jobId),
    getSocialPostsForJob(jobId),
  ])

  if (!job) return null
  return { ...job, drafts, generated_content: generated, social_posts: social }
}
export async function getPostedContent() {
  const { data: posts, error } = await supabase
    .from('social_posts')
    .select('id, job_id, content_type, caption, hashtags, status, created_at')
    .eq('status', 'posted')
    .order('created_at', { ascending: false })

  if (error) throw error
  if (!posts || posts.length === 0) return []

  const jobIds = posts.map(p => p.job_id)
    const { data: content } = await supabase
    .from('generated_content')
    .select('job_id, file_url, image_url, thumbnail_url')
    .in('job_id', jobIds)

  const { data: logs } = await supabase
    .from('social_platform_logs')
    .select('job_id, platform, post_url')
    .in('job_id', jobIds)

  return posts.map(post => ({
    ...post,
        media_url: content?.find(c => c.job_id === post.job_id)?.image_url
      ?? content?.find(c => c.job_id === post.job_id)?.file_url
      ?? null,
    platform_logs: logs?.filter(l => l.job_id === post.job_id) ?? [],
  }))
}