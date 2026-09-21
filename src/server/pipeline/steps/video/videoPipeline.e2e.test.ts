// End-to-end test of Video's M1 (script + approval) and M2 (shared
// character-ref + per-scene visuals) worker flow — REAL database (live
// Supabase, self-cleaning throwaway rows), MOCKED provider adapters and a
// fake storage uploader. Mirrors blogPipeline.e2e.test.ts/
// imagePipeline.e2e.test.ts's structure. The one claim that actually matters
// here, more than any other content type's tests: a BOTH job creates TWO
// language tracks but exactly ONE character_ref row and exactly ONE
// scene_image/scene_video_clip PER SCENE — never duplicated per language.
// That's the specific defect (character-ref/scene-visual generation living
// inside n8n's per-language loop) this whole migration exists to fix.
import { describe, it, expect, beforeAll, afterEach, afterAll, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceClient, upsertVisualAsset, type PipelineRow, type TrackRow } from '../../db'
import { runGenerateScript, type VideoScriptJobInput } from './generateScript'
import { runGenerateCharacterRef } from './generateCharacterRef'
import { runGenerateSceneVisual } from './generateSceneVisual'
import { runLocalizeScript } from './localizeScript'
import { runSynthesizeVoice } from './synthesizeVoice'
import { runTranscribeAudio } from './transcribeAudio'
import { runRenderLanguageTrack } from './renderLanguageTrack'
import { BRAND_PROFILE } from '../../prompts/index'
import type {
  ScriptGenerator,
  ImageGenerator,
  ImagePollResult,
  VideoGenerator,
  VideoPollResult,
  VoiceSynthesizer,
  TranscriptionService,
  TranscriptionPollResult,
  AVMerger,
  AVMergeResult,
  SceneClipScaler,
} from '../../adapters/types'
import type { VideoStorageUploader } from '../../adapters/storage'

const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY

const SCRIPT_OUTPUT = {
  script: 'A short script about fresh groceries arriving in the neighbourhood.',
  visual_description: 'The Fresh-CAN truck arrives and neighbours gather around it.',
  duration_seconds: 20,
  scenes: [
    {
      scene_number: 1,
      visual_description: 'The truck pulls up to the curb on a sunny street.',
      shot_notes: 'Wide establishing shot.',
      narration_intent: 'Introduce the truck arriving in the neighbourhood.',
      target_duration_seconds: 10,
    },
    {
      scene_number: 2,
      visual_description: 'A family selects fresh produce from the open side of the truck.',
      shot_notes: 'Medium shot, warm lighting.',
      narration_intent: 'Show a family choosing fresh, affordable groceries.',
      target_duration_seconds: 10,
    },
  ],
}

function makeMockScriptGenerator() {
  const generate = vi.fn(async () => ({ raw: '{}', parsed: SCRIPT_OUTPUT }))
  return { generate } satisfies ScriptGenerator
}

function makeMockImageGenerator() {
  let counter = 0
  const submit = vi.fn(async () => ({ providerRef: `mock-img-${++counter}` }))
  const poll = vi.fn(
    async (jobRef: { providerRef: string }): Promise<ImagePollResult> => ({
      status: 'ready',
      fileUrl: `https://example.com/${jobRef.providerRef}.png`,
    }),
  )
  return { submit, poll } satisfies ImageGenerator
}

function makeFlakyImageGenerator(failFirstNSubmits: number) {
  let submitCalls = 0
  let counter = 0
  const submit = vi.fn(async () => {
    submitCalls++
    if (submitCalls <= failFirstNSubmits) throw new Error('simulated transient KIE.ai failure')
    return { providerRef: `mock-img-${++counter}` }
  })
  const poll = vi.fn(
    async (jobRef: { providerRef: string }): Promise<ImagePollResult> => ({
      status: 'ready',
      fileUrl: `https://example.com/${jobRef.providerRef}.png`,
    }),
  )
  return { submit, poll } satisfies ImageGenerator
}

function makeMockVideoGenerator() {
  let counter = 0
  const submit = vi.fn(async () => ({ providerRef: `mock-clip-${++counter}` }))
  const poll = vi.fn(
    async (jobRef: { providerRef: string }): Promise<VideoPollResult> => ({
      status: 'ready',
      fileUrl: `https://example.com/${jobRef.providerRef}.mp4`,
    }),
  )
  return { submit, poll } satisfies VideoGenerator
}

function makeFakeVideoUploader() {
  const uploadFromUrl = vi.fn(async (path: string, tempUrl: string) => {
    return `https://fake-storage.example.com/freshcan-videos/${path}?src=${encodeURIComponent(tempUrl)}`
  })
  const uploadBuffer = vi.fn(async (path: string) => `https://fake-storage.example.com/freshcan-videos/${path}`)
  return { uploadFromUrl, uploadBuffer } satisfies VideoStorageUploader
}

// Routes on systemPrompt content the same way makeAdCopyAwareScriptGenerator
// does in imagePipeline.e2e.test.ts — generate_script's prompt vs.
// localize_script's — rather than relying on call order. Localized text is
// deliberately DIFFERENT per language (not just an EN/FR label swap) so a
// test asserting "FR's narration_text is genuinely French" can't pass by
// accident.
function makeLocalizeAwareScriptGenerator() {
  const generate = vi.fn(async (req: { systemPrompt: string; userPrompt: string }) => {
    if (req.systemPrompt.includes('scriptwriter and shot planner')) {
      return { raw: '{}', parsed: SCRIPT_OUTPUT }
    }
    const scenes = JSON.parse(req.userPrompt) as Array<{ scene_number: number }>
    const isFrench = req.systemPrompt.includes('French')
    return {
      raw: '{}',
      parsed: {
        scenes: scenes.map((s) => ({
          scene_number: s.scene_number,
          narration_text: isFrench
            ? `Texte français pour la scène ${s.scene_number}`
            : `English text for scene ${s.scene_number}`,
        })),
      },
    }
  })
  return { generate } satisfies ScriptGenerator
}

function makeMockVoiceSynthesizer() {
  let counter = 0
  const synthesize = vi.fn(async () => ({
    audioBuffer: Buffer.from(`fake-audio-${++counter}`),
    providerRef: `voice-${counter}`,
  }))
  return { synthesize } satisfies VoiceSynthesizer
}

function makeFailingVoiceSynthesizer() {
  const synthesize = vi.fn(async () => {
    throw new Error('simulated transient ElevenLabs failure')
  })
  return { synthesize } satisfies VoiceSynthesizer
}

// Two words per scene, at a fixed offset — the test asserts the SECOND
// scene's combined words are shifted by the first scene's real duration, not
// just that 4 words exist. transcribeAudio.ts now derives that duration from
// the second word's own `end` timestamp (+ its TRAILING_SILENCE_BUFFER_MS),
// not from AssemblyAI's audio_duration field (confirmed live 2026-09-21 to
// only have whole-second precision — see that constant's header) — so
// `secondWordEndMs` is what actually drives the offset here, defaulting to
// 800 to match the old fixed mock shape.
function makeMockTranscriptionService(secondWordEndMs = 800) {
  let counter = 0
  const submit = vi.fn(async () => ({ providerRef: `transcript-${++counter}` }))
  const poll = vi.fn(
    async (): Promise<TranscriptionPollResult> => ({
      status: 'ready',
      timingData: [
        { text: 'word1', start: 0, end: 400 },
        { text: 'word2', start: 400, end: secondWordEndMs },
      ],
      text: 'word1 word2',
    }),
  )
  return { submit, poll } satisfies TranscriptionService
}

function makeMockScaler() {
  let counter = 0
  const submitScale = vi.fn(async () => ({ providerRef: `scale-${++counter}` }))
  const poll = vi.fn(async (): Promise<AVMergeResult> => ({ status: 'ready', fileBuffer: Buffer.from(`fake-scaled-clip-${counter}`) }))
  return { submitScale, poll } satisfies SceneClipScaler
}

function makeMockAVMerger() {
  let counter = 0
  const submitVideoConcat = vi.fn(async () => ({ providerRef: `video-concat-${++counter}` }))
  const submitAudioConcat = vi.fn(async () => ({ providerRef: `audio-concat-${++counter}` }))
  const submitMux = vi.fn(async () => ({ providerRef: `mux-${++counter}` }))
  const submitCaptionBurn = vi.fn(async () => ({ providerRef: `caption-${++counter}` }))
  const submitSceneDurationMatch = vi.fn(async () => ({ providerRef: `duration-match-${++counter}` }))
  const poll = vi.fn(async (): Promise<AVMergeResult> => ({ status: 'ready', fileBuffer: Buffer.from(`fake-video-${counter}`) }))
  return {
    submitVideoConcat,
    submitAudioConcat,
    submitMux,
    submitCaptionBurn,
    submitSceneDurationMatch,
    poll,
  } satisfies AVMerger
}

describe.skipIf(!hasCreds)('Video pipeline end-to-end (real DB, mocked providers) — M1+M2+M3', () => {
  let client: SupabaseClient
  const createdJobIds: string[] = []
  // brand/fresh-can.ts deliberately leaves these empty (real ElevenLabs
  // voice ids aren't configured yet) — TS's Readonly is compile-time only,
  // so patching the actual object at runtime is how this test supplies
  // fixture ids without adding a DI mechanism the rest of the worker
  // doesn't have. Restored in afterAll so this test's fixture values never
  // leak into another test file's run.
  let originalVoiceIds: typeof BRAND_PROFILE.videoVoiceIds

  beforeAll(() => {
    client = createServiceClient()
    originalVoiceIds = BRAND_PROFILE.videoVoiceIds
    ;(BRAND_PROFILE as { videoVoiceIds?: unknown }).videoVoiceIds = { EN: 'test-voice-en', FR: 'test-voice-fr' }
  })

  afterAll(() => {
    ;(BRAND_PROFILE as { videoVoiceIds?: unknown }).videoVoiceIds = originalVoiceIds
  })

  afterEach(async () => {
    for (const jobId of createdJobIds.splice(0)) {
      const { data: pipelines } = await client.from('content_pipelines').select('id').eq('job_id', jobId)
      for (const p of pipelines ?? []) {
        await client.from('pipeline_steps').delete().eq('content_pipeline_id', p.id)
        const { data: tracks } = await client
          .from('content_language_tracks')
          .select('id')
          .eq('content_pipeline_id', p.id)
        for (const t of tracks ?? []) {
          await client.from('pipeline_steps').delete().eq('content_language_track_id', t.id)
          await client.from('video_scene_audio').delete().eq('content_language_track_id', t.id)
          await client.from('video_captions').delete().eq('content_language_track_id', t.id)
        }
        await client.from('content_language_tracks').delete().eq('content_pipeline_id', p.id)
        await client.from('content_visual_assets').delete().eq('content_pipeline_id', p.id)
        await client.from('video_scenes').delete().eq('content_pipeline_id', p.id)
      }
      await client.from('content_drafts').delete().eq('job_id', jobId).eq('content_type', 'video')
      await client.from('generated_content').delete().eq('job_id', jobId).eq('content_type', 'video')
      await client.from('content_pipelines').delete().eq('job_id', jobId)
      await client.from('content_jobs').delete().eq('id', jobId)
    }
  })

  async function makeJobAndPipeline(language: 'EN' | 'FR' | 'BOTH') {
    const { data: job, error: jobErr } = await client
      .from('content_jobs')
      .insert({
        topic: 'E2E VIDEO TEST - DELETE ME',
        category: 'Community Impact',
        target_audience: 'General public',
        language,
        content_types: ['video'],
        script_type: 'SOLUTION',
        status: 'pending',
      })
      .select('id')
      .single()
    if (jobErr) throw jobErr
    createdJobIds.push(job.id)

    const { data: pipeline, error: pErr } = await client
      .from('content_pipelines')
      .insert({ job_id: job.id, content_type: 'video' })
      .select()
      .single()
    if (pErr) throw pErr

    return { jobId: job.id, pipeline: pipeline as PipelineRow }
  }

  const scriptInput: VideoScriptJobInput = {
    topic: 'Fresh groceries in your neighbourhood',
    keywords: 'fresh, local, affordable',
    category: 'Community Impact',
    targetAudience: 'General public',
    scriptType: 'SOLUTION',
    jobLanguage: 'EN',
    durationSeconds: 36,
  }

  /** Mirrors POST /video/approve's CAS-claim + track creation, done
   *  directly against the DB the same way the other e2e tests bypass their
   *  own content type's API routes to test worker logic in isolation. */
  // Mirrors POST /video/regenerate { scope: "visuals" }'s DB writes — done
  // directly against the DB the same way approve() bypasses its own route,
  // to test worker logic (not route logic) in isolation.
  async function regenerateVisuals(pipeline: PipelineRow): Promise<{ newGeneration: number }> {
    const newGeneration = pipeline.current_generation + 1
    const { error: pErr } = await client
      .from('content_pipelines')
      .update({
        current_generation: newGeneration,
        status: 'generating',
        scenes_visuals_ready_count: 0,
        retry_count: 0,
        last_error: null,
      })
      .eq('id', pipeline.id)
    if (pErr) throw pErr

    const { error: tErr } = await client
      .from('content_language_tracks')
      .update({ status: 'waiting_on_shared', master_generation_used: newGeneration, retry_count: 0, last_error: null })
      .eq('content_pipeline_id', pipeline.id)
    if (tErr) throw tErr

    return { newGeneration }
  }

  async function approve(pipeline: PipelineRow, languages: ('EN' | 'FR')[]) {
    const { data: claimed, error } = await client
      .from('content_pipelines')
      .update({ status: 'approved' })
      .eq('id', pipeline.id)
      .eq('status', 'draft_ready')
      .select()
      .single()
    if (error) throw error

    for (const language of languages) {
      const { error: tErr } = await client
        .from('content_language_tracks')
        .insert({ content_pipeline_id: pipeline.id, language, master_generation_used: claimed.current_generation })
      if (tErr) throw tErr
    }
    return claimed as PipelineRow
  }

  it('M1: generate_script reaches draft_ready and writes the master draft + scene plan', async () => {
    const { jobId, pipeline } = await makeJobAndPipeline('EN')
    const script = makeMockScriptGenerator()

    await runGenerateScript(client, pipeline, scriptInput, script)

    const { data: freshPipeline } = await client.from('content_pipelines').select('*').eq('id', pipeline.id).single()
    expect(freshPipeline.status).toBe('draft_ready')
    expect(freshPipeline.scenes_total).toBe(2)

    const { data: draft } = await client
      .from('content_drafts')
      .select('*')
      .eq('content_pipeline_id', pipeline.id)
      .single()
    expect(draft.draft_data.scenes).toHaveLength(2)
    expect(draft.job_id).toBe(jobId)

    const { data: scenes } = await client
      .from('video_scenes')
      .select('*')
      .eq('content_pipeline_id', pipeline.id)
      .order('scene_number', { ascending: true })
    expect(scenes).toHaveLength(2)
    expect(scenes![0].scene_number).toBe(1)
    // narration_intent is SEMANTIC content, not literal wording — see
    // generateScript.ts's isValidScriptOutput and the prompt's own
    // instructions; asserting it round-trips through the DB as given.
    expect(scenes![0].narration_intent).toEqual({ text: SCRIPT_OUTPUT.scenes[0].narration_intent })
  })

  it('M1: re-running generate_script after success does not call the provider again', async () => {
    const { pipeline } = await makeJobAndPipeline('EN')
    const script = makeMockScriptGenerator()

    await runGenerateScript(client, pipeline, scriptInput, script)
    const { data: freshPipeline } = await client.from('content_pipelines').select('*').eq('id', pipeline.id).single()
    await runGenerateScript(client, freshPipeline as PipelineRow, scriptInput, script)

    expect(script.generate).toHaveBeenCalledTimes(1)
  })

  it('EN-only: approval creates exactly one track, and M2 produces one character_ref plus one scene_image/scene_video_clip per scene', async () => {
    const { pipeline } = await makeJobAndPipeline('EN')
    const script = makeMockScriptGenerator()
    await runGenerateScript(client, pipeline, scriptInput, script)
    const { data: draftReady } = await client.from('content_pipelines').select('*').eq('id', pipeline.id).single()

    const approved = await approve(draftReady as PipelineRow, ['EN'])
    const { data: tracks } = await client.from('content_language_tracks').select('*').eq('content_pipeline_id', pipeline.id)
    expect(tracks).toHaveLength(1)

    const image = makeMockImageGenerator()
    const video = makeMockVideoGenerator()
    const uploader = makeFakeVideoUploader()
    const scaler = makeMockScaler()

    await runGenerateCharacterRef(client, approved, 'a reference prompt', image, uploader)
    const { data: generating } = await client.from('content_pipelines').select('*').eq('id', pipeline.id).single()
    expect(generating.status).toBe('generating')

    // Two ticks: each tick advances every scene by exactly one sub-step
    // (image, then clip) — matching the real polling model, where a scene's
    // clip generation only starts once its image is already ready.
    await runGenerateSceneVisual(client, generating as PipelineRow, 'https://example.com/mock-img-1.png', image, video, uploader, scaler)
    await runGenerateSceneVisual(client, generating as PipelineRow, 'https://example.com/mock-img-1.png', image, video, uploader, scaler)

    const { data: ready } = await client.from('content_pipelines').select('*').eq('id', pipeline.id).single()
    expect(ready.status).toBe('ready')
    expect(ready.scenes_visuals_ready_count).toBe(2)

    const { data: assets } = await client.from('content_visual_assets').select('*').eq('content_pipeline_id', pipeline.id)
    const characterRefs = assets!.filter((a) => a.asset_type === 'character_ref')
    const sceneImages = assets!.filter((a) => a.asset_type === 'scene_image')
    const sceneClips = assets!.filter((a) => a.asset_type === 'scene_video_clip')
    expect(characterRefs).toHaveLength(1)
    expect(sceneImages).toHaveLength(2)
    expect(sceneClips).toHaveLength(2)
    expect(assets!.every((a) => a.status === 'ready')).toBe(true)
  })

  it('BOTH: two tracks are created, but the shared visuals are still generated exactly once — never duplicated per language', async () => {
    const { pipeline } = await makeJobAndPipeline('BOTH')
    const script = makeMockScriptGenerator()
    await runGenerateScript(client, pipeline, scriptInput, script)
    const { data: draftReady } = await client.from('content_pipelines').select('*').eq('id', pipeline.id).single()

    const approved = await approve(draftReady as PipelineRow, ['EN', 'FR'])
    const { data: tracks } = await client.from('content_language_tracks').select('*').eq('content_pipeline_id', pipeline.id)
    expect(tracks).toHaveLength(2)
    expect(tracks!.map((t) => t.language).sort()).toEqual(['EN', 'FR'])

    const image = makeMockImageGenerator()
    const video = makeMockVideoGenerator()
    const uploader = makeFakeVideoUploader()
    const scaler = makeMockScaler()

    await runGenerateCharacterRef(client, approved, 'a reference prompt', image, uploader)
    const { data: generating } = await client.from('content_pipelines').select('*').eq('id', pipeline.id).single()
    await runGenerateSceneVisual(client, generating as PipelineRow, 'https://example.com/mock-img-1.png', image, video, uploader, scaler)
    await runGenerateSceneVisual(client, generating as PipelineRow, 'https://example.com/mock-img-1.png', image, video, uploader, scaler)

    const { data: assets } = await client.from('content_visual_assets').select('*').eq('content_pipeline_id', pipeline.id)
    // The critical assertion: BOTH still produces exactly ONE character_ref
    // and exactly ONE scene_image/scene_video_clip per scene (2 scenes here)
    // — not one per language. This is the exact defect (shared generation
    // living inside n8n's per-language loop) this migration exists to fix.
    expect(assets!.filter((a) => a.asset_type === 'character_ref')).toHaveLength(1)
    expect(assets!.filter((a) => a.asset_type === 'scene_image')).toHaveLength(2)
    expect(assets!.filter((a) => a.asset_type === 'scene_video_clip')).toHaveLength(2)
    // one submit() call for the character ref + one per scene image = 3,
    // regardless of 1 or 2 tracks existing
    expect(image.submit).toHaveBeenCalledTimes(3)
    expect(video.submit).toHaveBeenCalledTimes(2)

    // Both tracks' eventual render step (M4, not built yet) would read the
    // SAME asset rows — assert that identity directly, not just the count.
    const sceneImageUrls = new Set(assets!.filter((a) => a.asset_type === 'scene_image').map((a) => a.file_url))
    expect(sceneImageUrls.size).toBe(2) // one distinct URL per scene, shared by both language tracks
  })

  it('character_ref generation retries after a transient failure and eventually succeeds', async () => {
    const { pipeline } = await makeJobAndPipeline('EN')
    const script = makeMockScriptGenerator()
    await runGenerateScript(client, pipeline, scriptInput, script)
    const { data: draftReady } = await client.from('content_pipelines').select('*').eq('id', pipeline.id).single()
    const approved = await approve(draftReady as PipelineRow, ['EN'])

    const flakyImage = makeFlakyImageGenerator(1)
    const uploader = makeFakeVideoUploader()

    await runGenerateCharacterRef(client, approved, 'a reference prompt', flakyImage, uploader) // attempt 1: fails
    const { data: p1 } = await client.from('content_pipelines').select('*').eq('id', pipeline.id).single()
    expect(p1.status).toBe('generating') // still generating — one attempt left of MAX_ATTEMPTS.kie

    // backoffBaseDelayMs=0 so isReadyToRetry doesn't race real elapsed time
    // — same trick imagePipeline.e2e.test.ts's own retry test uses.
    await runGenerateCharacterRef(client, p1 as PipelineRow, 'a reference prompt', flakyImage, uploader, 0) // attempt 2: succeeds
    const { data: assets } = await client.from('content_visual_assets').select('*').eq('content_pipeline_id', pipeline.id)
    expect(assets!.find((a) => a.asset_type === 'character_ref')!.status).toBe('ready')
    expect(flakyImage.submit).toHaveBeenCalledTimes(2)
  })

  // Regression test for the P0 fix: a cancellation (/video/cancel, which
  // sets content_pipelines.status = 'failed') that lands WHILE a poll loop
  // is already running used to be invisible to that loop — it would keep
  // polling until the provider genuinely finished or timed out, still
  // consuming KIE's paid generation time regardless of the DB status. This
  // mock's poll() marks the pipeline 'failed' as a side effect of its FIRST
  // response (simulating the user clicking Cancel while KIE is mid-generation)
  // and never reports 'ready' — if the fix works, the loop's SECOND
  // iteration checks for cancellation BEFORE calling poll() again, so
  // poll() itself is only ever called ONCE, and the asset is left in the
  // same 'generating' state (with its provider_ref intact) a mid-poll crash
  // would already leave it in, not recorded as a failure.
  it('a cancellation that lands mid-poll stops the poll loop immediately and does not record a failure', async () => {
    const { pipeline } = await makeJobAndPipeline('EN')
    const script = makeMockScriptGenerator()
    await runGenerateScript(client, pipeline, scriptInput, script)
    const { data: draftReady } = await client.from('content_pipelines').select('*').eq('id', pipeline.id).single()
    const approved = await approve(draftReady as PipelineRow, ['EN'])

    let pollCount = 0
    const submit = vi.fn(async () => ({ providerRef: 'mock-img-cancel-mid-poll' }))
    const poll = vi.fn(async (): Promise<ImagePollResult> => {
      pollCount++
      if (pollCount === 1) {
        await client.from('content_pipelines').update({ status: 'failed', last_error: 'Cancelled by user' }).eq('id', pipeline.id)
      }
      return { status: 'pending' }
    })
    const cancellingImage = { submit, poll } satisfies ImageGenerator
    const uploader = makeFakeVideoUploader()

    await runGenerateCharacterRef(client, approved, 'a reference prompt', cancellingImage, uploader)

    expect(submit).toHaveBeenCalledTimes(1) // never re-submitted — the original task is still what's resumable
    expect(pollCount).toBe(1) // poll() called ONCE (triggers the cancellation) — the loop's cancellation check on the next iteration stops it before poll() is ever called again

    const { data: pipelineRow } = await client.from('content_pipelines').select('*').eq('id', pipeline.id).single()
    expect(pipelineRow.status).toBe('failed') // untouched — already correctly set by the "cancel route"

    const { data: assets } = await client.from('content_visual_assets').select('*').eq('content_pipeline_id', pipeline.id)
    const characterRef = assets!.find((a) => a.asset_type === 'character_ref')!
    expect(characterRef.status).toBe('generating') // NOT 'failed' — no failure was recorded
    expect(characterRef.provider_ref).toBe('mock-img-cancel-mid-poll') // resumable, same shape a mid-poll crash leaves

    const { data: steps } = await client
      .from('pipeline_steps')
      .select('*')
      .eq('content_pipeline_id', pipeline.id)
      .eq('step_name', 'generate_character_ref')
    expect(steps).toHaveLength(0) // no failed_retryable (or any) attempt was ever recorded for this step
  })

  it('re-running generate_character_ref and generate_scene_visual after success does not call any provider again', async () => {
    const { pipeline } = await makeJobAndPipeline('EN')
    const script = makeMockScriptGenerator()
    await runGenerateScript(client, pipeline, scriptInput, script)
    const { data: draftReady } = await client.from('content_pipelines').select('*').eq('id', pipeline.id).single()
    const approved = await approve(draftReady as PipelineRow, ['EN'])

    const image = makeMockImageGenerator()
    const video = makeMockVideoGenerator()
    const uploader = makeFakeVideoUploader()
    const scaler = makeMockScaler()

    await runGenerateCharacterRef(client, approved, 'a reference prompt', image, uploader)
    const { data: generating } = await client.from('content_pipelines').select('*').eq('id', pipeline.id).single()
    // Two ticks to reach real completion (image, then clip, per scene).
    await runGenerateSceneVisual(client, generating as PipelineRow, 'https://example.com/mock-img-1.png', image, video, uploader, scaler)
    await runGenerateSceneVisual(client, generating as PipelineRow, 'https://example.com/mock-img-1.png', image, video, uploader, scaler)
    const { data: ready } = await client.from('content_pipelines').select('*').eq('id', pipeline.id).single()
    expect(ready.status).toBe('ready')

    // Third tick — genuinely a no-op now that everything already succeeded.
    await runGenerateCharacterRef(client, ready as PipelineRow, 'a reference prompt', image, uploader)
    await runGenerateSceneVisual(client, ready as PipelineRow, 'https://example.com/mock-img-1.png', image, video, uploader, scaler)

    expect(image.submit).toHaveBeenCalledTimes(3) // character_ref + 2 scene images, not re-called
    expect(video.submit).toHaveBeenCalledTimes(2)
  })

  // Regression coverage for the 2026-09-17 incident: a worker restarted
  // mid-poll (tsx watch, on every save to index.ts) repeatedly found scene
  // clips stuck at status='generating' and, having no durable record of the
  // KIE task already in flight, resubmitted a brand-new paid generation
  // every time — burning ~300+ duplicate credits across 6 scenes in one
  // test. The fix: persist provider_ref immediately after submit() succeeds
  // (before polling), and treat a 'generating' row that HAS a provider_ref
  // as resumable rather than retriable. These two tests simulate "the
  // process died mid-poll" directly (writing the DB row a restart would
  // have left behind) rather than actually waiting out a real poll
  // timeout — that's the precondition state under test, not an
  // implementation detail being skipped.
  it('a scene clip stuck at generating WITH a stored provider_ref is resumed, not resubmitted', async () => {
    const { pipeline } = await makeJobAndPipeline('EN')
    const script = makeMockScriptGenerator()
    await runGenerateScript(client, pipeline, scriptInput, script)
    const { data: draftReady } = await client.from('content_pipelines').select('*').eq('id', pipeline.id).single()
    const approved = await approve(draftReady as PipelineRow, ['EN'])

    const image = makeMockImageGenerator()
    const uploader = makeFakeVideoUploader()
    const scaler = makeMockScaler()

    await runGenerateCharacterRef(client, approved, 'a reference prompt', image, uploader)
    const { data: generating } = await client.from('content_pipelines').select('*').eq('id', pipeline.id).single()
    // First tick: scene images only (clips aren't attempted until their
    // scene's image is already ready) — the video generator passed here is
    // never actually invoked this round.
    await runGenerateSceneVisual(
      client,
      generating as PipelineRow,
      'https://example.com/mock-img-1.png',
      image,
      makeMockVideoGenerator(),
      uploader,
      scaler,
    )

    const { data: scenes } = await client.from('video_scenes').select('*').eq('content_pipeline_id', pipeline.id)
    const scene = scenes![0]
    const otherScene = scenes![1]

    // Plant the EXACT DB state a killed-mid-poll worker would have left
    // behind under the fix: a submit() call already succeeded and was
    // already billed (hence the persisted provider_ref), but the process
    // died before ever observing the result.
    await upsertVisualAsset(client, {
      contentPipelineId: pipeline.id,
      generation: pipeline.current_generation,
      assetType: 'scene_video_clip',
      videoSceneId: scene.id,
      status: 'generating',
      providerRef: 'orphaned-inflight-task',
      attemptNumber: 1,
    })
    // The OTHER scene is marked already-ready so this test isolates to
    // scene[0]'s resume behavior — otherwise scene[1]'s own (unrelated,
    // never-yet-submitted) clip would also call submit() in the same
    // round, muddying the "submit must never be called" assertion below.
    await upsertVisualAsset(client, {
      contentPipelineId: pipeline.id,
      generation: pipeline.current_generation,
      assetType: 'scene_video_clip',
      videoSceneId: otherScene.id,
      status: 'ready',
      providerRef: 'other-scene-unrelated',
      fileUrl: 'https://example.com/other-scene-clip.mp4',
      attemptNumber: 1,
    })

    // Simulate the restart: a FRESH generator instance (as main() would
    // construct on process relaunch), whose submit() fails the test if
    // called at all, and whose poll() resolves the SAME provider_ref to
    // 'ready'.
    const resumedVideo: VideoGenerator = {
      submit: vi.fn(async () => {
        throw new Error('submit() must never be called — the existing task should have been resumed instead')
      }),
      poll: vi.fn(async (jobRef: { providerRef: string }): Promise<VideoPollResult> => {
        expect(jobRef.providerRef).toBe('orphaned-inflight-task') // resumed the EXACT orphaned task, not a new one
        return { status: 'ready', fileUrl: `https://example.com/${jobRef.providerRef}.mp4` }
      }),
    }
    const { data: stillGenerating } = await client.from('content_pipelines').select('*').eq('id', pipeline.id).single()
    await runGenerateSceneVisual(
      client,
      stillGenerating as PipelineRow,
      'https://example.com/mock-img-1.png',
      image,
      resumedVideo,
      uploader,
      scaler,
    )

    expect(resumedVideo.submit).not.toHaveBeenCalled()
    expect(resumedVideo.poll).toHaveBeenCalled()
    const { data: finalClip } = await client
      .from('content_visual_assets')
      .select('*')
      .eq('content_pipeline_id', pipeline.id)
      .eq('asset_type', 'scene_video_clip')
      .eq('video_scene_id', scene.id)
      .single()
    expect(finalClip.status).toBe('ready')
    expect(finalClip.provider_ref).toBe('orphaned-inflight-task') // still the resumed task's id, not a fresh one
    expect(finalClip.attempt_number).toBe(1) // resuming is not a new attempt
  })

  it('a scene clip whose resumed task genuinely failed IS resubmitted — a fresh paid attempt only happens after confirmation, never speculatively', async () => {
    const { pipeline } = await makeJobAndPipeline('EN')
    const script = makeMockScriptGenerator()
    await runGenerateScript(client, pipeline, scriptInput, script)
    const { data: draftReady } = await client.from('content_pipelines').select('*').eq('id', pipeline.id).single()
    const approved = await approve(draftReady as PipelineRow, ['EN'])

    const image = makeMockImageGenerator()
    const uploader = makeFakeVideoUploader()
    const scaler = makeMockScaler()

    await runGenerateCharacterRef(client, approved, 'a reference prompt', image, uploader)
    const { data: generating } = await client.from('content_pipelines').select('*').eq('id', pipeline.id).single()
    await runGenerateSceneVisual(
      client,
      generating as PipelineRow,
      'https://example.com/mock-img-1.png',
      image,
      makeMockVideoGenerator(),
      uploader,
      scaler,
    )

    const { data: scenes } = await client.from('video_scenes').select('*').eq('content_pipeline_id', pipeline.id)
    const scene = scenes![0]
    const otherScene = scenes![1]
    await upsertVisualAsset(client, {
      contentPipelineId: pipeline.id,
      generation: pipeline.current_generation,
      assetType: 'scene_video_clip',
      videoSceneId: scene.id,
      status: 'generating',
      providerRef: 'orphaned-but-genuinely-dead-task',
      attemptNumber: 1,
    })
    // Isolate this test to scene[0] — see the identical comment in the
    // "resumed, not resubmitted" test above for why.
    await upsertVisualAsset(client, {
      contentPipelineId: pipeline.id,
      generation: pipeline.current_generation,
      assetType: 'scene_video_clip',
      videoSceneId: otherScene.id,
      status: 'ready',
      providerRef: 'other-scene-unrelated',
      fileUrl: 'https://example.com/other-scene-clip.mp4',
      attemptNumber: 1,
    })

    // Resume it, but this time the provider genuinely reports failure —
    // the orphaned task really did die, it wasn't just slow.
    const failingResume: VideoGenerator = {
      submit: vi.fn(async () => ({ providerRef: 'mock-clip-fresh' })),
      poll: vi.fn(async (jobRef: { providerRef: string }): Promise<VideoPollResult> =>
        jobRef.providerRef === 'orphaned-but-genuinely-dead-task'
          ? { status: 'failed', detail: 'simulated genuine provider failure' }
          : { status: 'ready', fileUrl: `https://example.com/${jobRef.providerRef}.mp4` },
      ),
    }
    const { data: stillGenerating } = await client.from('content_pipelines').select('*').eq('id', pipeline.id).single()
    // backoffBaseDelayMs=0 so the subsequent legitimate retry isn't gated
    // on real elapsed time, matching the existing flaky-retry test's trick.
    await runGenerateSceneVisual(
      client,
      stillGenerating as PipelineRow,
      'https://example.com/mock-img-1.png',
      image,
      failingResume,
      uploader,
      scaler,
      0,
    )
    const { data: afterFailedResume } = await client.from('content_pipelines').select('*').eq('id', pipeline.id).single()
    await runGenerateSceneVisual(
      client,
      afterFailedResume as PipelineRow,
      'https://example.com/mock-img-1.png',
      image,
      failingResume,
      uploader,
      scaler,
      0,
    )

    // A fresh, legitimate submission DID happen — but only once the resumed
    // task was actually confirmed failed, never speculatively.
    expect(failingResume.submit).toHaveBeenCalledTimes(1)
    const { data: finalClip } = await client
      .from('content_visual_assets')
      .select('*')
      .eq('content_pipeline_id', pipeline.id)
      .eq('asset_type', 'scene_video_clip')
      .eq('video_scene_id', scene.id)
      .single()
    expect(finalClip.status).toBe('ready')
    expect(finalClip.provider_ref).toBe('mock-clip-fresh')
    expect(finalClip.attempt_number).toBe(2) // the failed resume (1) + the legitimate fresh retry (2)
  })

  it('a scene clip whose downscale step fails keeps the already-paid KIE clip — retrying resubmits to the scaler only, never pays for another KIE video generation', async () => {
    // Regression test for a real incident (2026-09-19): a live job's
    // downscale step ("upload_post call failed: downscale poll timed out")
    // failed on every scene, 3 attempts in a row, burning a fresh paid KIE
    // video generation on every single retry — 18 wasted charges — because
    // the old code discarded the already-successful KIE clip the moment the
    // UNRELATED downscale step failed. The fix: persist the raw KIE clip
    // URL (content_visual_assets.raw_file_url) the instant KIE succeeds, and
    // resume straight into the scale step on retry instead of resubmitting.
    const { pipeline } = await makeJobAndPipeline('EN')
    const script = makeMockScriptGenerator()
    await runGenerateScript(client, pipeline, scriptInput, script)
    const { data: draftReady } = await client.from('content_pipelines').select('*').eq('id', pipeline.id).single()
    const approved = await approve(draftReady as PipelineRow, ['EN'])

    const image = makeMockImageGenerator()
    const uploader = makeFakeVideoUploader()
    const video = makeMockVideoGenerator()

    await runGenerateCharacterRef(client, approved, 'a reference prompt', image, uploader)
    const { data: afterCharRef } = await client.from('content_pipelines').select('*').eq('id', pipeline.id).single()

    const failingScaler: SceneClipScaler = {
      submitScale: vi.fn(async () => ({ providerRef: 'scale-attempt-1' })),
      poll: vi.fn(async (): Promise<AVMergeResult> => ({ status: 'failed', detail: 'simulated downscale timeout' })),
    }

    // Tick 1: produces the scene_image for every scene (see the identical
    // two-tick comment on the "M2 produces..." test above).
    await runGenerateSceneVisual(client, afterCharRef as PipelineRow, 'https://example.com/mock-img-1.png', image, video, uploader, failingScaler, 0)
    const { data: afterImages } = await client.from('content_pipelines').select('*').eq('id', pipeline.id).single()

    // Tick 2: images are ready, so this attempts the video clip for every
    // scene — KIE succeeds (video mock), but the downscale step fails.
    await runGenerateSceneVisual(client, afterImages as PipelineRow, 'https://example.com/mock-img-1.png', image, video, uploader, failingScaler, 0)

    const kieCallsAfterFailure = video.submit.mock.calls.length
    expect(kieCallsAfterFailure).toBeGreaterThan(0) // KIE really was called (and paid for) once per scene

    const { data: failedClips } = await client
      .from('content_visual_assets')
      .select('*')
      .eq('content_pipeline_id', pipeline.id)
      .eq('asset_type', 'scene_video_clip')
    expect(failedClips!.length).toBeGreaterThan(0)
    for (const clip of failedClips!) {
      expect(clip.status).toBe('failed')
      // The raw KIE clip URL is kept, not discarded — this is the fix.
      expect(clip.raw_file_url).toMatch(/^https:\/\/example\.com\/mock-clip-\d+\.mp4$/)
    }

    // Now the downscale step succeeds. Retrying must resume straight into
    // the scale step using the preserved raw_file_url, WITHOUT calling KIE
    // again for any scene.
    const succeedingScaler = makeMockScaler()
    const { data: afterFirstFailure } = await client.from('content_pipelines').select('*').eq('id', pipeline.id).single()
    await runGenerateSceneVisual(client, afterFirstFailure as PipelineRow, 'https://example.com/mock-img-1.png', image, video, uploader, succeedingScaler, 0)

    expect(video.submit.mock.calls.length).toBe(kieCallsAfterFailure) // no NEW KIE calls during the downscale-only retry
    expect(succeedingScaler.submitScale).toHaveBeenCalled()

    const { data: readyClips } = await client
      .from('content_visual_assets')
      .select('*')
      .eq('content_pipeline_id', pipeline.id)
      .eq('asset_type', 'scene_video_clip')
    for (const clip of readyClips!) {
      expect(clip.status).toBe('ready')
      expect(clip.raw_file_url).toBeNull() // cleaned up once ready, no longer needed
      expect(clip.file_url).toBeTruthy()
    }
  })

  it('M3: BOTH — localize_script produces genuinely different, independent narration per language', async () => {
    const { pipeline } = await makeJobAndPipeline('BOTH')
    const scriptGen = makeLocalizeAwareScriptGenerator()
    await runGenerateScript(client, pipeline, scriptInput, scriptGen)
    const { data: draftReady } = await client.from('content_pipelines').select('*').eq('id', pipeline.id).single()
    const approved = await approve(draftReady as PipelineRow, ['EN', 'FR'])

    const { data: tracks } = await client.from('content_language_tracks').select('*').eq('content_pipeline_id', pipeline.id)
    const enTrack = tracks!.find((t) => t.language === 'EN') as TrackRow
    const frTrack = tracks!.find((t) => t.language === 'FR') as TrackRow

    await runLocalizeScript(client, enTrack, approved.id, scriptGen)
    await runLocalizeScript(client, frTrack, approved.id, scriptGen)

    const { data: enAudio } = await client.from('video_scene_audio').select('*').eq('content_language_track_id', enTrack.id)
    const { data: frAudio } = await client.from('video_scene_audio').select('*').eq('content_language_track_id', frTrack.id)
    expect(enAudio).toHaveLength(2)
    expect(frAudio).toHaveLength(2)
    expect(enAudio!.every((a) => a.narration_text.startsWith('English text'))).toBe(true)
    expect(frAudio!.every((a) => a.narration_text.startsWith('Texte français'))).toBe(true)
    // never literal wording copied across languages
    expect(enAudio!.some((a) => a.narration_text.includes('français'))).toBe(false)
  })

  it('M3: EN-only reaches awaiting_shared with combined, cumulatively-offset caption timing', async () => {
    const { jobId, pipeline } = await makeJobAndPipeline('EN')
    const scriptGen = makeLocalizeAwareScriptGenerator()
    await runGenerateScript(client, pipeline, scriptInput, scriptGen)
    const { data: draftReady } = await client.from('content_pipelines').select('*').eq('id', pipeline.id).single()
    const approved = await approve(draftReady as PipelineRow, ['EN'])
    const { data: tracks } = await client.from('content_language_tracks').select('*').eq('content_pipeline_id', pipeline.id)
    const track = tracks![0] as TrackRow

    await runLocalizeScript(client, track, approved.id, scriptGen)
    const { data: afterLocalize } = await client.from('content_language_tracks').select('*').eq('id', track.id).single()

    const voice = makeMockVoiceSynthesizer()
    const uploader = makeFakeVideoUploader()
    await runSynthesizeVoice(client, afterLocalize as TrackRow, approved.id, jobId, voice, uploader)
    expect(voice.synthesize).toHaveBeenCalledTimes(2) // one per scene

    const { data: audioRows } = await client.from('video_scene_audio').select('*').eq('content_language_track_id', track.id)
    expect(audioRows!.every((a) => a.status === 'ready' && a.file_url && a.duration_ms! > 0)).toBe(true)

    const { data: afterSynthesize } = await client.from('content_language_tracks').select('*').eq('id', track.id).single()
    const transcription = makeMockTranscriptionService()
    await runTranscribeAudio(client, afterSynthesize as TrackRow, approved.id, transcription)
    expect(transcription.submit).toHaveBeenCalledTimes(2) // one per scene, no concatenation service exists yet

    const { data: finalTrack } = await client.from('content_language_tracks').select('*').eq('id', track.id).single()
    expect(finalTrack.status).toBe('awaiting_shared')

    const { data: captions } = await client
      .from('video_captions')
      .select('*')
      .eq('content_language_track_id', track.id)
      .single()
    const words = captions.timing_data as Array<{ text: string; start: number; end: number }>
    expect(words).toHaveLength(4) // 2 words/scene x 2 scenes
    // second scene's words are shifted by the first scene's own duration_ms
    // — not just concatenated at the same offsets as the first scene's.
    expect(words[0].start).toBe(0)
    expect(words[2].start).toBeGreaterThan(words[1].end)
  })

  it("M3: caption offsets use AssemblyAI's real per-word timing, not synthesizeVoice's word-count estimate", async () => {
    // Regression test for a real sync bug: scene 1 and scene 2's narration
    // text here ("English text for scene 1"/"...scene 2") have the SAME
    // word count, so synthesizeVoice.ts's estimate is IDENTICAL for both
    // (2000ms). If transcribeAudio.ts were still using that estimate as the
    // offset, scene 2's words would start at 2000ms regardless of what the
    // transcription service reports. Feeding a real second-word end of
    // 4700ms here (+ the 300ms TRAILING_SILENCE_BUFFER_MS = 5000ms) and
    // asserting scene 2 starts at exactly 5000ms proves the real per-word
    // timing — not the estimate — is what actually drives the offset.
    const { jobId, pipeline } = await makeJobAndPipeline('EN')
    const scriptGen = makeLocalizeAwareScriptGenerator()
    await runGenerateScript(client, pipeline, scriptInput, scriptGen)
    const { data: draftReady } = await client.from('content_pipelines').select('*').eq('id', pipeline.id).single()
    const approved = await approve(draftReady as PipelineRow, ['EN'])
    const { data: tracks } = await client.from('content_language_tracks').select('*').eq('content_pipeline_id', pipeline.id)
    const track = tracks![0] as TrackRow

    await runLocalizeScript(client, track, approved.id, scriptGen)
    const { data: afterLocalize } = await client.from('content_language_tracks').select('*').eq('id', track.id).single()

    const voice = makeMockVoiceSynthesizer()
    const uploader = makeFakeVideoUploader()
    await runSynthesizeVoice(client, afterLocalize as TrackRow, approved.id, jobId, voice, uploader)

    const { data: audioRows } = await client.from('video_scene_audio').select('*').eq('content_language_track_id', track.id)
    // The estimate synthesizeVoice.ts actually stored — same for both scenes
    // (equal word counts) — kept only to assert it's genuinely DIFFERENT
    // from the real duration this test feeds in, so the test would fail if
    // the fix silently fell back to the estimate.
    expect(audioRows!.every((a) => a.duration_ms === 2000)).toBe(true)

    const { data: afterSynthesize } = await client.from('content_language_tracks').select('*').eq('id', track.id).single()
    const transcription = makeMockTranscriptionService(4700)
    await runTranscribeAudio(client, afterSynthesize as TrackRow, approved.id, transcription)

    const { data: captions } = await client
      .from('video_captions')
      .select('*')
      .eq('content_language_track_id', track.id)
      .single()
    const words = captions.timing_data as Array<{ text: string; start: number; end: number }>
    expect(words[0].start).toBe(0)
    expect(words[2].start).toBe(5000) // real word-end (4700) + buffer (300), not the 2000ms estimate

    // The same real value also lands in video_scene_audio.duration_ms —
    // renderLanguageTrack.ts's Pass 0 padding reads this column, so this is
    // what actually protects the render-time fix, not just the captions.
    const { data: audioRowsAfter } = await client.from('video_scene_audio').select('*').eq('content_language_track_id', track.id)
    expect(audioRowsAfter!.every((a) => a.duration_ms === 5000)).toBe(true)
  })

  it('M3: one language failing (ElevenLabs down) never blocks or corrupts the other', async () => {
    const { pipeline } = await makeJobAndPipeline('BOTH')
    const scriptGen = makeLocalizeAwareScriptGenerator()
    await runGenerateScript(client, pipeline, scriptInput, scriptGen)
    const { data: draftReady } = await client.from('content_pipelines').select('*').eq('id', pipeline.id).single()
    const approved = await approve(draftReady as PipelineRow, ['EN', 'FR'])
    const { data: tracks } = await client.from('content_language_tracks').select('*').eq('content_pipeline_id', pipeline.id)
    const enTrack = tracks!.find((t) => t.language === 'EN') as TrackRow
    const frTrack = tracks!.find((t) => t.language === 'FR') as TrackRow

    await runLocalizeScript(client, enTrack, approved.id, scriptGen)
    await runLocalizeScript(client, frTrack, approved.id, scriptGen)

    const workingVoice = makeMockVoiceSynthesizer()
    const failingVoice = makeFailingVoiceSynthesizer()
    const uploader = makeFakeVideoUploader()

    const { data: enAfterLocalize } = await client.from('content_language_tracks').select('*').eq('id', enTrack.id).single()
    const { data: frAfterLocalize } = await client.from('content_language_tracks').select('*').eq('id', frTrack.id).single()

    await runSynthesizeVoice(client, enAfterLocalize as TrackRow, approved.id, pipeline.job_id, workingVoice, uploader)
    await runSynthesizeVoice(client, frAfterLocalize as TrackRow, approved.id, pipeline.job_id, failingVoice, uploader)

    const { data: enAudio } = await client.from('video_scene_audio').select('*').eq('content_language_track_id', enTrack.id)
    const { data: frAudio } = await client.from('video_scene_audio').select('*').eq('content_language_track_id', frTrack.id)
    expect(enAudio!.every((a) => a.status === 'ready')).toBe(true)
    expect(frAudio!.every((a) => a.status === 'failed')).toBe(true)

    const { data: enTrackFresh } = await client.from('content_language_tracks').select('*').eq('id', enTrack.id).single()
    const { data: frTrackFresh } = await client.from('content_language_tracks').select('*').eq('id', frTrack.id).single()
    expect(enTrackFresh.status).toBe('generating') // EN unaffected by FR's failure
    expect(frTrackFresh.last_error).toContain('simulated transient ElevenLabs failure')
  })

  it('M3: re-running localize_script/synthesize_voice/transcribe_captions after success calls no provider again', async () => {
    const { jobId, pipeline } = await makeJobAndPipeline('EN')
    const scriptGen = makeLocalizeAwareScriptGenerator()
    await runGenerateScript(client, pipeline, scriptInput, scriptGen)
    const { data: draftReady } = await client.from('content_pipelines').select('*').eq('id', pipeline.id).single()
    const approved = await approve(draftReady as PipelineRow, ['EN'])
    const { data: tracks } = await client.from('content_language_tracks').select('*').eq('content_pipeline_id', pipeline.id)
    const track = tracks![0] as TrackRow

    const voice = makeMockVoiceSynthesizer()
    const transcription = makeMockTranscriptionService()
    const uploader = makeFakeVideoUploader()

    await runLocalizeScript(client, track, approved.id, scriptGen)
    let fresh = (await client.from('content_language_tracks').select('*').eq('id', track.id).single()).data as TrackRow
    await runSynthesizeVoice(client, fresh, approved.id, jobId, voice, uploader)
    fresh = (await client.from('content_language_tracks').select('*').eq('id', track.id).single()).data as TrackRow
    await runTranscribeAudio(client, fresh, approved.id, transcription)
    fresh = (await client.from('content_language_tracks').select('*').eq('id', track.id).single()).data as TrackRow
    expect(fresh.status).toBe('awaiting_shared')

    // Second pass — should be entirely a no-op.
    await runLocalizeScript(client, fresh, approved.id, scriptGen)
    await runSynthesizeVoice(client, fresh, approved.id, jobId, voice, uploader)
    await runTranscribeAudio(client, fresh, approved.id, transcription)

    expect(scriptGen.generate).toHaveBeenCalledTimes(2) // generate_script + localize_script, not re-called
    expect(voice.synthesize).toHaveBeenCalledTimes(2) // one per scene, not re-called
    expect(transcription.submit).toHaveBeenCalledTimes(2) // one per scene, not re-called
  })

  it('a track stuck at "generating" after transcribe_captions already succeeded catches up to "awaiting_shared" instead of being stranded forever', async () => {
    // Regression test (2026-09-19): transcribe_captions is the ONLY step
    // that advances a track to 'awaiting_shared' (see runTranscribeAudio's
    // own header). Its old code short-circuited on `alreadySucceeded`
    // BEFORE ever reaching that transition — so a crash/restart between
    // recordStepAttempt(succeeded) and claimTrack (or, as happened live
    // during a real manual recovery, an external process resetting
    // track.status back to 'generating' without touching the already-
    // succeeded step record) left the track stuck at 'generating' forever:
    // every future call hit the same early return and never reached the
    // real claimTrack line. renderLanguageTrack.ts's own 'render' step
    // already had this exact fix (see its identical incident comment);
    // transcribeAudio.ts was simply missing it.
    const { jobId, pipeline } = await makeJobAndPipeline('EN')
    const scriptGen = makeLocalizeAwareScriptGenerator()
    await runGenerateScript(client, pipeline, scriptInput, scriptGen)
    const { data: draftReady } = await client.from('content_pipelines').select('*').eq('id', pipeline.id).single()
    const approved = await approve(draftReady as PipelineRow, ['EN'])
    const { data: tracks } = await client.from('content_language_tracks').select('*').eq('content_pipeline_id', pipeline.id)
    const track = tracks![0] as TrackRow

    const voice = makeMockVoiceSynthesizer()
    const transcription = makeMockTranscriptionService()
    const uploader = makeFakeVideoUploader()

    await runLocalizeScript(client, track, approved.id, scriptGen)
    let fresh = (await client.from('content_language_tracks').select('*').eq('id', track.id).single()).data as TrackRow
    await runSynthesizeVoice(client, fresh, approved.id, jobId, voice, uploader)
    fresh = (await client.from('content_language_tracks').select('*').eq('id', track.id).single()).data as TrackRow
    await runTranscribeAudio(client, fresh, approved.id, transcription)
    fresh = (await client.from('content_language_tracks').select('*').eq('id', track.id).single()).data as TrackRow
    expect(fresh.status).toBe('awaiting_shared')

    // Simulate the stuck state directly: transcribe_captions' own
    // pipeline_steps row and video_captions row are untouched (the real
    // work genuinely succeeded) — only track.status regresses, exactly what
    // a crash between recordStepAttempt and claimTrack (or an external
    // reset) would produce.
    await client.from('content_language_tracks').update({ status: 'generating' }).eq('id', track.id)
    const stuck = (await client.from('content_language_tracks').select('*').eq('id', track.id).single()).data as TrackRow
    expect(stuck.status).toBe('generating')

    await runTranscribeAudio(client, stuck, approved.id, transcription)
    const recovered = (await client.from('content_language_tracks').select('*').eq('id', track.id).single()).data as TrackRow

    expect(recovered.status).toBe('awaiting_shared') // caught up, not stranded
    expect(transcription.submit).toHaveBeenCalledTimes(2) // still just the original per-scene calls — no re-transcription
  })

  it('M4: EN-only reaches a real generated_content row end-to-end (script -> approve -> visuals -> audio/captions -> render)', async () => {
    const { jobId, pipeline } = await makeJobAndPipeline('EN')
    const scriptGen = makeLocalizeAwareScriptGenerator()
    await runGenerateScript(client, pipeline, scriptInput, scriptGen)
    const { data: draftReady } = await client.from('content_pipelines').select('*').eq('id', pipeline.id).single()
    const approved = await approve(draftReady as PipelineRow, ['EN'])

    const image = makeMockImageGenerator()
    const video = makeMockVideoGenerator()
    const uploader = makeFakeVideoUploader()
    const scaler = makeMockScaler()
    await runGenerateCharacterRef(client, approved, 'a reference prompt', image, uploader)
    const { data: generating } = await client.from('content_pipelines').select('*').eq('id', pipeline.id).single()
    await runGenerateSceneVisual(client, generating as PipelineRow, 'https://example.com/mock-img-1.png', image, video, uploader, scaler)
    await runGenerateSceneVisual(client, generating as PipelineRow, 'https://example.com/mock-img-1.png', image, video, uploader, scaler)
    const { data: visualsReady } = await client.from('content_pipelines').select('*').eq('id', pipeline.id).single()
    expect(visualsReady.status).toBe('ready')

    const { data: tracks } = await client.from('content_language_tracks').select('*').eq('content_pipeline_id', pipeline.id)
    let track = tracks![0] as TrackRow
    await runLocalizeScript(client, track, approved.id, scriptGen)
    track = (await client.from('content_language_tracks').select('*').eq('id', track.id).single()).data as TrackRow

    const voice = makeMockVoiceSynthesizer()
    await runSynthesizeVoice(client, track, approved.id, jobId, voice, uploader)
    track = (await client.from('content_language_tracks').select('*').eq('id', track.id).single()).data as TrackRow

    const transcription = makeMockTranscriptionService()
    await runTranscribeAudio(client, track, approved.id, transcription)
    track = (await client.from('content_language_tracks').select('*').eq('id', track.id).single()).data as TrackRow
    expect(track.status).toBe('awaiting_shared')

    const avMerger = makeMockAVMerger()
    await runRenderLanguageTrack(client, track, visualsReady as PipelineRow, avMerger, uploader)

    const { data: finalTrack } = await client.from('content_language_tracks').select('*').eq('id', track.id).single()
    expect(finalTrack.status).toBe('ready')
    // Video and audio are concatenated INDEPENDENTLY (not one mixed
    // concat — that truncates audio to ~2s regardless of scene count,
    // confirmed live 2026-09-12), then muxed back together.
    expect(avMerger.submitVideoConcat).toHaveBeenCalledTimes(1)
    expect(avMerger.submitAudioConcat).toHaveBeenCalledTimes(1)
    const submittedVideoInput = (avMerger.submitVideoConcat as ReturnType<typeof vi.fn>).mock.calls[0][0]
    const submittedAudioInput = (avMerger.submitAudioConcat as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(submittedVideoInput.scenes).toHaveLength(2) // one (clip, audio) pair per scene
    expect(submittedAudioInput.scenes).toHaveLength(2)
    expect(avMerger.submitMux).toHaveBeenCalledTimes(1)
    // Real caption timing data comes back from the mock transcription
    // service above, so the caption-burn pass must also run — upload-post.com
    // rejects any ';' in full_command, so concat/mux/caption burn-in are all
    // separate jobs.
    expect(avMerger.submitCaptionBurn).toHaveBeenCalledTimes(1)

    const { data: row } = await client
      .from('generated_content')
      .select('*')
      .eq('job_id', jobId)
      .eq('content_type', 'video')
      .eq('language', 'EN')
      .single()
    expect(row.status).toBe('completed')
    expect(row.file_url).toContain('freshcan-videos')
    expect(row.output_data.total_scenes).toBe(2)
  })

  it('M4: render does not run until the pipeline\'s shared visuals are ready (generation fencing)', async () => {
    const { pipeline } = await makeJobAndPipeline('EN')
    const scriptGen = makeLocalizeAwareScriptGenerator()
    await runGenerateScript(client, pipeline, scriptInput, scriptGen)
    const { data: draftReady } = await client.from('content_pipelines').select('*').eq('id', pipeline.id).single()
    await approve(draftReady as PipelineRow, ['EN'])
    const { data: tracks } = await client.from('content_language_tracks').select('*').eq('content_pipeline_id', pipeline.id)
    const track = tracks![0] as TrackRow

    // Fabricate a track already at 'awaiting_shared' without actually
    // finishing M2's shared visuals — the pipeline is still 'created'.
    await client.from('content_language_tracks').update({ status: 'awaiting_shared' }).eq('id', track.id)
    const staleTrack = { ...track, status: 'awaiting_shared' } as TrackRow

    const avMerger = makeMockAVMerger()
    const uploader = makeFakeVideoUploader()
    const result = await runRenderLanguageTrack(client, staleTrack, pipeline, avMerger, uploader)

    expect(result.ran).toBe(false)
    expect(avMerger.submitVideoConcat).not.toHaveBeenCalled()

    // Same guard applies when generations don't match, even if the
    // pipeline itself says 'ready'.
    const mismatchedPipeline = { ...pipeline, status: 'ready', current_generation: 2 } as PipelineRow
    const result2 = await runRenderLanguageTrack(client, staleTrack, mismatchedPipeline, avMerger, uploader)
    expect(result2.ran).toBe(false)
    expect(avMerger.submitVideoConcat).not.toHaveBeenCalled()
  })

  it('M5: a visuals-only regenerate reuses the SAME scene plan (never rewritten) while producing new visual assets at the bumped generation', async () => {
    const { jobId, pipeline } = await makeJobAndPipeline('EN')
    const scriptGen = makeLocalizeAwareScriptGenerator()
    await runGenerateScript(client, pipeline, scriptInput, scriptGen)
    const { data: draftReady } = await client.from('content_pipelines').select('*').eq('id', pipeline.id).single()
    const approved = await approve(draftReady as PipelineRow, ['EN'])

    const image = makeMockImageGenerator()
    const video = makeMockVideoGenerator()
    const uploader = makeFakeVideoUploader()
    const scaler = makeMockScaler()
    await runGenerateCharacterRef(client, approved, 'a reference prompt', image, uploader)
    let fresh = (await client.from('content_pipelines').select('*').eq('id', pipeline.id).single()).data as PipelineRow
    await runGenerateSceneVisual(client, fresh, 'https://example.com/mock-img-1.png', image, video, uploader, scaler)
    await runGenerateSceneVisual(client, fresh, 'https://example.com/mock-img-1.png', image, video, uploader, scaler)
    const { data: readyGen1 } = await client.from('content_pipelines').select('*').eq('id', pipeline.id).single()
    expect(readyGen1.status).toBe('ready')

    const { data: scenesBeforeRegen } = await client.from('video_scenes').select('*').eq('content_pipeline_id', pipeline.id)
    expect(scenesBeforeRegen).toHaveLength(2) // unchanged from M1 — never rewritten by a visuals regen

    // ── Regenerate visuals ──────────────────────────────────────────────
    const { newGeneration } = await regenerateVisuals(readyGen1 as PipelineRow)
    expect(newGeneration).toBe(2)

    const image2 = makeMockImageGenerator()
    const video2 = makeMockVideoGenerator()
    const scaler2 = makeMockScaler()
    await runGenerateCharacterRef(client, { ...(readyGen1 as PipelineRow), current_generation: newGeneration, status: 'generating' }, 'a reference prompt', image2, uploader)
    fresh = (await client.from('content_pipelines').select('*').eq('id', pipeline.id).single()).data as PipelineRow
    await runGenerateSceneVisual(client, fresh, 'https://example.com/mock-img-2.png', image2, video2, uploader, scaler2)
    await runGenerateSceneVisual(client, fresh, 'https://example.com/mock-img-2.png', image2, video2, uploader, scaler2)
    const { data: readyGen2 } = await client.from('content_pipelines').select('*').eq('id', pipeline.id).single()
    expect(readyGen2.status).toBe('ready')
    expect(readyGen2.current_generation).toBe(2)

    // Scene plan is STILL the same 2 rows — a visuals regen never touched video_scenes.
    const { data: scenesAfterRegen } = await client.from('video_scenes').select('*').eq('content_pipeline_id', pipeline.id)
    expect(scenesAfterRegen).toHaveLength(2)

    // But there are now TWO generations of visual assets — old (gen 1) and new (gen 2)
    // — as distinct DB rows. (Storage paths are generation-agnostic by
    // design — {job_id}/character-ref.png — so file_url legitimately stays
    // the same string across generations; a regen overwrites that file in
    // place rather than versioning it. Row existence per generation is the
    // thing that actually matters here, not the URL string.)
    const { data: allAssets } = await client.from('content_visual_assets').select('*').eq('content_pipeline_id', pipeline.id)
    const gen1CharacterRefs = allAssets!.filter((a) => a.asset_type === 'character_ref' && a.generation === 1)
    const gen2CharacterRefs = allAssets!.filter((a) => a.asset_type === 'character_ref' && a.generation === 2)
    expect(gen1CharacterRefs).toHaveLength(1)
    expect(gen2CharacterRefs).toHaveLength(1)
    expect(gen1CharacterRefs[0].id).not.toBe(gen2CharacterRefs[0].id)

    // The reset track re-runs localize/synthesize/transcribe/render fresh at gen 2.
    const { data: trackAfterReset } = await client
      .from('content_language_tracks')
      .select('*')
      .eq('content_pipeline_id', pipeline.id)
      .single()
    expect(trackAfterReset.master_generation_used).toBe(2)
    expect(trackAfterReset.status).toBe('waiting_on_shared')

    const scriptGen2 = makeLocalizeAwareScriptGenerator()
    await runLocalizeScript(client, trackAfterReset as TrackRow, pipeline.id, scriptGen2)
    let trackFresh = (await client.from('content_language_tracks').select('*').eq('id', trackAfterReset.id).single()).data as TrackRow
    const voice2 = makeMockVoiceSynthesizer()
    await runSynthesizeVoice(client, trackFresh, pipeline.id, jobId, voice2, uploader)
    trackFresh = (await client.from('content_language_tracks').select('*').eq('id', trackAfterReset.id).single()).data as TrackRow
    const transcription2 = makeMockTranscriptionService()
    await runTranscribeAudio(client, trackFresh, pipeline.id, transcription2)
    trackFresh = (await client.from('content_language_tracks').select('*').eq('id', trackAfterReset.id).single()).data as TrackRow
    expect(trackFresh.status).toBe('awaiting_shared')

    const avMerger2 = makeMockAVMerger()
    await runRenderLanguageTrack(client, trackFresh, readyGen2 as PipelineRow, avMerger2, uploader)
    const { data: trackFinal } = await client.from('content_language_tracks').select('*').eq('id', trackAfterReset.id).single()
    expect(trackFinal.status).toBe('ready')

    const { data: finalRow } = await client
      .from('generated_content')
      .select('*')
      .eq('job_id', jobId)
      .eq('content_type', 'video')
      .single()
    expect(finalRow.status).toBe('completed')
  })
})
