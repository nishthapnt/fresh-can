// Throttles submissions to upload-post.com's FFmpeg Editor API — every
// avMerger.ts pass (scale, scene duration-match, video-concat,
// audio-concat, mux, caption) and every social-publish call share one
// upload-post.com account, so they share one budget here too.
//
// Confirmed live (2026-09-19): a real 8-scene BOTH-language render hit a
// 429 whose own body gave the account's exact limit — {"mode":"enforce",
// "retry_after_seconds":60,"violations":[{"window":"per_min",
// "window_seconds":60,"count":63,"limit":62,...}]} — 62 requests per 60s,
// account-wide. The burst that tripped it was renderLanguageTrack.ts's new
// per-scene duration-match pass (added earlier the same session): an
// 8-scene BOTH job fires up to 8 scenes x 2 language tracks = 16
// submitSceneDurationMatch calls via one Promise.all, with nothing
// throttling them, on top of the render step's other already-unthrottled
// concat/mux/caption calls and generateSceneVisual.ts's per-scene scale
// calls from the same job. Capped at 45/60s (not 62) to leave real
// headroom for jitter, the render step's own several-call-per-track
// bursts, and any other traffic (e.g. social posting) sharing this same
// account.
//
// One process-wide instance (the module-level export below), not one per
// caller — the limit is per-account, not per-job/per-pipeline/per-track.
import { SlidingWindowRateLimiter } from './rateLimiter'

export const uploadPostSubmitLimiter = new SlidingWindowRateLimiter(45, 60_000)
