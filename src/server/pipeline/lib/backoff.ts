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
//
// Video's three new entries are initial placeholders (M0) — n8n's old
// per-stage caps (12 for character-ref/image, 60 for transcription/video,
// 200 for FFmpeg render) were themselves undocumented magic numbers with no
// stated rationale, not a baseline worth inheriting as-is. `kie` is shared
// by both NanoBananaImageGenerator (scene images, character-ref) and
// KieVideoGenerator (scene clips) since they're the same provider/account,
// not per-asset-type.
// Tune elevenlabs/assemblyai against real failure rates once M3/M4 are
// live-tested.
//
// upload_post bumped 3 -> 4 (2026-09-19) after a real 429 rate-limit
// failure (see uploadPostRateLimiter.ts) exhausted all 3 attempts in ~21s
// total — nowhere near the provider's own documented 60s cooldown
// (`retry_after_seconds: 60` in its error body). renderLanguageTrack.ts's
// own call site was bumped in step with this (backoffBaseDelayMs
// 5000 -> 20000ms), so the schedule of required waits before each attempt
// is now 20s/40s/60s — comfortably clearing a real 60s cooldown by the
// last attempt, instead of giving up three times faster than the provider
// asked for.
export const MAX_ATTEMPTS = {
  openai: 3,
  kie: 5,
  elevenlabs: 3,
  assemblyai: 5,
  upload_post: 4,
} as const

export type ProviderName = keyof typeof MAX_ATTEMPTS
