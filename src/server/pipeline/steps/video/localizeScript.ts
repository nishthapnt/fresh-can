import type { SupabaseClient } from '@supabase/supabase-js'
import type { ScriptGenerator } from '../../adapters/types'
import {
  claimTrack,
  hasSucceededStep,
  recordStepAttempt,
  recordTrackRetryableFailure,
  markTrackFailed,
  getVideoScenes,
  upsertVideoSceneAudio,
  type TrackRow,
} from '../../db'
import { hasExceededMaxAttempts, isReadyToRetry, MAX_ATTEMPTS } from '../../lib/backoff'
import { BRAND_PROFILE, composeLocalizeScriptSystemPrompt } from '../../prompts/index'
import { NARRATION_WORDS_PER_SECOND, narrationWordCount } from '../../../../lib/videoNarrationBudget'

// A finished video's length is the SUM of its scenes' real narration
// lengths (renderLanguageTrack.ts sizes every scene to its audio), so a
// scene whose narration lands far under its planned slot shrinks the whole
// video. Real job f0df42af (36s requested): scene 1 (5s slot) got 4 words,
// scene 2 (6s) 5 words, scene 6 (4s) 5 words — narration summed to 22.7s.
// The system prompt already asked for fuller narration, but prose alone
// isn't enforced; this is. MIN is the floor before a corrective rewrite;
// MAX keeps the rewrite from overshooting (an overshoot triggers a paid
// ElevenLabs resynthesis in transcribeAudio.ts, so never aim high).
const MIN_FILL = 0.85
const MAX_FILL = 1.05

export function narrationWordRange(targetDurationMs: number): { min: number; max: number } {
  const seconds = targetDurationMs / 1000
  return {
    min: Math.max(1, Math.ceil(seconds * NARRATION_WORDS_PER_SECOND * MIN_FILL)),
    max: Math.max(1, Math.floor(seconds * NARRATION_WORDS_PER_SECOND * MAX_FILL)),
  }
}

/** How far outside its word band a narration sits, in words (0 = inside).
 *  Over-long is tolerated up to OVER_TOLERANCE x max: a slightly long scene
 *  just lengthens the video, but a far-too-long one gets sentence-chopped by
 *  transcribeAudio.ts's overshoot correction — which collapsed real job
 *  8e92b381's 24-word narration for a 5s slot down to 5 words (1.6s) after
 *  a paid synthesis. Rewriting it here, as text, is free of that cliff. */
const OVER_TOLERANCE = 1.15

function bandDistance(words: number, targetDurationMs: number): number {
  const { min, max } = narrationWordRange(targetDurationMs)
  if (words < min) return min - words
  const hardMax = Math.floor(max * OVER_TOLERANCE)
  return words > hardMax ? words - hardMax : 0
}

/** Scene numbers whose narration is far too short OR far too long for its slot. */
export function findOffBandScenes(
  scenes: readonly { scene_number: number; target_duration_ms: number }[],
  localized: readonly { scene_number: number; narration_text: string }[],
): number[] {
  return scenes
    .filter((scene) => {
      const match = localized.find((l) => l.scene_number === scene.scene_number)
      return !!match && bandDistance(narrationWordCount(match.narration_text), scene.target_duration_ms) > 0
    })
    .map((scene) => scene.scene_number)
}

/** Whether `candidate` is strictly closer to the slot's word band than `current`. */
export function isBetterFit(current: string, candidate: string, targetDurationMs: number): boolean {
  return (
    bandDistance(narrationWordCount(candidate), targetDurationMs) <
    bandDistance(narrationWordCount(current), targetDurationMs)
  )
}

interface LocalizedScene {
  scene_number: number
  narration_text: string
}

function isValidLocalizeOutput(parsed: unknown, expectedCount: number): parsed is { scenes: LocalizedScene[] } {
  if (!parsed || typeof parsed !== 'object') return false
  const scenes = (parsed as Record<string, unknown>).scenes
  if (!Array.isArray(scenes) || scenes.length !== expectedCount) return false
  return scenes.every((s) => {
    if (!s || typeof s !== 'object') return false
    const scene = s as Record<string, unknown>
    return typeof scene.scene_number === 'number' && typeof scene.narration_text === 'string'
  })
}

/**
 * Per-language-track step — [ONCE PER TRACK]. Gated on the shared scene
 * plan existing (checked below via getVideoScenes, NOT via
 * hasSucceededStep(...,'generate_script', track.master_generation_used) —
 * that would only ever be true at the EXACT generation generate_script
 * last ran, but a visuals-only regenerate (scope: "visuals") bumps
 * master_generation_used on every track without ever rerunning
 * generate_script, which would permanently strand every track at this
 * gate. A track can't structurally exist before generate_script has
 * already succeeded at least once — tracks are only ever created at
 * approval, which itself requires draft_ready — so this was always a
 * redundant defensive check in practice, not a real "wait for it" gate).
 * NOT gated on the shared visuals being ready either — narration wording
 * doesn't need scene images/clips, only the render step does
 * (ARCHITECTURE.MD §6.5's "language-specific work starts as soon as the
 * shared layer permits it"). This is the ONLY place narration wording is
 * produced — it translates the already-approved, language-neutral
 * narration_intent, never a second call to the script-generation model.
 * Replaces n8n's "FR —" forced-script-regeneration branch entirely
 * (ARCHITECTURE.MD §13's mapping table) — that branch is retired, not
 * ported forward.
 *
 * Writes one video_scene_audio row per scene (narration_text only — audio
 * synthesis is synthesizeVoice.ts's job). Leaves the track in 'generating'
 * on success; synthesizeVoice/transcribeAudio are the further steps that
 * eventually advance it to 'awaiting_shared'.
 */
export async function runLocalizeScript(
  client: SupabaseClient,
  track: TrackRow,
  contentPipelineId: string,
  scriptGenerator: ScriptGenerator,
  backoffBaseDelayMs = 5000,
): Promise<{ ran: boolean }> {
  let working: TrackRow
  if (track.status === 'waiting_on_shared') {
    const claimed = await claimTrack(client, track.id, 'waiting_on_shared', 'generating', {
      current_step: 'localizing_script',
    })
    if (!claimed) return { ran: false } // lost the race to another worker
    working = claimed
  } else if (track.status === 'generating') {
    if (!track.last_error) return { ran: false } // no error recorded — already in flight, not our turn
    if (
      !isReadyToRetry({
        lastError: track.last_error,
        retryCount: track.retry_count,
        updatedAt: new Date(track.updated_at),
        baseDelayMs: backoffBaseDelayMs,
      })
    ) {
      return { ran: false } // backoff window hasn't elapsed yet
    }
    working = track
  } else {
    return { ran: false } // wrong state entirely for this step
  }

  const generation = track.master_generation_used
  const alreadySucceeded = await hasSucceededStep(client, { contentLanguageTrackId: track.id }, 'localize_script', generation)
  if (alreadySucceeded) return { ran: true }

  const scenes = await getVideoScenes(client, contentPipelineId)
  if (scenes.length === 0) return { ran: false } // guards a race against generate_script's own writes

  const attemptNumber = working.retry_count + 1
  try {
    const result = await scriptGenerator.generate({
      systemPrompt: composeLocalizeScriptSystemPrompt(BRAND_PROFILE, {
        language: track.language === 'FR' ? 'French' : 'English',
      }),
      userPrompt: JSON.stringify(
        scenes.map((s) => ({
          scene_number: s.scene_number,
          narration_intent: (s.narration_intent as { text?: string } | null)?.text ?? s.narration_intent,
          target_duration_seconds: Math.round(s.target_duration_ms / 1000),
          min_words: narrationWordRange(s.target_duration_ms).min,
          max_words: narrationWordRange(s.target_duration_ms).max,
        })),
      ),
      stepName: 'localize_script',
    })

    if (!isValidLocalizeOutput(result.parsed, scenes.length)) {
      throw new Error('localize_script: model output did not match the required JSON shape')
    }
    let localized = result.parsed.scenes

    // One corrective text-only pass (a cheap LLM call — no ElevenLabs/KIE
    // spend) for scenes far outside their word band (too short OR too long).
    // Best-effort: never throws, only swaps in a rewrite that fits the band
    // better, and a still-off result is accepted rather than failing the track.
    const shortScenes = findOffBandScenes(scenes, localized)
    if (shortScenes.length > 0) {
      try {
        const retry = await scriptGenerator.generate({
          systemPrompt: composeLocalizeScriptSystemPrompt(BRAND_PROFILE, {
            language: track.language === 'FR' ? 'French' : 'English',
          }),
          userPrompt: JSON.stringify(
            scenes
              .filter((s) => shortScenes.includes(s.scene_number))
              .map((s) => ({
                scene_number: s.scene_number,
                narration_intent: (s.narration_intent as { text?: string } | null)?.text ?? s.narration_intent,
                target_duration_seconds: Math.round(s.target_duration_ms / 1000),
                min_words: narrationWordRange(s.target_duration_ms).min,
                max_words: narrationWordRange(s.target_duration_ms).max,
                previous_narration_off_length: localized.find((l) => l.scene_number === s.scene_number)?.narration_text,
              })),
          ),
          stepName: 'localize_script',
        })
        if (isValidLocalizeOutput(retry.parsed, shortScenes.length)) {
          const fixed = retry.parsed.scenes
          localized = localized.map((l) => {
            const f = fixed.find((x) => x.scene_number === l.scene_number)
            return f && isBetterFit(l.narration_text, f.narration_text, scenes.find((x) => x.scene_number === l.scene_number)?.target_duration_ms ?? 0) ? f : l
          })
        }
      } catch {
        // keep the first-pass narration
      }
    }

    for (const scene of scenes) {
      const match = localized.find((l) => l.scene_number === scene.scene_number)
      if (!match) {
        throw new Error(`localize_script: model omitted scene_number ${scene.scene_number}`)
      }
      await upsertVideoSceneAudio(client, {
        contentLanguageTrackId: track.id,
        videoSceneId: scene.id,
        generation,
        narrationText: match.narration_text,
        status: 'pending',
      })
    }

    await recordStepAttempt(client, {
      contentLanguageTrackId: track.id,
      stepName: 'localize_script',
      generation,
      attemptNumber,
      status: 'succeeded',
      provider: 'openai',
      outputSnapshot: { scenes: localized },
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await recordStepAttempt(client, {
      contentLanguageTrackId: track.id,
      stepName: 'localize_script',
      generation,
      attemptNumber,
      status: 'failed_retryable',
      provider: 'openai',
      errorMessage: message,
    })
    if (hasExceededMaxAttempts(attemptNumber, MAX_ATTEMPTS.openai)) {
      await markTrackFailed(client, track.id, message)
    } else {
      await recordTrackRetryableFailure(client, track.id, attemptNumber, message)
    }
  }

  return { ran: true }
}
