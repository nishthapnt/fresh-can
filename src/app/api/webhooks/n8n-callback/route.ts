import { NextRequest, NextResponse } from 'next/server'
import {
  getSocialPostsForJob,
  updateSocialPostStatus,
} from '@/services/contentService'
import type { N8nCallbackPostComplete } from '@/types/content'
import { supabase } from '@/lib/supabase'

// Fix #17 — verify shared secret sent by n8n
function isAuthorized(req: NextRequest): boolean {
  const secret = process.env.N8N_WEBHOOK_SECRET
  if (!secret) return true // skip check if not configured (dev mode)
  const auth = req.headers.get('authorization') ?? ''
  return auth === `Bearer ${secret}`
}

// social posting is the only content type still on n8n — blog, image_post,
// and video generation all write directly to Supabase from worker/ and
// src/app/api/jobs/[jobId]/{blog,image,video}/, so this callback only ever
// needs to handle the social-posting workflow's completion event.
export async function POST(req: NextRequest) {
  // Fix #17 — reject unauthenticated callers
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: N8nCallbackPostComplete

  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const { job_id, content_type, event, data } = body

  if (!job_id || !content_type || !event) {
    return NextResponse.json(
      { error: 'Missing required fields: job_id, content_type, event' },
      { status: 400 },
    )
  }

  if (event !== 'post_complete') {
    return NextResponse.json({ error: 'Unknown event type' }, { status: 400 })
  }

  // Verify job exists
  const { data: job, error: jobError } = await supabase
    .from('content_jobs')
    .select('id')
    .eq('id', job_id)
    .single()

  if (jobError || !job) {
    return NextResponse.json({ error: 'Job not found' }, { status: 404 })
  }

  if (!data?.platform || typeof data.platform !== 'string') {
    return NextResponse.json(
      { error: 'post_complete event requires data.platform string' },
      { status: 400 },
    )
  }

  try {
    const socialPosts = await getSocialPostsForJob(job_id)
    const matchingPost = socialPosts.find((p) => p.content_type === content_type)

    if (matchingPost) {
      await supabase.from('social_platform_logs').insert({
        social_post_id: matchingPost.id,
        job_id: job_id,
        platform: data.platform,
        status: 'posted',
        platform_post_id: data.platform_post_id ?? null,
        post_url: data.post_url ?? null,
        posted_at: new Date().toISOString(),
      })
      await updateSocialPostStatus(matchingPost.id, 'posted')
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    console.error('[n8n-callback] error:', message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
