import { describe, it, expect } from 'vitest'
import { isReadyToRetry, hasExceededMaxAttempts, MAX_ATTEMPTS } from './backoff'

describe('isReadyToRetry', () => {
  it('is ready immediately when there has never been a failure', () => {
    expect(
      isReadyToRetry({ lastError: null, retryCount: 0, updatedAt: new Date() }),
    ).toBe(true)
  })

  it('is not ready right after a failure (retryCount=1, base delay not yet elapsed)', () => {
    const now = new Date('2026-01-01T00:00:00Z')
    const updatedAt = new Date('2026-01-01T00:00:01Z') // 1s "ago" relative to now — same instant really
    expect(
      isReadyToRetry({
        lastError: 'boom',
        retryCount: 1,
        updatedAt: now,
        now,
        baseDelayMs: 5000,
      }),
    ).toBe(false)
    void updatedAt
  })

  it('becomes ready once the required delay has elapsed', () => {
    const updatedAt = new Date('2026-01-01T00:00:00Z')
    const now = new Date(updatedAt.getTime() + 5000) // exactly one baseDelay later
    expect(
      isReadyToRetry({ lastError: 'boom', retryCount: 1, updatedAt, now, baseDelayMs: 5000 }),
    ).toBe(true)
  })

  it('scales the required delay with retryCount', () => {
    const updatedAt = new Date('2026-01-01T00:00:00Z')
    const now = new Date(updatedAt.getTime() + 5000) // only 1 base delay elapsed
    // retryCount=3 requires 3 * 5000ms = 15000ms — not ready yet
    expect(
      isReadyToRetry({ lastError: 'boom', retryCount: 3, updatedAt, now, baseDelayMs: 5000 }),
    ).toBe(false)
  })

  it('clamps negative elapsed time from clock skew instead of treating it as "not ready"', () => {
    // updatedAt is "in the future" relative to now — a DB-server-ahead skew,
    // exactly what a real ~1.3s skew against a live Supabase project produced.
    const now = new Date('2026-01-01T00:00:00.000Z')
    const updatedAt = new Date('2026-01-01T00:00:01.300Z')
    expect(
      isReadyToRetry({ lastError: 'boom', retryCount: 1, updatedAt, now, baseDelayMs: 0 }),
    ).toBe(true) // baseDelayMs=0 means "ready immediately" — skew must not defeat that
  })
})

describe('hasExceededMaxAttempts', () => {
  it('is false below the cap', () => {
    expect(hasExceededMaxAttempts(2, MAX_ATTEMPTS.openai)).toBe(false)
  })

  it('is true at or above the cap', () => {
    expect(hasExceededMaxAttempts(3, MAX_ATTEMPTS.openai)).toBe(true)
    expect(hasExceededMaxAttempts(5, MAX_ATTEMPTS.kie)).toBe(true)
  })
})
