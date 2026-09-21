// Kling 2.6 only accepts "5" or "10" — round the scene's planned budget to
// whichever is closer, per ARCHITECTURE.MD §4.2's "duration is a budget,
// not an exact figure" framing. Kept as this same '5'|'10' bucketing after
// the 2026-09-21 swap to Seedance 1.5 Pro (which would accept any 4-12s
// value) so the model swap didn't also require touching this logic — see
// kie.ts's KieVideoGenerator header. Only ever used now to build the
// REQUEST sent to generateSceneVisual.ts's video-generation call — nothing
// downstream trusts this as the clip's real, actual generated length
// anymore. It used to also be (2026-09-19 - 2026-09-21) recomputed by
// renderLanguageTrack.ts's per-scene duration-match pass on the assumption
// that Kling/Hailuo's response reliably matched the request exactly; that
// assumption held for Kling but broke for Seedance (real clips can come
// back a different length than requested), which surfaced as a real
// caption/audio desync — see avMerger.ts's buildSceneDurationMatchCommand
// header for the fix (it no longer takes or assumes any "current" clip
// duration at all).
export function pickClipDurationSeconds(targetDurationMs: number): '5' | '10' {
  return targetDurationMs > 7500 ? '10' : '5'
}
