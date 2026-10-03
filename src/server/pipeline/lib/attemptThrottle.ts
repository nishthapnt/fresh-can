// Fixed-window attempt limiter that REJECTS instead of waiting. The existing
// SlidingWindowRateLimiter (rateLimiter.ts) blocks until a slot frees, which
// suits outbound provider calls but not an HTTP route that must answer 429.
// In-memory and per-process: a speed bump against hammering the (paid)
// provider validation calls, not a security boundary.
export function createAttemptThrottle(max: number, windowMs: number) {
  let hits: number[] = []
  return {
    tryAcquire(now: number = Date.now()): boolean {
      hits = hits.filter((t) => now - t < windowMs)
      if (hits.length >= max) return false
      hits.push(now)
      return true
    },
  }
}
