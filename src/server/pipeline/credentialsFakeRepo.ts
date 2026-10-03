// In-memory CredentialRepo for tests (credentials.ts + the settings routes).
import { randomUUID } from 'node:crypto'
import type { CredentialRepo, CredentialRow, JobPins } from './credentials'
import type { ProviderId } from './credentialProviders'

export function createFakeCredentialRepo() {
  const rows = new Map<string, CredentialRow>()
  const jobs = new Map<string, JobPins | null>()
  /** Job ids a purge must treat as unfinished. */
  const unfinished = new Set<string>()

  const repo: CredentialRepo = {
    async listActive() {
      return [...rows.values()].filter((r) => !r.retired_at)
    },
    async findById(id) {
      return rows.get(id) ?? null
    },
    async replaceActive(provider, row) {
      const now = new Date().toISOString()
      for (const r of rows.values()) if (r.provider === provider && !r.retired_at) r.retired_at = now
      const created: CredentialRow = {
        id: randomUUID(), provider, created_at: now, updated_at: now, retired_at: null, ...row,
      }
      rows.set(created.id, created)
      return created
    },
    async retireActive(provider) {
      let any = false
      for (const r of rows.values()) {
        if (r.provider === provider && !r.retired_at) { r.retired_at = new Date().toISOString(); any = true }
      }
      return any
    },
    async getJobPins(jobId) {
      if (!jobs.has(jobId)) throw new Error('job_not_found')
      return jobs.get(jobId) ?? null
    },
    async setJobPinsIfUnset(jobId, pins) {
      if (jobs.get(jobId)) return false
      jobs.set(jobId, pins)
      return true
    },
    async setJobPins(jobId, pins) {
      jobs.set(jobId, pins)
    },
    async findPurgeable(graceMs) {
      const out: string[] = []
      for (const r of rows.values()) {
        if (!r.retired_at || Date.now() - Date.parse(r.retired_at) < graceMs) continue
        const pinnedByUnfinished = [...jobs.entries()].some(
          ([jobId, pins]) => unfinished.has(jobId) && pins?.[r.provider as ProviderId] === r.id,
        )
        if (!pinnedByUnfinished) out.push(r.id)
      }
      return out
    },
    async deleteByIds(ids) {
      for (const id of ids) {
        if (rows.get(id)?.retired_at) rows.delete(id)
      }
    },
  }

  return { repo, rows, jobs, unfinished, addJob: (id: string) => jobs.set(id, null) }
}
