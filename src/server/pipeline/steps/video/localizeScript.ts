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
        })),
      ),
    })

    if (!isValidLocalizeOutput(result.parsed, scenes.length)) {
      throw new Error('localize_script: model output did not match the required JSON shape')
    }
    const localized = result.parsed.scenes

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
