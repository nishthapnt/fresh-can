// Generic sliding-window rate limiter — pulled out of kieRateLimiter.ts
// (2026-09-19) so a second provider (upload-post.com) could get its own
// instance without duplicating this class. One instance per provider
// account, not per caller — see kieRateLimiter.ts/uploadPostRateLimiter.ts
// for why each provider's limit is account-wide, not per-job/per-pipeline.
export class SlidingWindowRateLimiter {
  private timestamps: number[] = []

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  async acquire(): Promise<void> {
    for (;;) {
      const now = Date.now()
      this.timestamps = this.timestamps.filter((t) => now - t < this.windowMs)
      if (this.timestamps.length < this.max) {
        this.timestamps.push(now)
        return
      }
      const oldest = this.timestamps[0]
      const waitMs = Math.max(this.windowMs - (now - oldest) + 1, 10)
      await new Promise((resolve) => setTimeout(resolve, waitMs))
    }
  }
}
