// Shared by both sides of video's script-editing feature: the SERVER side
// (composeText.ts's composeLocalizeScriptSystemPrompt, which targets this
// exact rate when writing per-language narration wording; and
// updateScript.ts's applyScriptEdits, which enforces the budget derived
// below on a user's pre-approval narration edit) and the CLIENT side
// (VideoTabContent's live word-budget counter, page.tsx) — kept here rather
// than under server/pipeline so the dashboard page can import it directly
// without pulling in the rest of the prompt-composition module tree.
//
// Real ElevenLabs-measured narration rate for this pipeline (2026-09-24 —
// see composeLocalizeScriptSystemPrompt's own header for how this number was
// derived: two real jobs landed at ~58% of their requested duration because
// the previous 2.5wps assumption was ~25% slower than reality).
export const NARRATION_WORDS_PER_SECOND = 3.1

// Slack above the raw rate — the render step already tolerates narration
// that runs "a little long" by holding a scene's last frame, so the budget
// only needs to block an edit that would force localize_script's
// per-language rewrite to badly compress the semantic content just to fit
// the scene's time slot, not one that's merely a bit generous.
const TOLERANCE = 1.15

/** The hard word-count ceiling for a scene's narration_intent text, derived
 *  from its own target_duration_ms. Both the client counter and the
 *  server-side enforcement call this same function, so they can never
 *  disagree at the boundary. */
export function maxNarrationWords(targetDurationMs: number): number {
  return Math.ceil((targetDurationMs / 1000) * NARRATION_WORDS_PER_SECOND * TOLERANCE)
}

export function narrationWordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length
}
