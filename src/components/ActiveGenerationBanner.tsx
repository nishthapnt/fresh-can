'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { CheckCircle2, Loader2, XCircle } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useNewContentStore } from '../stores/newContentStore'
import { getJobGenerationState, type JobGenerationState } from '../lib/jobGenerationState'

export default function ActiveGenerationBanner() {
  const { status, pendingJobId, topic, restoreSession, clearOnCancel } = useNewContentStore()
  const [genState, setGenState] = useState<JobGenerationState>('pending')

  useEffect(() => {
    restoreSession()
  }, [restoreSession])

  useEffect(() => {
    if (status !== 'pending' || !pendingJobId) return
    let active = true

    const recheck = () => {
      getJobGenerationState(pendingJobId).then((s) => { if (active) setGenState(s) })
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
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'content_pipelines', filter: `job_id=eq.${pendingJobId}` },
        recheck,
      )
      .subscribe()

    return () => { active = false; supabase.removeChannel(channel) }
  }, [status, pendingJobId])

  if (status !== 'pending' || !pendingJobId) return null

  const isFailed = genState === 'failed'
  const isReady = genState === 'ready'

  return (
    <div
      className={`mb-6 flex items-center gap-3 rounded-xl border px-4 py-3 ${
        isFailed ? 'border-gray-200 bg-gray-50' : 'border-amber-200 bg-amber-50'
      }`}
    >
      <div
        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${
          isFailed ? 'bg-gray-100' : 'bg-amber-100'
        }`}
      >
        {isFailed ? (
          <XCircle className="h-4 w-4 text-gray-500" />
        ) : isReady ? (
          <CheckCircle2 className="h-4 w-4 text-amber-600" />
        ) : (
          <Loader2 className="h-4 w-4 animate-spin text-amber-600" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <p className={`text-sm font-semibold ${isFailed ? 'text-gray-700' : 'text-amber-900'}`}>
          {isFailed ? 'Generation stopped' : isReady ? 'Content ready for review' : 'Content generation in progress'}
        </p>
        <p className={`truncate text-xs ${isFailed ? 'text-gray-500' : 'text-amber-700'}`}>{topic}</p>
      </div>
      {isFailed ? (
        <button
          type="button"
          onClick={() => clearOnCancel(pendingJobId)}
          className="shrink-0 rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
        >
          Dismiss
        </button>
      ) : (
        <Link
          href={`/dashboard/jobs/${pendingJobId}`}
          className="shrink-0 rounded-lg border border-amber-300 bg-white px-3 py-1.5 text-xs font-medium text-amber-800 hover:bg-amber-50"
        >
          {isReady ? 'Review & Approve →' : 'View & Approve →'}
        </Link>
      )}
    </div>
  )
}
