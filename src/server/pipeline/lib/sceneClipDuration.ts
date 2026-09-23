// Requests the scene's own planned budget, clamped to Seedance 1.5 Pro's
// documented 4-12s accepted range (kie.ts's KieVideoGenerator header) —
// replaces the old Kling-2.6-era '5'|'10' bucketing (2026-09-24). That
// bucketing was kept as-is through the 2026-09-21 Seedance swap deliberately
// (see git history) even though Seedance would already accept an arbitrary
// duration, specifically so the model swap didn't also require touching
// this logic. Confirmed live (2026-09-24) that keeping it was the wrong
// call once composeLocalizeScriptSystemPrompt's own word-budget fix (same
// day) started landing real per-language narration much closer to each
// scene's real target_duration_seconds: a clip still bucketed to a fixed
// 5s/10s regardless of a 6s/7s/8s target now regularly came back shorter
// than the narration it needed to cover, and buildSceneDurationMatchCommand
// (avMerger.ts) closes that gap by CLONING the clip's last frame to hold
// through the shortfall — a visible freeze right at the scene cut. A real
// 4-scene job showed this exactly: scene 1 (6s target, bucketed to 5s) froze
// for ~0.9s before cutting; scene 3 (8s target, bucketed to 10s, so already
// longer than needed) showed no freeze at all, just a clean trim. Requesting
// close to the real target directly shrinks that gap for both directions —
// fewer/shorter freezes when the clip would have been too short, and less
// wasted trimmed footage when it would have been too long. Rounds to the
// nearest whole second (matching the previous integer-bucket behavior) since
// KIE.ai's own docs (docs.kie.ai/market/bytedance/seedance-1-5-pro) don't
// confirm fractional-second durations are accepted. Only ever used to build
// the REQUEST sent to generateSceneVisual.ts's video-generation call —
// nothing downstream trusts this as the clip's real, actual generated
// length; buildSceneDurationMatchCommand (avMerger.ts) reconciles every
// clip to each language's own real, AssemblyAI-measured narration length
// regardless of what was requested here, exactly as it already did for
// Seedance's own duration drift (see that function's own header).
const MIN_CLIP_SECONDS = 4
const MAX_CLIP_SECONDS = 12

export function pickClipDurationSeconds(targetDurationMs: number): number {
  const targetSeconds = Math.round(targetDurationMs / 1000)
  return Math.min(MAX_CLIP_SECONDS, Math.max(MIN_CLIP_SECONDS, targetSeconds))
}
