import { supabase } from './supabase'

export type JobGenerationState = 'pending' | 'ready' | 'failed'

/**
 * Shared by ActiveGenerationBanner and the New Content page's own pending-job
 * banner. Deliberately NOT based on content_jobs.status — see
 * ActiveGenerationBanner.tsx's header for why that column can't be trusted.
 * 'failed' covers both a real provider failure AND a user cancel (the
 * /api/jobs/[jobId]/{blog,image,video}/cancel routes all write
 * content_pipelines.status = 'failed' — see those routes' CANCELLED_MESSAGE)
 * — either way, nothing further is coming, so the banner must stop
 * spinning forever instead of waiting on content_drafts/generated_content
 * rows that a cancelled pipeline will never write.
 */
export async function getJobGenerationState(jobId: string): Promise<JobGenerationState> {
  const { data: job } = await supabase
    .from('content_jobs')
    .select('content_types, language')
    .eq('id', jobId)
    .maybeSingle()
  if (!job) return 'pending'

  const contentTypes = (job.content_types ?? []) as string[]
  if (contentTypes.length === 0) return 'pending'
  const languages = job.language === 'BOTH' ? ['EN', 'FR'] : [job.language as string]

  const { data: pipelines } = await supabase
    .from('content_pipelines')
    .select('status')
    .eq('job_id', jobId)
    .in('content_type', contentTypes)
  if ((pipelines ?? []).some((p) => p.status === 'failed')) return 'failed'

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

  return readiness.every(Boolean) ? 'ready' : 'pending'
}
