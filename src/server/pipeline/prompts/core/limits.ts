// Layer 4 (PROMPT_REFACTOR_BRIEF.md §4.5/§7) — the single source of truth
// for every per-endpoint prompt character budget. Each number is verified
// against real provider behavior, not guessed: see docs/PROMPT_ARCHITECTURE.md's
// Phase 5 section for the full write-up of which adapter is actually wired
// in production today (not just what's defined) and the owner's own
// confirmation of the numbers below.
export const PROMPT_LIMITS = {
  /** KieImageGenerator — KIE.ai's Flux Kontext dedicated endpoint
   *  (/api/v1/flux/kontext/generate), used by video's scene images AND
   *  character-ref (both route through the same adapter — adapters/kie.ts's
   *  KieImageGenerator). Confirmed live error text: "The prompt word cannot
   *  exceed 3000 characters." A small margin, not the ~100 chars an earlier
   *  pass used — see compose.ts's own history for why a large margin costs
   *  real scene-content budget on a fixed overhead that's already close to
   *  the cap. (KieSceneImageGenerator's tighter, ~1300-char-observed Market
   *  endpoint cap is NOT reflected here — that adapter was replaced in
   *  production on 2026-09-19 specifically because its real cap kept
   *  failing ordinary scenes; it's dead code, not a live constraint.) */
  sceneImage: 2995,
  /** KieVideoGenerator — Seedance 1.5 Pro. Documented at
   *  docs.kie.ai/market/bytedance/seedance-1-5-pro: `input.prompt` is
   *  3-2500 characters. */
  sceneVideo: 2450,
} as const

// Blog hero/inline and image_post's photo (composeHeroPrompt/
// composeInlinePrompt/composePhotoPrompt) are deliberately NOT budgeted
// here. They're currently routed through NanoBananaImageGenerator
// (nano-banana-2) as a temporary test-cost measure (see inngest/functions/
// blog.ts's and image.ts's own comments) with no documented prompt-length
// limit found, and have never hit a real length failure in production —
// owner-confirmed (PROMPT_REFACTOR_BRIEF.md §16.1 follow-up) to leave
// unbounded until they move back onto KieImageGenerator, rather than budget
// them against a limit that may not even apply to the model they're
// actually running on today.
