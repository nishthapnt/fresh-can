import Link from 'next/link'
import { Check, Loader2 } from 'lucide-react'
import StatusBadge from '@/components/StatusBadge'
import { RelativeTime } from '@/components/ui/relative-time'
import { cn } from '@/lib/utils'
import type { ContentJob, JobStatus } from '@/types/content'
import type { JobProblem } from '@/services/contentService'

const STEPS = ['Drafting', 'Review', 'Generating', 'Ready'] as const

// Index of the step currently in progress for each job status. `ready` is
// past the last step; `failed` has no known step, so it renders a red bar.
const ACTIVE_STEP: Record<JobStatus, number> = {
  pending: 0,
  draft_ready: 1,
  approved: 2,
  generating: 2,
  ready: STEPS.length,
  failed: -1,
}

const DAY_MS = 24 * 60 * 60 * 1000

/** Jobs worth surfacing: anything still moving, plus failures from the last 24h. */
export function selectInProgressJobs(jobs: ContentJob[], limit = 5): ContentJob[] {
  const now = Date.now()
  return jobs
    .filter((j) => j.status !== 'ready' && (j.status !== 'failed' || now - new Date(j.created_at).getTime() < DAY_MS))
    .slice(0, limit)
}

function Stepper({ status }: { status: JobStatus }) {
  const active = ACTIVE_STEP[status]
  const failed = status === 'failed'
  return (
    <ol className="flex items-center gap-1" aria-label={`Progress: ${failed ? 'failed' : STEPS[Math.min(active, STEPS.length - 1)]}`}>
      {STEPS.map((label, i) => {
        const done = !failed && i < active
        const current = !failed && i === active
        return (
          <li key={label} className="flex min-w-0 flex-1 flex-col gap-1" aria-current={current ? 'step' : undefined}>
            <span
              className={cn(
                'h-1.5 rounded-full',
                failed ? 'bg-red-200' : done ? 'bg-primary' : current ? 'animate-pulse bg-primary/50' : 'bg-border',
              )}
            />
            <span className={cn('flex items-center gap-1 truncate text-[10px]', current ? 'font-semibold text-foreground' : 'text-muted-foreground')}>
              {done && <Check className="h-2.5 w-2.5 shrink-0 text-primary" />}
              {current && status !== 'draft_ready' && <Loader2 className="h-2.5 w-2.5 shrink-0 animate-spin" />}
              <span className="truncate">{label}</span>
            </span>
          </li>
        )
      })}
    </ol>
  )
}

export default function JobProgressList({ jobs, problems = {} }: { jobs: ContentJob[]; problems?: Record<string, JobProblem[]> }) {
  if (jobs.length === 0) return null
  return (
    <section aria-label="Jobs in progress" className="space-y-3">
      <h2 className="text-sm font-semibold text-foreground">In progress</h2>
      <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {jobs.map((job) => (
          <li key={job.id}>
            <Link
              href={`/dashboard/jobs/${job.id}`}
              className="block space-y-3 rounded-lg border border-border bg-background p-4 outline-none transition-colors hover:border-primary/40 focus-visible:ring-2 focus-visible:ring-primary"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-foreground">{job.topic}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {job.content_types.map((t) => (t === 'image_post' ? 'Image' : t === 'video' ? 'Video' : 'Blog')).join(' · ')}
                    {' · '}
                    <RelativeTime value={job.created_at} />
                  </p>
                </div>
                <StatusBadge status={job.status} />
              </div>
              <Stepper status={job.status} />
              {job.status === 'failed' && problems[job.id]?.[0] && (
                <p className="line-clamp-2 text-xs text-red-600" title={problems[job.id][0].message}>
                  {problems[job.id][0].message}
                  {problems[job.id].length > 1 ? ` (+${problems[job.id].length - 1} more)` : ''}
                </p>
              )}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  )
}
