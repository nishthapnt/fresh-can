import type { VideoSceneRow } from '../../db'
import { maxNarrationWords, narrationWordCount } from '../../../../lib/videoNarrationBudget'

// Unlike every other file in this directory, this isn't called from an
// Inngest function — it's the pure logic behind POST /api/jobs/[jobId]/
// video/script (a synchronous user edit, not a generation step), kept here
// rather than inline in the route so it can be unit-tested the same way
// generateScript.ts's normalizeScriptOutput is, and because it operates on
// the exact same video_scenes/narration_intent shape that file owns.
//
// The word-budget itself (maxNarrationWords) lives in lib/videoNarrationBudget
// rather than here, shared with composeText.ts's composeLocalizeScriptSystemPrompt
// (which targets the identical rate when writing per-language narration) and
// with VideoTabContent's live client-side counter — see that file's own
// header for why a single source of truth matters here.

export interface ScriptEditRequest {
  id: string
  narration: string
}

/** One scene's merged result — narrationIntent is the FULL object to persist
 *  (existing Layer 2 fields like beat/cast_present/unit_presence preserved,
 *  only `text` replaced), never a bare string. */
export interface MergedSceneNarration {
  sceneNumber: number
  narrationIntent: Record<string, unknown>
}

function isValidEditShape(value: unknown): value is ScriptEditRequest {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return typeof v.id === 'string' && v.id.trim() !== '' && typeof v.narration === 'string'
}

/**
 * Validates a raw `{ scenes: [...] }` edit request against the pipeline's
 * current scene rows and merges each edited narration text into its scene's
 * existing narration_intent (preserving every other field on it). Returns
 * one MergedSceneNarration per EDITED scene only — an unedited scene needs
 * no write, since upsertVideoScenes upserts by (pipeline, generation,
 * scene_number) rather than replacing the whole table.
 *
 * Never partially applies: any single invalid/unknown-id edit fails the
 * whole request, since a client sending a stale scene id almost always
 * means it's looking at a stale (already-regenerated) scene plan, not that
 * one edit among several is simply wrong.
 */
export function applyScriptEdits(
  scenes: VideoSceneRow[],
  rawEdits: unknown,
): { updates: MergedSceneNarration[] } | { error: string } {
  if (!Array.isArray(rawEdits) || rawEdits.length === 0) {
    return { error: 'scenes must be a non-empty array of { id, narration }' }
  }

  const byId = new Map(scenes.map((s) => [s.id, s]))
  const updates: MergedSceneNarration[] = []

  for (const raw of rawEdits) {
    if (!isValidEditShape(raw)) {
      return { error: 'Each edit must be { id: string, narration: string }' }
    }
    const narration = raw.narration.trim()
    if (narration === '') {
      return { error: `Narration cannot be empty (scene id: ${raw.id})` }
    }
    const scene = byId.get(raw.id)
    if (!scene) {
      return { error: `Scene id ${raw.id} does not belong to this pipeline's current scene plan` }
    }
    const maxWords = maxNarrationWords(scene.target_duration_ms)
    const words = narrationWordCount(narration)
    if (words > maxWords) {
      return {
        error:
          `Scene ${scene.scene_number}'s narration is too long for its ${Math.round(scene.target_duration_ms / 1000)}s ` +
          `budget (${words} words, max ${maxWords})`,
      }
    }
    const existing =
      scene.narration_intent && typeof scene.narration_intent === 'object'
        ? (scene.narration_intent as Record<string, unknown>)
        : {}
    updates.push({
      sceneNumber: scene.scene_number,
      narrationIntent: { ...existing, text: narration },
    })
  }

  return { updates }
}

/** Rebuilds the top-level draft_data.script summary from every scene's
 *  narration text, in scene order — keeps the pre-approval "Script" card
 *  (the single narrative view) consistent with per-scene edits, which are
 *  the actual unit of generation (see this file's own header). */
export function buildScriptSummary(scenes: Array<{ scene_number: number; narrationText: string }>): string {
  return scenes
    .slice()
    .sort((a, b) => a.scene_number - b.scene_number)
    .map((s) => s.narrationText.trim())
    .filter((text) => text !== '')
    .join('\n\n')
}
