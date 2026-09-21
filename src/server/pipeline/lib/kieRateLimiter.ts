// Throttles new-generation-request submissions to KIE.ai — Flux Kontext
// (KieImageGenerator), Seedance 1.5 Pro image-to-video (KieVideoGenerator),
// and nano-banana-2 (NanoBananaImageGenerator) all share one KIE.ai account/API
// key, so they share one budget here too. Matches KIE's documented
// account-wide limit (2026-09-14, KIE.ai "Rate Limits & Concurrency"): up to
// 20 new generation requests per 10 seconds, with 100+ concurrent running
// tasks allowed once submitted. Capped at 15/10s (not 20) to leave headroom
// for KIE.ai's own queuing jitter and any other traffic on this account.
//
// Only .submit() calls consume a slot — polling (record-info/recordInfo) is
// a status GET, not a "new generation request," and falls under the much
// higher concurrent-tasks allowance instead, so it's deliberately never
// gated here.
//
// One process-wide instance (the module-level export below), not one per
// caller — the limit is per-account, not per-job or per-pipeline.
import { SlidingWindowRateLimiter } from './rateLimiter'

export const kieSubmitLimiter = new SlidingWindowRateLimiter(15, 10_000)
