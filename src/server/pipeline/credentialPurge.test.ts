import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createSupabaseCredentialRepo } from './credentials'

// Minimal in-memory stand-in for the few supabase-js query shapes
// findPurgeable uses, so the REAL lifecycle logic is exercised.
type Row = Record<string, unknown>
function fakeClient(tables: Record<string, Row[]>): SupabaseClient {
  function builder(name: string) {
    let rows = [...(tables[name] ?? [])]
    const b: Record<string, unknown> = {
      select: () => b,
      in: (col: string, vals: unknown[]) => { rows = rows.filter((r) => vals.includes(r[col])); return b },
      not: (col: string) => { rows = rows.filter((r) => r[col] != null); return b },
      lt: (col: string, v: string) => { rows = rows.filter((r) => String(r[col]) < v); return b },
      contains: (col: string, obj: Record<string, unknown>) => {
        rows = rows.filter((r) => Object.entries(obj).every(([k, v]) => (r[col] as Row | null)?.[k] === v))
        return b
      },
      then: (resolve: (v: unknown) => unknown) => resolve({ data: rows, error: null }),
    }
    return b
  }
  return { from: builder } as unknown as SupabaseClient
}

const OLD = '2020-01-01T00:00:00.000Z'
const A = 'cred-A'

function world(job: { status: string }, pipelines: Row[], tracks: Row[]) {
  return createSupabaseCredentialRepo(
    fakeClient({
      api_credentials: [{ id: A, provider: 'openai', retired_at: OLD }],
      content_jobs: [{ id: 'j1', status: job.status, credential_pins: { openai: A } }],
      content_pipelines: pipelines,
      content_language_tracks: tracks,
    }),
  )
}
const p = (status: string) => ({ id: 'p1', job_id: 'j1', status })
const t = (status: string) => ({ content_pipeline_id: 'p1', status })

describe('findPurgeable — only purge when no job can still run, retry or resume', () => {
  it('purges when the job is fully settled (job ready, pipeline ready, all tracks ready)', async () => {
    expect(await world({ status: 'ready' }, [p('ready')], [t('ready'), t('ready')]).findPurgeable(0)).toEqual([A])
    expect(await world({ status: 'posted' }, [p('ready')], [t('ready')]).findPurgeable(0)).toEqual([A])
  })

  it('purges when no job pins the credential at all', async () => {
    const repo = createSupabaseCredentialRepo(
      fakeClient({ api_credentials: [{ id: A, provider: 'openai', retired_at: OLD }], content_jobs: [] }),
    )
    expect(await repo.findPurgeable(0)).toEqual([A])
  })

  it.each([
    ['pipeline mid-flight', 'generating', [p('generating')], [t('generating')]],
    ['awaiting user approval (draft_ready)', 'draft_ready', [p('draft_ready')], []],
    ['approved, rendering', 'generating', [p('ready')], [t('rendering')]],
    ['track waiting on shared visuals', 'generating', [p('generating')], [t('awaiting_shared')]],
    ['FAILED track is retryable via the retry route', 'failed', [p('ready')], [t('ready'), t('failed')]],
    ['user-cancelled (failed pipeline)', 'failed', [p('failed')], [t('failed')]],
    ['stale track', 'generating', [p('ready')], [t('stale')]],
    ['pipeline ready but no tracks yet', 'generating', [p('ready')], []],
    ['job pinned but no pipeline yet (e.g. image questions stage)', 'pending', [], []],
    ['job status not terminal even though pipelines look ready', 'generating', [p('ready')], [t('ready')]],
  ])('retains: %s', async (_name, jobStatus, pipelines, tracks) => {
    expect(await world({ status: jobStatus }, pipelines, tracks).findPurgeable(0)).toEqual([])
  })

  it('retains versions retired within the grace period', async () => {
    const repo = createSupabaseCredentialRepo(
      fakeClient({
        api_credentials: [{ id: A, provider: 'openai', retired_at: new Date().toISOString() }],
        content_jobs: [],
      }),
    )
    expect(await repo.findPurgeable(24 * 60 * 60 * 1000)).toEqual([])
  })

  it('retains when the pinning job row cannot be found (cannot prove it settled)', async () => {
    const client = fakeClient({
      api_credentials: [{ id: A, provider: 'openai', retired_at: OLD }],
      content_jobs: [{ id: 'j1', status: 'ready', credential_pins: { openai: A } }],
    })
    // job visible to the contains() query but not to the status query
    let calls = 0
    const orig = client.from.bind(client)
    ;(client as unknown as { from: (n: string) => unknown }).from = (n: string) => {
      if (n === 'content_jobs' && ++calls === 2) return fakeClient({ content_jobs: [] }).from('content_jobs')
      return orig(n)
    }
    expect(await createSupabaseCredentialRepo(client).findPurgeable(0)).toEqual([])
  })
})
