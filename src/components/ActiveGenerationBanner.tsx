'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { CheckCircle2, Loader2 } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useNewContentStore } from '../stores/newContentStore'

/**
 * Whether every requested content_type (for every requested language) has
 * actually produced something to review yet. Deliberately NOT based on
 * content_jobs.status — blog, image_post, AND video all run on the worker
 * pipeline (content_pipelines/content_language_tracks) now, and nothing
 * writes back to content_jobs.status for any of them anymore, so that
 * column stays stuck at 'pending' even once their drafts are long since
 * ready. Checking the same per-type tables the
 * job detail page itself reads (content_drafts for video/blog,
 * generated_content for image_post) is what actually reflects reality.
 */
async function isJobReadyForReview(jobId: string): Promise<boolean> {
  const { data: job } = await supabase
    .from('content_jobs')
    .select('content_types, language')
    .eq('id', jobId)
    .maybeSingle()
  if (!job) return false

  const contentTypes = (job.content_types ?? []) as string[]
  if (contentTypes.length === 0) return false
  const languages = job.language === 'BOTH' ? ['EN', 'FR'] : [job.language as string]

  const readiness = await Promise.all(
    contentTypes.map(async (type) => {
      if (type === 'image_post') {
        const { data } = await supabase
          .from('generated_content')
          .select('language')
          .eq('job_id', jobId)
          .eq('content_type', 'image_post')
        const done = new Set((data ?? []).map((r) => r.language))
        return languages.every((l) => done.has(l))
      }
      // video and blog both land in content_drafts — a row that's still
      // 'pending' doesn't count as reviewable content yet.
      const { data } = await supabase
        .from('content_drafts')
        .select('language, status')
        .eq('job_id', jobId)
        .eq('content_type', type)
      const done = new Set((data ?? []).filter((r) => r.status !== 'pending').map((r) => r.language))
      return languages.every((l) => done.has(l))
    }),
  )

  return readiness.every(Boolean)
}

export default function ActiveGenerationBanner() {
  const { status, pendingJobId, topic, restoreSession } = useNewContentStore()
  const [isReady, setIsReady] = useState(false)

  useEffect(() => {
    restoreSession()
  }, [restoreSession])

  useEffect(() => {
    if (status !== 'pending' || !pendingJobId) return
    let active = true

    const recheck = () => {
      isJobReadyForReview(pendingJobId).then((ready) => { if (active) setIsReady(ready) })
    }
    recheck()

    const channel = supabase
      .channel(`active-gen-banner-${pendingJobId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'content_drafts', filter: `job_id=eq.${pendingJobId}` },
        recheck,
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'generated_content', filter: `job_id=eq.${pendingJobId}` },
        recheck,
      )
      .subscribe()

    return () => { active = false; supabase.removeChannel(channel) }
  }, [status, pendingJobId])

  if (status !== 'pending' || !pendingJobId) return null

  return (
    <div className="mb-6 flex items-center gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-amber-100">
        {isReady ? (
          <CheckCircle2 className="h-4 w-4 text-amber-600" />
        ) : (
          <Loader2 className="h-4 w-4 animate-spin text-amber-600" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-amber-900">
          {isReady ? 'Content ready for review' : 'Content generation in progress'}
        </p>
        <p className="truncate text-xs text-amber-700">{topic}</p>
      </div>
      <Link
        href={`/dashboard/jobs/${pendingJobId}`}
        className="shrink-0 rounded-lg border border-amber-300 bg-white px-3 py-1.5 text-xs font-medium text-amber-800 hover:bg-amber-50"
      >
        {isReady ? 'Review & Approve →' : 'View & Approve →'}
      </Link>
    </div>
  )
}
