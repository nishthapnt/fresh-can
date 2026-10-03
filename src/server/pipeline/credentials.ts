import type { SupabaseClient } from '@supabase/supabase-js'
import { NonRetriableError } from 'inngest'
import { createServiceClient } from './db'
import { decryptSecret, encryptSecret } from './credentialCrypto'
import { PROVIDER_IDS, PROVIDERS, readDefaultProfile, type ProviderId } from './credentialProviders'

// Central, SERVER-ONLY API-credential resolver. Never import this from a
// client component — it decrypts secrets and uses the service-role client.
//
// Resolution order for a provider:
//   custom encrypted credential (api_credentials)  →  else existing env var.
//
// Job consistency: a job pins one credential VERSION per provider
// (content_jobs.credential_pins, version ids only — never key material) the
// first time it needs credentials. Inngest re-runs a function body from the
// top on every step and video/blog jobs span several runs separated by user
// approval, so resolving "whatever is active now" would let a Settings change
// switch accounts mid-job. A Settings change only affects jobs that have not
// pinned yet. Retired versions are retained (not deleted) until no job that can
// still run, retry or resume references them — see purgeRetiredCredentials. If a
// job's pinned version is nonetheless gone, the job FAILS with
// CredentialUnavailableError; it is never re-pinned and never falls back to
// the currently active credential.
//
// Cache invalidation: none needed. api_credentials rows are immutable once
// written (replace = retire + insert a NEW id) and pins are write-once per
// job, so anything cached by credential id / job id can never go stale.

export const DEFAULT_REF = 'default'
/** 'default' (use the env var) or an api_credentials.id (uuid). Not a secret. */
export type CredentialRef = string
export type JobPins = Partial<Record<ProviderId, CredentialRef>>

export interface CredentialRow {
  id: string
  provider: ProviderId
  encrypted_value: string
  last4: string
  profile: string | null
  created_at: string
  updated_at: string
  updated_by: string | null
  retired_at: string | null
}

export interface CredentialRepo {
  listActive(): Promise<CredentialRow[]>
  findById(id: string): Promise<CredentialRow | null>
  replaceActive(
    provider: ProviderId,
    row: { encrypted_value: string; last4: string; profile: string | null; updated_by: string | null },
  ): Promise<CredentialRow>
  /** Returns true if an active credential existed and was retired. */
  retireActive(provider: ProviderId): Promise<boolean>
  /** null = job exists but is not pinned yet (or pins aren't installed). */
  getJobPins(jobId: string): Promise<JobPins | null>
  /** Write-once CAS: returns false if the job was already pinned. */
  setJobPinsIfUnset(jobId: string, pins: JobPins): Promise<boolean>
  setJobPins(jobId: string, pins: JobPins): Promise<void>
  /** Retired credential ids that no job which can still run/retry/resume pins (past the grace period). */
  findPurgeable(graceMs: number): Promise<string[]>
  deleteByIds(ids: string[]): Promise<void>
}

/**
 * A job's pinned credential version no longer exists. The job must FAIL —
 * never fall back to the currently active credential (that would silently
 * move the job to a different account). Non-retriable: retrying can't bring
 * the key back. The message prefix is matched by src/inngest/credentialFailure.ts.
 */
export const CREDENTIAL_UNAVAILABLE_PREFIX = 'Credential unavailable'
export class CredentialUnavailableError extends NonRetriableError {
  constructor(public readonly provider: ProviderId) {
    super(
      `${CREDENTIAL_UNAVAILABLE_PREFIX}: the ${PROVIDERS[provider].label} API key this job started with is no longer available. Start a new job to use the current key.`,
    )
    this.name = 'CredentialUnavailableError'
  }
}

export class CredentialError extends Error {
  constructor(
    public readonly code: 'decrypt_failed' | 'unavailable' | 'job_not_found',
    public readonly provider?: ProviderId,
  ) {
    // Fixed text only — never key material, ciphertext, or env var names.
    super(`Credential error (${code})${provider ? ` for ${provider}` : ''}`)
    this.name = 'CredentialError'
  }
}

export interface ResolvedCredential {
  value: string
  profile: string | null
  source: 'custom' | 'default'
}

const MAX_CACHE = 500
const pinsCache = new Map<string, JobPins>()
const secretCache = new Map<string, ResolvedCredential>()

function remember<K, V>(cache: Map<K, V>, key: K, value: V): void {
  if (cache.size >= MAX_CACHE) {
    const oldest = cache.keys().next()
    if (!oldest.done) cache.delete(oldest.value)
  }
  cache.set(key, value)
}

/** Test hook — drops in-memory caches. */
export function clearCredentialCaches(): void {
  pinsCache.clear()
  secretCache.clear()
}

// Fixed-field logs only: provider / action / result. Never values.
function logEvent(action: string, provider: ProviderId | undefined, result: string): void {
  console.warn(`[credentials] action=${action}${provider ? ` provider=${provider}` : ''} result=${result}`)
}

// ─── Supabase repo ──────────────────────────────────────────────────────────

// Feature not installed yet (migration not applied): table/column/function
// missing. The resolver then behaves exactly as before this feature (env only).
function isNotInstalled(error: { code?: string } | null): boolean {
  return !!error && ['42P01', '42703', '42883', 'PGRST205', 'PGRST204', 'PGRST202'].includes(error.code ?? '')
}

function cleanPins(raw: unknown): JobPins | null {
  if (!raw || typeof raw !== 'object') return null
  const pins: JobPins = {}
  for (const provider of PROVIDER_IDS) {
    const ref = (raw as Record<string, unknown>)[provider]
    if (typeof ref === 'string' && ref) pins[provider] = ref
  }
  return pins
}

export function createSupabaseCredentialRepo(client: SupabaseClient = createServiceClient()): CredentialRepo {
  // A job may still need its pinned credential unless it is fully settled.
  // Lifecycle (audited): pipeline statuses created/drafting/draft_ready/
  // awaiting_approval/approved/generating and track statuses
  // waiting_on_shared/generating/draft_ready/awaiting_approval/approved/
  // awaiting_shared/rendering are mid-flight or waiting on a user approval.
  // 'failed' (incl. user-cancelled) is RETRYABLE — the tracks/[lang]/retry
  // routes re-send track events for failed tracks — and 'stale' is allowed by
  // the schema. A job with no pipeline yet (image questions stage, or not
  // started) will run later. So a job is only settled when its content_jobs
  // status is ready/posted AND it has pipelines AND every pipeline and every
  // track is 'ready'. Anything else retains the credential (the safe
  // direction: a failed job keeps its retired key until it is retried to
  // completion).
  async function jobsMayStillRun(jobIds: string[]): Promise<boolean> {
    const { data: jobs, error: jErr } = await client.from('content_jobs').select('id, status').in('id', jobIds)
    if (jErr) throw jErr
    const jobRows = (jobs ?? []) as Array<{ id: string; status: string }>
    if (jobRows.length < jobIds.length) return true // can't prove it's settled
    if (jobRows.some((j) => j.status !== 'ready' && j.status !== 'posted')) return true

    const { data: pipelines, error } = await client
      .from('content_pipelines')
      .select('id, job_id, status')
      .in('job_id', jobIds)
    if (error) throw error
    const rows = (pipelines ?? []) as Array<{ id: string; job_id: string; status: string }>
    if (jobIds.some((id) => !rows.some((p) => p.job_id === id))) return true
    if (rows.some((p) => p.status !== 'ready')) return true

    const { data: tracks, error: tErr } = await client
      .from('content_language_tracks')
      .select('content_pipeline_id, status')
      .in('content_pipeline_id', rows.map((p) => p.id))
    if (tErr) throw tErr
    const trackRows = (tracks ?? []) as Array<{ content_pipeline_id: string; status: string }>
    if (rows.some((p) => !trackRows.some((t) => t.content_pipeline_id === p.id))) return true
    return trackRows.some((t) => t.status !== 'ready')
  }

  return {
    async listActive() {
      const { data, error } = await client.from('api_credentials').select('*').is('retired_at', null)
      if (isNotInstalled(error)) return []
      if (error) throw error
      return (data ?? []) as CredentialRow[]
    },
    async findById(id) {
      const { data, error } = await client.from('api_credentials').select('*').eq('id', id).maybeSingle()
      if (error) throw error
      return (data as CredentialRow | null) ?? null
    },
    async replaceActive(provider, row) {
      const { data, error } = await client.rpc('replace_active_api_credential', {
        p_provider: provider,
        p_encrypted_value: row.encrypted_value,
        p_last4: row.last4,
        p_profile: row.profile,
        p_updated_by: row.updated_by,
      })
      if (error) throw error
      const saved = await this.findById(data as string)
      if (!saved) throw new CredentialError('unavailable', provider)
      return saved
    },
    async retireActive(provider) {
      const { data, error } = await client
        .from('api_credentials')
        .update({ retired_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq('provider', provider)
        .is('retired_at', null)
        .select('id')
      if (error) throw error
      return (data ?? []).length > 0
    },
    async getJobPins(jobId) {
      const { data, error } = await client.from('content_jobs').select('credential_pins').eq('id', jobId).maybeSingle()
      if (isNotInstalled(error)) return null
      if (error) throw error
      if (!data) throw new CredentialError('job_not_found')
      return cleanPins((data as { credential_pins: unknown }).credential_pins)
    },
    async setJobPinsIfUnset(jobId, pins) {
      const { data, error } = await client
        .from('content_jobs')
        .update({ credential_pins: pins })
        .eq('id', jobId)
        .is('credential_pins', null)
        .select('id')
      if (isNotInstalled(error)) return false
      if (error) throw error
      return (data ?? []).length > 0
    },
    async setJobPins(jobId, pins) {
      const { error } = await client.from('content_jobs').update({ credential_pins: pins }).eq('id', jobId)
      if (error && !isNotInstalled(error)) throw error
    },
    async findPurgeable(graceMs) {
      const cutoff = new Date(Date.now() - graceMs).toISOString()
      const { data, error } = await client
        .from('api_credentials')
        .select('id, provider')
        .not('retired_at', 'is', null)
        .lt('retired_at', cutoff)
      if (isNotInstalled(error)) return []
      if (error) throw error
      const purgeable: string[] = []
      for (const row of (data ?? []) as Array<{ id: string; provider: ProviderId }>) {
        const { data: jobs, error: jErr } = await client
          .from('content_jobs')
          .select('id')
          .contains('credential_pins', { [row.provider]: row.id })
        if (jErr) throw jErr
        const jobIds = ((jobs ?? []) as Array<{ id: string }>).map((j) => j.id)
        if (jobIds.length === 0 || !(await jobsMayStillRun(jobIds))) purgeable.push(row.id)
      }
      return purgeable
    },
    async deleteByIds(ids) {
      if (ids.length === 0) return
      const { error } = await client.from('api_credentials').delete().in('id', ids).not('retired_at', 'is', null)
      if (error) throw error
    },
  }
}

let defaultRepo: CredentialRepo | null = null
function repoOrDefault(repo?: CredentialRepo): CredentialRepo {
  if (repo) return repo
  defaultRepo ??= createSupabaseCredentialRepo()
  return defaultRepo
}

// ─── Resolution ─────────────────────────────────────────────────────────────

function resolveDefault(provider: ProviderId): ResolvedCredential {
  // readDefault() throws when the env var is unset — identical to the
  // pre-feature behavior of reading env.X_API_KEY directly.
  return { value: PROVIDERS[provider].readDefault(), profile: readDefaultProfile(provider), source: 'default' }
}

function decryptRow(row: CredentialRow): ResolvedCredential {
  try {
    return { value: decryptSecret(row.encrypted_value, row.provider), profile: row.profile, source: 'custom' }
  } catch {
    // Deliberately NO fallback to the env key: silently using a different
    // account than the one that was configured is worse than failing.
    logEvent('decrypt', row.provider, 'failure')
    throw new CredentialError('decrypt_failed', row.provider)
  }
}

/** null when the referenced version no longer exists (purged). */
async function materialize(provider: ProviderId, ref: CredentialRef, repo: CredentialRepo): Promise<ResolvedCredential | null> {
  if (ref === DEFAULT_REF) return resolveDefault(provider)
  const cached = secretCache.get(ref)
  if (cached) return cached
  const row = await repo.findById(ref)
  if (!row || row.provider !== provider) return null
  const resolved = decryptRow(row)
  remember(secretCache, ref, resolved)
  return resolved
}

function snapshotFromActive(active: CredentialRow[]): JobPins {
  const pins: JobPins = {}
  for (const provider of PROVIDER_IDS) {
    pins[provider] = active.find((r) => r.provider === provider)?.id ?? DEFAULT_REF
  }
  return pins
}

/** Pins every provider for the job (write-once) and returns the effective pins. */
async function loadOrCreatePins(jobId: string, repo: CredentialRepo): Promise<JobPins> {
  const cached = pinsCache.get(jobId)
  if (cached) return cached

  const existing = await repo.getJobPins(jobId)
  if (existing) {
    remember(pinsCache, jobId, existing)
    return existing
  }

  const snapshot = snapshotFromActive(await repo.listActive())
  if (await repo.setJobPinsIfUnset(jobId, snapshot)) {
    remember(pinsCache, jobId, snapshot)
    return snapshot
  }
  // Lost the race (or pins aren't installed): prefer whatever got persisted.
  const raced = await repo.getJobPins(jobId)
  if (raced) {
    remember(pinsCache, jobId, raced)
    return raced
  }
  return snapshot // not persisted (feature not installed) — not cached
}

/**
 * Pin a job's credentials at job start (idempotent, write-once). Called from
 * the generate routes so the account is fixed when the job starts; the
 * resolver also pins lazily on first use for jobs that predate this feature.
 */
export async function pinJobCredentials(jobId: string, repo?: CredentialRepo): Promise<void> {
  await loadOrCreatePins(jobId, repoOrDefault(repo))
}

export interface ResolveOptions {
  /** Resolve through this job's pinned credential versions. */
  jobId?: string
  /** Resolve a specific version (see getActiveCredentialRef). Wins over jobId. */
  ref?: CredentialRef
  repo?: CredentialRepo
}

export async function resolveCredential(provider: ProviderId, opts: ResolveOptions = {}): Promise<ResolvedCredential> {
  const repo = repoOrDefault(opts.repo)

  if (opts.ref) {
    const resolved = await materialize(provider, opts.ref, repo)
    if (!resolved) throw new CredentialUnavailableError(provider)
    return resolved
  }

  if (opts.jobId) {
    const pins = await loadOrCreatePins(opts.jobId, repo)
    const ref = pins[provider] ?? DEFAULT_REF
    const resolved = await materialize(provider, ref, repo)
    // Pinned version is gone: fail explicitly. Deliberately NO re-pin and NO
    // fallback to the active credential.
    if (!resolved) throw new CredentialUnavailableError(provider)
    return resolved
  }

  const active = (await repo.listActive()).find((r) => r.provider === provider)
  if (!active) return resolveDefault(provider)
  const cached = secretCache.get(active.id)
  if (cached) return cached
  const resolved = decryptRow(active)
  remember(secretCache, active.id, resolved)
  return resolved
}

/** The API key for `provider`. Pass `jobId` from any job-scoped code path. */
export async function getApiKey(provider: ProviderId, opts: ResolveOptions = {}): Promise<string> {
  return (await resolveCredential(provider, opts)).value
}

/** upload-post key + the profile that belongs to the SAME account (null = none configured). */
export async function getUploadPostAccount(
  opts: ResolveOptions = {},
): Promise<{ apiKey: string; profile: string | null }> {
  const resolved = await resolveCredential('upload_post', opts)
  return { apiKey: resolved.value, profile: resolved.profile }
}

/**
 * The upload-post profile alone, WITHOUT reading the API key — preserves the
 * existing "check the optional profile before the required key" ordering in
 * social.ts/connection-status (an unset default key throws; an unset profile
 * must still mean "social not configured", not an error).
 */
export async function getUploadPostProfile(opts: ResolveOptions = {}): Promise<string | null> {
  const repo = repoOrDefault(opts.repo)
  const ref = opts.ref ?? (await getActiveCredentialRef('upload_post', repo))
  if (ref === DEFAULT_REF) return readDefaultProfile('upload_post')
  return (await resolveCredential('upload_post', { ref, repo })).profile
}

/** Non-secret id of the credential currently active for new work. Safe to store/return from Inngest steps. */
export async function getActiveCredentialRef(provider: ProviderId, repo?: CredentialRepo): Promise<CredentialRef> {
  const active = (await repoOrDefault(repo).listActive()).find((r) => r.provider === provider)
  return active?.id ?? DEFAULT_REF
}

// ─── Settings operations (used by /api/settings/keys routes) ────────────────

export interface CredentialStatus {
  provider: ProviderId
  label: string
  source: 'custom' | 'default'
  last4: string | null
  updatedAt: string | null
  /** upload_post only — non-secret profile of the custom account. */
  profile: string | null
  /** Whether the env fallback exists (never its value). */
  defaultConfigured: boolean
}

function toStatus(provider: ProviderId, row: CredentialRow | undefined): CredentialStatus {
  return {
    provider,
    label: PROVIDERS[provider].label,
    source: row ? 'custom' : 'default',
    last4: row?.last4 ?? null,
    updatedAt: row?.updated_at ?? null,
    profile: row?.profile ?? null,
    defaultConfigured: PROVIDERS[provider].hasDefault(),
  }
}

export async function listCredentialStatuses(repo?: CredentialRepo): Promise<CredentialStatus[]> {
  const active = await repoOrDefault(repo).listActive()
  return PROVIDER_IDS.map((p) => toStatus(p, active.find((r) => r.provider === p)))
}

export async function saveCredential(
  provider: ProviderId,
  input: { value: string; profile: string | null; updatedBy: string | null },
  repo?: CredentialRepo,
): Promise<CredentialStatus> {
  const r = repoOrDefault(repo)
  const encrypted_value = encryptSecret(input.value, provider)
  const saved = await r.replaceActive(provider, {
    encrypted_value,
    last4: input.value.slice(-4),
    profile: input.profile,
    updated_by: input.updatedBy,
  })
  logEvent('save', provider, 'success')
  await purgeRetiredCredentials(r)
  return toStatus(provider, saved)
}

export async function resetCredential(provider: ProviderId, repo?: CredentialRepo): Promise<boolean> {
  const r = repoOrDefault(repo)
  const removed = await r.retireActive(provider)
  logEvent('reset', provider, removed ? 'success' : 'nothing_to_reset')
  await purgeRetiredCredentials(r)
  return removed
}

/** Retired versions linger this long even if unreferenced (covers in-flight non-job work, e.g. a social publish run). */
export const PURGE_GRACE_MS = 24 * 60 * 60 * 1000

/**
 * Deletes retired credential versions that no job able to still run, retry or
 * resume pins (settled = job ready/posted, every pipeline and track 'ready'). Best
 * effort: a failure is logged and never blocks the caller.
 */
export async function purgeRetiredCredentials(repo?: CredentialRepo, graceMs: number = PURGE_GRACE_MS): Promise<number> {
  const r = repoOrDefault(repo)
  try {
    const ids = await r.findPurgeable(graceMs)
    await r.deleteByIds(ids)
    return ids.length
  } catch {
    logEvent('purge', undefined, 'failure')
    return 0
  }
}
