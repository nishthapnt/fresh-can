import { NextRequest, NextResponse } from 'next/server'
import { upsertSocialPost } from '@/services/contentService'
import type { ContentType, PlatformType } from '@/types/content'
import { inngest } from '@/inngest/client'

// Used to fire N8N_SOCIAL_WEBHOOK here — replaced by
// src/server/pipeline/steps/social/publishPost.ts (ARCHITECTURE.MD §2.5
// migration off n8n), then moved off the worker's tickSocial poll loop onto
// Inngest (docs/IMPLEMENTATION_PLAN.md's Inngest migration plan, Phase 4).
// upsertSocialPost setting status='approved' is still the trigger — this
// route just also sends content/social.publish so Inngest picks it up
// immediately instead of waiting for the next poll tick (which no longer
// exists).
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
    const post = await upsertSocialPost(job_id, content_type, caption, hashtags ?? [], platforms)
    // The function ignores postId (it sweeps all approved-but-unsubmitted
    // posts, matching runSubmitSocialPosts' own global scope — see
    // src/inngest/functions/social.ts) — included here only for
    // observability, and updated_at makes each approval's event distinct so
    // re-approving the same job/content_type isn't deduped against a stale
    // previous send.
    await inngest.send({
      id: `${post.id}:social.publish:${post.updated_at}`,
      name: 'content/social.publish',
      data: { postId: post.id },
    })
    return NextResponse.json({ success: true })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
