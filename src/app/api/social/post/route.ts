import { NextRequest, NextResponse } from 'next/server'
import { upsertSocialPost } from '@/services/contentService'
import type { ContentType, PlatformType } from '@/types/content'

// Used to fire N8N_SOCIAL_WEBHOOK here — replaced by worker/src/steps/social/
// publishPost.ts (ARCHITECTURE.MD §2.5 migration off n8n). upsertSocialPost
// setting status='approved' IS the trigger now: the worker's tickSocial()
// picks up any approved social_posts row with no social_platform_logs yet
// on its next poll tick and calls upload-post.com directly, so this route's
// only remaining job is validating input and writing that one row.
export async function POST(req: NextRequest) {
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const { job_id, content_type, caption, hashtags, platforms } = body as {
    job_id: string
    content_type: ContentType
    caption: string
    hashtags: string[]
    platforms: PlatformType[]
  }

  if (!job_id || !content_type || !caption || !platforms?.length) {
    return NextResponse.json(
      { error: 'Missing required fields: job_id, content_type, caption, platforms' },
      { status: 400 },
    )
  }

  try {
    await upsertSocialPost(job_id, content_type, caption, hashtags ?? [], platforms)
    return NextResponse.json({ success: true })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
