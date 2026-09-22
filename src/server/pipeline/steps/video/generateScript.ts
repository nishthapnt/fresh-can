import type { SupabaseClient } from '@supabase/supabase-js'
import type { ScriptGenerator } from '../../adapters/types'
import {
  claimPipeline,
  hasSucceededStep,
  recordStepAttempt,
  recordPipelineRetryableFailure,
  markPipelineFailed,
  upsertVideoScriptDraft,
  upsertVideoScenes,
  getVideoScenes,
  type PipelineRow,
} from '../../db'
import { hasExceededMaxAttempts, isReadyToRetry, MAX_ATTEMPTS } from '../../lib/backoff'
import {
  BRAND_PROFILE,
  composeVideoScriptSystemPrompt,
  type SceneVisualState,
  type CreativeBrief,
  type VideoScriptStory,
  type VideoScriptLook,
  type CastBibleEntry,
  type VideoLocation,
} from '../../prompts/index'

export interface VideoScriptJobInput {
  topic: string
  category: string
  targetAudience: string
  scriptType: string
  /** The job's own intent-only language value (EN|FR|BOTH) — used only to
   *  populate content_drafts' legacy `language` column so this row can
   *  reuse the existing (job_id, content_type, language) unique constraint
   *  (see upsertVideoScriptDraft's doc comment). Never used to decide
   *  wording — scenes stay language-neutral regardless of this value. */
  jobLanguage: string
  /** User-selected target total runtime, in seconds (supabase/migrations/
   *  20260914000000) — one of the dashboard's fixed options (src/app/
   *  dashboard/new/page.tsx's VIDEO_DURATIONS, 24-52s). A target passed to
   *  the model, not a hard cap it's expected to hit exactly — see
   *  composeVideoScriptSystemPrompt's own header for why. */
  durationSeconds: number
  /** The dashboard's "Your Scene Idea" field (content_jobs.scene_notes) —
   *  the creative brief the script and scene plan are built around, same
   *  treatment as blog's outline/copy and image_post's photo (see
   *  composeVideoScriptSystemPrompt for how it's used). Optional/nullable
   *  for a pre-existing job created before the field became required. */
  sceneNotes?: string | null
  /** Layer 1's interpreted brief (PROMPT_REFACTOR_BRIEF.md §4.2), produced
   *  by steps/shared/interpretIntent.ts. Optional so a caller that hasn't
   *  run that step yet (or a legacy job predating it) still works exactly
   *  as before — see composeVideoScriptSystemPrompt for how it's used. */
  creativeBrief?: CreativeBrief
}

export interface ScriptSceneOutput {
  scene_number: number
  visual_description: string
  shot_notes?: string
  narration_intent: string
  target_duration_seconds: number
  /** Compact visual-continuity bookkeeping for this scene — see
   *  SceneVisualState's own header (prompts/types.ts). Optional/lenient
   *  end-to-end (normalizeVisualState below): a missing or malformed
   *  visual_state never fails the whole scene the way a missing
   *  visual_description does — it's a quality enhancement on top of
   *  already-working scene content, not core content of its own. */
  visual_state?: SceneVisualState
  /** Layer 2 additions (PROMPT_REFACTOR_BRIEF.md §4.3) — all optional/
   *  lenient, same treatment as visual_state above. Not yet read by any
   *  composer (Phase 4 wires unit_presence/setting/contains_food into the
   *  scene-image/scene-video prompts and retires the keyword-regex gate
   *  isVideoSceneAboutUnit currently does that job). */
  beat?: string
  cast_present?: string[]
  props_present?: string[]
  unit_presence?: 'none' | 'background' | 'featured'
  setting?: 'exterior' | 'interior' | 'unrelated'
  contains_food?: boolean
  is_final_scene?: boolean
}

export interface VideoScriptOutput {
  script: string
  visual_description: string
  duration_seconds: number
  scenes: ScriptSceneOutput[]
  /** Layer 2 additions (PROMPT_REFACTOR_BRIEF.md §4.3) — see each type's own
   *  header (prompts/types.ts) for what it's for and why it's optional this
   *  phase. */
  story?: VideoScriptStory
  look?: VideoScriptLook
  cast_bible?: CastBibleEntry[]
  locations?: VideoLocation[]
}

/** Coerces a numeric-looking string to a number — models routinely quote
 *  numbers in JSON (e.g. "scene_number": "1") even when explicitly asked
 *  for a bare number, the same class of quirk composeVideoScriptSystemPrompt
 *  already has to work around for JSON formatting generally. Returns null
 *  (not 0) for anything that isn't a real number, so a genuinely missing/
 *  malformed field still fails validation instead of silently becoming 0. */
function coerceNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    return Number(value)
  }
  return null
}

function toStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const strings = value.filter((v): v is string => typeof v === 'string' && v.trim() !== '')
  return strings.length > 0 ? strings : undefined
}

/** Lenient, best-effort parse of a scene's raw visual_state — never throws
 *  and never fails the surrounding scene; a field the model omitted or got
 *  wrong just doesn't appear on the result. Returns undefined for anything
 *  genuinely empty rather than an empty-but-present object, so a scene with
 *  no real visual_state content doesn't grow narration_intent's stored JSON
 *  for no reason. */
function normalizeVisualState(value: unknown): SceneVisualState | undefined {
  if (!value || typeof value !== 'object') return undefined
  const v = value as Record<string, unknown>
  const people = coerceNumber(v.people)
  const hands = typeof v.hands === 'string' && v.hands.trim() !== '' ? v.hands : undefined
  const objects = toStringArray(v.objects)
  const newEntities = toStringArray(v.new_entities)

  if (people === null && !hands && !objects && !newEntities) return undefined
  return {
    ...(people !== null ? { people } : {}),
    ...(hands ? { hands } : {}),
    ...(objects ? { objects } : {}),
    ...(newEntities ? { new_entities: newEntities } : {}),
  }
}

function coerceBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

const UNIT_PRESENCE_VALUES = new Set(['none', 'background', 'featured'])
const SETTING_VALUES = new Set(['exterior', 'interior', 'unrelated'])

function normalizeEnum<T extends string>(value: unknown, allowed: Set<string>): T | undefined {
  return typeof value === 'string' && allowed.has(value) ? (value as T) : undefined
}

/** Lenient, best-effort parse of the top-level story/look objects — same
 *  never-fails-the-whole-script treatment as normalizeVisualState. Every
 *  field is itself optional, so a partially-specified object is still kept
 *  rather than discarded wholesale. */
function normalizeStory(value: unknown): VideoScriptStory | undefined {
  if (!value || typeof value !== 'object') return undefined
  const v = value as Record<string, unknown>
  const out: VideoScriptStory = {}
  if (typeof v.hook === 'string') out.hook = v.hook
  if (typeof v.arc === 'string') out.arc = v.arc
  if (typeof v.resolution === 'string') out.resolution = v.resolution
  if (typeof v.cta === 'string' || v.cta === null) out.cta = v.cta
  return Object.keys(out).length > 0 ? out : undefined
}

function normalizeLook(value: unknown): VideoScriptLook | undefined {
  if (!value || typeof value !== 'object') return undefined
  const v = value as Record<string, unknown>
  const out: VideoScriptLook = {}
  if (typeof v.time_of_day === 'string') out.time_of_day = v.time_of_day
  if (typeof v.lighting === 'string') out.lighting = v.lighting
  if (typeof v.palette === 'string') out.palette = v.palette
  if (typeof v.style_direction === 'string') out.style_direction = v.style_direction
  if (typeof v.camera_language === 'string') out.camera_language = v.camera_language
  return Object.keys(out).length > 0 ? out : undefined
}

/** Cast bible / locations both require a real `id` (they're referenced by
 *  id from scenes' cast_present) — an entry with no id is dropped rather
 *  than kept with a made-up one, since a scene referencing a missing id is
 *  a safer failure mode than two different ids silently meaning the same
 *  person. */
function normalizeCastBible(value: unknown): CastBibleEntry[] | undefined {
  if (!Array.isArray(value)) return undefined
  const entries: CastBibleEntry[] = []
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue
    const v = raw as Record<string, unknown>
    if (typeof v.id !== 'string' || v.id.trim() === '') continue
    entries.push({
      id: v.id,
      role: typeof v.role === 'string' ? v.role : undefined,
      age_range: typeof v.age_range === 'string' ? v.age_range : undefined,
      appearance: typeof v.appearance === 'string' ? v.appearance : undefined,
      wardrobe: typeof v.wardrobe === 'string' ? v.wardrobe : undefined,
      distinguishing_details: typeof v.distinguishing_details === 'string' ? v.distinguishing_details : undefined,
    })
  }
  return entries.length > 0 ? entries : undefined
}

function normalizeLocations(value: unknown): VideoLocation[] | undefined {
  if (!Array.isArray(value)) return undefined
  const entries: VideoLocation[] = []
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue
    const v = raw as Record<string, unknown>
    if (typeof v.id !== 'string' || v.id.trim() === '') continue
    entries.push({
      id: v.id,
      description: typeof v.description === 'string' ? v.description : undefined,
      continuity_details: typeof v.continuity_details === 'string' ? v.continuity_details : undefined,
    })
  }
  return entries.length > 0 ? entries : undefined
}

/** Normalizes a parsed script response into VideoScriptOutput, or returns
 *  null if it's missing/malformed in a way that can't be safely coerced.
 *  Deliberately lenient on number-as-string (see coerceNumber) and on
 *  optional/blank shot_notes, but never invents a script/visual_description/
 *  narration_intent — those are exactly the content this step exists to
 *  produce, so a missing one is a real failure, not something to paper over. */
export function normalizeScriptOutput(parsed: unknown): VideoScriptOutput | null {
  if (!parsed || typeof parsed !== 'object') return null
  const p = parsed as Record<string, unknown>
  if (typeof p.script !== 'string' || typeof p.visual_description !== 'string') return null
  const durationSeconds = coerceNumber(p.duration_seconds)
  if (durationSeconds === null) return null
  if (!Array.isArray(p.scenes) || p.scenes.length === 0) return null

  const scenes: ScriptSceneOutput[] = []
  for (const s of p.scenes) {
    if (!s || typeof s !== 'object') return null
    const scene = s as Record<string, unknown>
    const sceneNumber = coerceNumber(scene.scene_number)
    const targetDurationSeconds = coerceNumber(scene.target_duration_seconds)
    if (
      sceneNumber === null ||
      targetDurationSeconds === null ||
      typeof scene.visual_description !== 'string' ||
      typeof scene.narration_intent !== 'string'
    ) {
      return null
    }
    scenes.push({
      scene_number: sceneNumber,
      visual_description: scene.visual_description,
      shot_notes: typeof scene.shot_notes === 'string' ? scene.shot_notes : undefined,
      narration_intent: scene.narration_intent,
      target_duration_seconds: targetDurationSeconds,
      visual_state: normalizeVisualState(scene.visual_state),
      beat: typeof scene.beat === 'string' ? scene.beat : undefined,
      cast_present: toStringArray(scene.cast_present),
      props_present: toStringArray(scene.props_present),
      unit_presence: normalizeEnum(scene.unit_presence, UNIT_PRESENCE_VALUES),
      setting: normalizeEnum(scene.setting, SETTING_VALUES),
      contains_food: coerceBoolean(scene.contains_food),
      is_final_scene: coerceBoolean(scene.is_final_scene),
    })
  }

  return {
    script: p.script,
    visual_description: p.visual_description,
    duration_seconds: durationSeconds,
    scenes,
    story: normalizeStory(p.story),
    look: normalizeLook(p.look),
    cast_bible: normalizeCastBible(p.cast_bible),
    locations: normalizeLocations(p.locations),
  }
}

/** Reads a scene's visual_state back out of its stored narration_intent
 *  (see upsertVideoScenes's call below — visual_state rides inside that
 *  same JSON column rather than a new one). Trusts the shape rather than
 *  re-validating it: normalizeVisualState above already sanitized it once,
 *  at write time. */
export function extractVisualState(narrationIntent: unknown): SceneVisualState | null {
  if (!narrationIntent || typeof narrationIntent !== 'object') return null
  const visualState = (narrationIntent as Record<string, unknown>).visual_state
  return visualState && typeof visualState === 'object' ? (visualState as SceneVisualState) : null
}

/** The current scene's Layer 2 fields (PROMPT_REFACTOR_BRIEF.md §4.3),
 *  written by upsertVideoScenes alongside visual_state — see that call in
 *  runGenerateScript below. Each field is undefined both for a genuinely
 *  pre-Phase-3 scene (created before this refactor shipped) and for a scene
 *  the model simply didn't populate a given field for; composeSceneImagePrompt
 *  (Phase 4) treats an undefined unit_presence as 'none' (never force the
 *  unit in without a real signal) and an undefined contains_food/
 *  cast_present as "unknown — stay safe, include the guard" — see that
 *  function's own header for why those two default in opposite directions. */
export interface SceneLayer2Fields {
  unit_presence?: 'none' | 'background' | 'featured'
  setting?: 'exterior' | 'interior' | 'unrelated'
  contains_food?: boolean
  cast_present?: string[]
  beat?: string
}

export function extractSceneLayer2Fields(narrationIntent: unknown): SceneLayer2Fields {
  if (!narrationIntent || typeof narrationIntent !== 'object') return {}
  const v = narrationIntent as Record<string, unknown>
  return {
    unit_presence: normalizeEnum(v.unit_presence, UNIT_PRESENCE_VALUES),
    setting: normalizeEnum(v.setting, SETTING_VALUES),
    contains_food: coerceBoolean(v.contains_food),
    cast_present: toStringArray(v.cast_present),
    beat: typeof v.beat === 'string' ? v.beat : undefined,
  }
}

/**
 * Shared, pipeline-scoped step — the ONLY generation step that runs before
 * user approval (ARCHITECTURE.MD §6.4: video gates expensive spend behind
 * one approval, unlike Blog/Image). Produces the script AND the scene plan
 * in one OpenAI call (§17.1), writes the master content_drafts row (no
 * per-language draft exists for video) and the video_scenes rows that
 * generate_character_ref/generate_scene_visual (M2) will read.
 *
 * Deliberately stops at 'draft_ready', not 'generating' — unlike
 * generateOutline.ts (Blog has no approval gate). POST /video/approve
 * (not this step) is what advances draft_ready -> approved.
 */
export async function runGenerateScript(
  client: SupabaseClient,
  pipeline: PipelineRow,
  input: VideoScriptJobInput,
  scriptGenerator: ScriptGenerator,
  backoffBaseDelayMs = 5000,
): Promise<{ ran: boolean }> {
  let working: PipelineRow

  if (pipeline.status === 'created') {
    const claimed = await claimPipeline(client, pipeline.id, 'created', 'drafting')
    if (!claimed) return { ran: false } // lost the race to another worker
    working = claimed
  } else if (pipeline.status === 'drafting') {
    if (!pipeline.last_error) return { ran: false } // no error recorded — already in flight, not our turn
    if (
      !isReadyToRetry({
        lastError: pipeline.last_error,
        retryCount: pipeline.retry_count,
        updatedAt: new Date(pipeline.updated_at),
        baseDelayMs: backoffBaseDelayMs,
      })
    ) {
      return { ran: false } // backoff window hasn't elapsed yet
    }
    working = pipeline
  } else {
    return { ran: false } // wrong state entirely for this step
  }

  const generation = working.current_generation
  const alreadySucceeded = await hasSucceededStep(
    client,
    { contentPipelineId: pipeline.id },
    'generate_script',
    generation,
  )

  if (!alreadySucceeded) {
    const attemptNumber = working.retry_count + 1
    try {
      const result = await scriptGenerator.generate({
        systemPrompt: composeVideoScriptSystemPrompt(BRAND_PROFILE, {
          category: input.category,
          scriptType: input.scriptType,
          targetDurationSeconds: input.durationSeconds,
          sceneNotes: input.sceneNotes,
          creativeBrief: input.creativeBrief,
        }),
        userPrompt:
          `Topic: ${input.topic}\nCategory: ${input.category}\n` +
          `Audience: ${input.targetAudience}\nScript type: ${input.scriptType}` +
          // Set by POST /video/regenerate { scope: "script" } — the only
          // regeneration scope that reruns this step, so this is always a
          // genuine user request to redo the script/scene plan differently,
          // never stale guidance from an unrelated earlier regen.
          (working.regen_instructions ? `\nThe user asked for this rewrite: ${working.regen_instructions}` : ''),
      })

      const output = normalizeScriptOutput(result.parsed)
      if (!output) {
        // Includes a truncated raw snippet — this exact failure previously
        // surfaced to the user as just "model output did not match the
        // required JSON shape", which no longer distinguishes "the model
        // returned non-JSON prose" from "valid JSON, wrong shape" and can't
        // be diagnosed after the fact (the raw content was never persisted
        // anywhere). last_error is shown directly in the dashboard's
        // "Shared production" failed state (VideoTabContent).
        const snippet = result.raw.slice(0, 500)
        throw new Error(
          `generate_script: model output did not match the required JSON shape (missing/invalid scenes). ` +
          `Raw response (truncated): ${snippet}`,
        )
      }

      await upsertVideoScriptDraft(client, {
        jobId: pipeline.job_id,
        language: input.jobLanguage,
        contentPipelineId: pipeline.id,
        draftData: {
          script: output.script,
          visual_description: output.visual_description,
          duration_seconds: output.duration_seconds,
          scenes: output.scenes,
          // Layer 2 shared/pipeline-level plan fields (PROMPT_REFACTOR_BRIEF.md
          // §4.3) — content_drafts.draft_data is video's one shared,
          // pipeline-level JSON blob (there's no sibling column for
          // "applies to the whole script, not one scene"), so story/look/
          // cast_bible/locations live here rather than duplicated onto
          // every scene's own narration_intent.
          story: output.story,
          look: output.look,
          cast_bible: output.cast_bible,
          locations: output.locations,
        },
      })

      await upsertVideoScenes(client, {
        contentPipelineId: pipeline.id,
        generation,
        scenes: output.scenes.map((s) => ({
          sceneNumber: s.scene_number,
          visualDescription: s.visual_description,
          shotNotes: s.shot_notes ?? null,
          // visual_state and the Layer 2 per-scene fields below all ride
          // inside this same JSON column — see extractVisualState's own
          // header for why that's not a new column.
          narrationIntent: {
            text: s.narration_intent,
            visual_state: s.visual_state,
            beat: s.beat,
            cast_present: s.cast_present,
            props_present: s.props_present,
            unit_presence: s.unit_presence,
            setting: s.setting,
            contains_food: s.contains_food,
            is_final_scene: s.is_final_scene,
          },
          targetDurationMs: Math.round(s.target_duration_seconds * 1000),
        })),
      })

      await recordStepAttempt(client, {
        contentPipelineId: pipeline.id,
        stepName: 'generate_script',
        generation,
        attemptNumber,
        status: 'succeeded',
        provider: 'openai',
        outputSnapshot: output,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      await recordStepAttempt(client, {
        contentPipelineId: pipeline.id,
        stepName: 'generate_script',
        generation,
        attemptNumber,
        status: 'failed_retryable',
        provider: 'openai',
        errorMessage: message,
      })
      if (hasExceededMaxAttempts(attemptNumber, MAX_ATTEMPTS.openai)) {
        await markPipelineFailed(client, pipeline.id, message)
      } else {
        await recordPipelineRetryableFailure(client, pipeline.id, attemptNumber, message)
      }
      return { ran: true }
    }
  }

  // scenes_total must be set regardless of whether THIS call did the work or
  // found it already done (resumed-worker case) — read back from the DB
  // rather than trusting a locally-held count that may not exist on resume.
  const scenes = await getVideoScenes(client, pipeline.id)
  await claimPipeline(client, pipeline.id, 'drafting', 'draft_ready', { scenes_total: scenes.length })
  return { ran: true }
}
