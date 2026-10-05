'use client'

import { useEffect, useState } from 'react'
import { AlertCircle } from 'lucide-react'
import { getJobProblems, type JobProblem } from '@/services/contentService'

const POLL_MS = 10_000
const TYPE_LABEL: Record<string, string> = { video: 'Video', image_post: 'Image', blog: 'Blog' }

/** Banner listing why this job's content failed or stalled; renders nothing when there are no problems. */
export default function JobProblems({ jobId }: { jobId: string }) {
  const [problems, setProblems] = useState<JobProblem[]>([])
  const [loadError, setLoadError] = useState(false)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const result = await getJobProblems([jobId])
        if (cancelled) return
        setProblems(result[jobId] ?? [])
        setLoadError(false)
      } catch {
        if (!cancelled) setLoadError(true)
      }
    }
    load()
    const timer = setInterval(load, POLL_MS)
    return () => { cancelled = true; clearInterval(timer) }
  }, [jobId])

  if (loadError && problems.length === 0) {
    return <p className="text-xs text-muted-foreground">Couldn&apos;t check this job for errors — will retry.</p>
  }
  if (problems.length === 0) return null

  return (
    <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-4">
      <div className="flex items-center gap-2">
        <AlertCircle className="h-5 w-5 shrink-0 text-red-500" />
        <p className="text-sm font-semibold text-red-700">
          {problems.length === 1 ? 'Something went wrong' : `${problems.length} things went wrong`}
        </p>
      </div>
      <ul className="mt-2 space-y-1.5 pl-7">
        {problems.map((p, i) => (
          <li key={i} className="text-xs text-red-700">
            <span className="font-semibold">
              {TYPE_LABEL[p.contentType] ?? p.contentType}
              {p.language ? ` (${p.language})` : ''}:
            </span>{' '}
            {p.message}
          </li>
        ))}
      </ul>
      <p className="mt-2 pl-7 text-xs text-red-600">Use Retry on the affected tab to resume.</p>
    </div>
  )
}
