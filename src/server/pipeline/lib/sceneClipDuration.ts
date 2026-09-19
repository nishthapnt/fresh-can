// Kling 2.6 only accepts "5" or "10" — round the scene's planned budget to
// whichever is closer, per ARCHITECTURE.MD §4.2's "duration is a budget,
// not an exact figure" framing. Pulled out of generateSceneVisual.ts
// (2026-09-19) into a shared constant so renderLanguageTrack.ts's
// per-scene duration-match pass (avMerger.ts's
// buildSceneDurationMatchCommand) can recompute the SAME clip duration a
// scene's video was actually generated at, without probing the file —
// Kling/Hailuo reliably render at the exact duration requested, so this
// function's output IS the real clip length. The two call sites must stay
// in lockstep (this is what generateSceneVisual.ts requests from KIE.ai;
// renderLanguageTrack.ts needs to know what it got back), which is
// exactly the kind of two-call-site drift risk this codebase already
// pulls constants out for (see ASPECT_RATIO_RESOLUTIONS's own history).
export function pickClipDurationSeconds(targetDurationMs: number): '5' | '10' {
  return targetDurationMs > 7500 ? '10' : '5'
}
