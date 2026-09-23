// Layer 4 (PROMPT_REFACTOR_BRIEF.md §4.5/§7) — the single source of truth
// for every per-endpoint prompt character budget. Each number is verified
// against real provider behavior, not guessed: see docs/PROMPT_ARCHITECTURE.md's
// Phase 5 section for the full write-up of which adapter is actually wired
// in production today (not just what's defined) and the owner's own
// confirmation of the numbers below.
export const PROMPT_LIMITS = {
  /** Originally measured against KieImageGenerator — KIE.ai's Flux Kontext
   *  dedicated endpoint (/api/v1/flux/kontext/generate), used by video's
   *  scene images AND character-ref through 2026-09-22. Confirmed live
   *  error text: "The prompt word cannot exceed 3000 characters." A small
   *  margin, not the ~100 chars an earlier pass used — see compose.ts's
   *  own history for why a large margin costs real scene-content budget
   *  on a fixed overhead that's already close to the cap. (KieSceneImageGenerator's
   *  tighter, ~1300-char-observed Market endpoint cap is NOT reflected
   *  here — that adapter was replaced in production on 2026-09-19
   *  specifically because its real cap kept failing ordinary scenes; it's
   *  dead code, not a live constraint.)
   *
   *  Video's scene images/character-ref permanently moved to
   *  NanoBananaImageGenerator on 2026-09-23 (adapters/nanoBanana.ts), which
   *  has no documented prompt-length limit — this budget is kept as-is as
   *  a conservative ceiling regardless, not loosened just because the new
   *  model may not enforce one. */
  sceneImage: 2995,
  /** KieVideoGenerator — Seedance 1.5 Pro. Documented at
   *  docs.kie.ai/market/bytedance/seedance-1-5-pro: `input.prompt` is
   *  3-2500 characters. */
  sceneVideo: 2450,
} as const

// Blog hero/inline and image_post's photo (composeHeroPrompt/
// composeInlinePrompt/composePhotoPrompt) are deliberately NOT budgeted
// here. They're permanently routed through NanoBananaImageGenerator
// (nano-banana-2, see inngest/functions/blog.ts's and image.ts's own
// comments) with no documented prompt-length limit found, and have never
// hit a real length failure in production — owner-confirmed
// (PROMPT_REFACTOR_BRIEF.md §16.1 follow-up) to leave unbounded rather
// than budget them against a limit that may not even apply to this model.
// Video's scene images/character-ref share this same adapter as of
// 2026-09-23 but keep their own PROMPT_LIMITS.sceneImage budget above as a
// conservative ceiling — the two call sites made independent choices
// here, not a rule that nano-banana-2 callers are always unbounded.
