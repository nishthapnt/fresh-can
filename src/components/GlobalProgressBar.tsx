'use client'

import { useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { useContentJobStore, TrackedJob } from '../stores/contentJobStore'
import { supabase } from '../lib/supabase'
import { computeVideoProgress } from '../lib/videoProgress'

function progressLabel(progress: number): string {
  if (progress < 15) return 'Writing script…'
  if (progress < 30) return 'Generating audio…'
  if (progress < 50) return 'Creating images…'
  if (progress < 70) return 'Animating clips…'
  if (progress < 85) return 'Merging video…'
  return 'Almost ready…'
}

function showToast(job: TrackedJob, router: ReturnType<typeof useRouter>) {
  const typeLabel = job.type === 'video' ? 'Video' : job.type === 'blog' ? 'Blog post' : 'Image post'
  const section   = job.type === 'video' ? 'videos' : job.type === 'blog' ? 'blogs' : 'images'
  const href      = `/dashboard/library?section=${section}&highlight=${job.jobId}`

  const el = document.createElement('div')
  el.setAttribute('role', 'alert')
  el.style.cssText = [
    'position:fixed', 'bottom:24px', 'right:24px', 'z-index:10000',
    'background:#fff', 'border:1px solid #e5e7eb', 'border-radius:14px',
    'padding:16px 18px', 'min-width:300px', 'max-width:360px',
    'box-shadow:0 8px 28px rgba(0,0,0,0.10)',
    'animation:fg-slide-in 0.3s ease',
    'display:flex', 'align-items:flex-start', 'gap:12px',
  ].join(';')

  el.innerHTML = `
    <style>@keyframes fg-slide-in{from{transform:translateX(110%);opacity:0}to{transform:translateX(0);opacity:1}}</style>
    <div style="width:36px;height:36px;border-radius:50%;background:#dcfce7;display:flex;align-items:center;justify-content:center;flex-shrink:0;">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#16a34a" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
    </div>
    <div style="flex:1;min-width:0;">
      <p style="font-weight:600;font-size:13px;color:#111827;margin:0 0 3px;">${typeLabel} ready!</p>
      <p style="font-size:12px;color:#6b7280;margin:0 0 10px;line-height:1.45;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${job.topic}</p>
      <button id="fg-toast-view" style="font-size:12px;padding:5px 12px;border-radius:6px;border:1px solid #d1d5db;background:#f9fafb;color:#374151;cursor:pointer;font-weight:500;">View in Library →</button>
    </div>
    <button id="fg-toast-close" style="background:none;border:none;font-size:20px;cursor:pointer;color:#9ca3af;line-height:1;padding:0;flex-shrink:0;margin-top:-2px;">×</button>
  `

  document.body.appendChild(el)

  el.querySelector('#fg-toast-view')?.addEventListener('click', () => {
    el.remove()
    router.push(href)
  })
  el.querySelector('#fg-toast-close')?.addEventListener('click', () => el.remove())

  setTimeout(() => { if (el.parentNode) el.remove() }, 8000)
}

export default function GlobalProgressBar() {
  const { jobs, updateJob, markNotified, removeJob, restoreFromSession } = useContentJobStore()
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const router = useRouter()

  useEffect(() => {
    restoreFromSession()
  }, [restoreFromSession])

  const videoJobs = jobs.filter((j) => j.type === 'video' && j.status === 'generating')

  useEffect(() => {
    if (videoJobs.length === 0) return

    const poll = async () => {
      for (const job of videoJobs) {
        try {
          // content_jobs.status reliably reaches 'failed' once the video
          // pipeline/tracks fail terminally or are cancelled (see
          // worker/src/db.ts's markJobFailedIfNotAlreadyTerminal and
          // video/cancel/route.ts) — checked directly rather than inferred
          // from progress, so a dead job never just sits at a stale number.
          const [{ data: jobData }, statusRes] = await Promise.all([
            supabase.from('content_jobs').select('status').eq('id', job.jobId).maybeSingle(),
            fetch(`/api/jobs/${job.jobId}/video/status`),
          ])

          if (jobData?.status === 'failed') {
            removeJob(job.jobId)
            continue
          }

          if (!statusRes.ok) continue
          const { pipeline, tracks } = (await statusRes.json()) as {
            pipeline: { status: string; scenes_visuals_ready_count: number | null; scenes_total: number | null }
            tracks: { status: string }[]
          }

          const progress = computeVideoProgress(pipeline, tracks)

          if (progress === 100) {
            updateJob(job.jobId, { status: 'completed', progress: 100 })
            if (!job.notified) {
              markNotified(job.jobId)
              showToast(job, router)
            }
            setTimeout(() => removeJob(job.jobId), 5000)
          } else {
            updateJob(job.jobId, { progress })
          }
        } catch (_) {}
      }
    }

    poll()
    pollingRef.current = setInterval(poll, 10000)
    return () => { if (pollingRef.current) clearInterval(pollingRef.current) }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoJobs.length])

  // Completed non-video jobs: show toast once, then remove after 4s
  useEffect(() => {
    for (const job of jobs) {
      if (job.status === 'completed' && !job.notified) {
        markNotified(job.jobId)
        showToast(job, router)
        setTimeout(() => removeJob(job.jobId), 4000)
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobs.length])

  const activeJobs = jobs.filter((j) => j.status === 'generating')
  if (activeJobs.length === 0) return null

  const typeLabel: Record<string, string> = {
    video:      'Video',
    blog:       'Blog Post',
    image_post: 'Image Post',
  }

  return (
    <div className="fixed inset-x-0 top-0 z-[9999] border-b border-gray-200 bg-white/95 px-4 py-2.5 shadow-sm backdrop-blur-sm">
      <div className="mx-auto flex max-w-5xl flex-col gap-2">
        {activeJobs.map((job) => (
          <div key={job.jobId} className="flex items-center gap-3 text-sm">
            <span className="w-20 shrink-0 text-xs font-medium text-gray-500">{typeLabel[job.type] ?? 'Content'}</span>
            <span className="min-w-0 flex-1 truncate text-xs text-gray-400">{job.topic}</span>
            <div className="h-1.5 w-32 shrink-0 overflow-hidden rounded-full bg-gray-100">
              <div
                className="h-full rounded-full bg-blue-500 transition-all duration-1000"
                style={{ width: `${job.progress}%` }}
              />
            </div>
            <span className="w-8 shrink-0 text-right text-xs text-gray-400">{job.progress}%</span>
            <span className="w-28 shrink-0 text-right text-xs text-blue-500">{progressLabel(job.progress)}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
