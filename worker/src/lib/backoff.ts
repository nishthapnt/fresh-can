// Retry/backoff calculation — replaces n8n's hardcoded, undocumented,
// per-execution retry counters (ARCHITECTURE.MD §3.9/§10) with small,
// provider-specific caps and a simple exponential-ish backoff computed from
// columns already in the approved migration (retry_count/last_error/
// updated_at) — no new column, per docs/DECISIONS.md #7's "migration stays
// untouched" constraint carried into this implementation.

export interface BackoffCheckInput {
  lastError: string | null
  retryCount: number
  updatedAt: Date
  now?: Date
  baseDelayMs?: number
}

/**
 * True once enough time has passed since the last failed attempt to retry
 * now. `updatedAt` comes from the DB server's clock (Postgres `now()`) while
 * `now` is the calling process's own clock — these are two different
 * machines and can disagree by a second or more even when both are
 * NTP-synced. Clamping elapsed time at 0 means "the DB says this happened
 * slightly in my future" is treated as "just now," not as a negative
 * duration that would incorrectly fail the readiness check (found via a
 * real ~1.3s skew between this worker and the live Supabase project during
 * testing — not a hypothetical edge case).
 */
export function isReadyToRetry(input: BackoffCheckInput): boolean {
  const { lastError, retryCount, updatedAt, now = new Date(), baseDelayMs = 5000 } = input
  if (!lastError) return true // never failed — nothing to back off from
  const elapsedMs = Math.max(0, now.getTime() - updatedAt.getTime())
  const requiredDelayMs = retryCount * baseDelayMs
  return elapsedMs >= requiredDelayMs
}

export function hasExceededMaxAttempts(retryCount: number, maxAttempts: number): boolean {
  return retryCount >= maxAttempts
}

// Per-provider caps — small and documented here, unlike n8n's scattered
// 12/60/200 magic numbers (ARCHITECTURE.MD §3.9). Blog has no long polling
// chains like Video, so these stay small.
export const MAX_ATTEMPTS = {
  openai: 3,
  kie: 5,
} as const

export type ProviderName = keyof typeof MAX_ATTEMPTS
