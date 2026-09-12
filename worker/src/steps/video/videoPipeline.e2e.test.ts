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
import { createServiceClient, type PipelineRow, type TrackRow } from '../../db.js'
import { runGenerateScript, type VideoScriptJobInput } from './generateScript.js'
import { runGenerateCharacterRef } from './generateCharacterRef.js'
import { runGenerateSceneVisual } from './generateSceneVisual.js'
import { runLocalizeScript } from './localizeScript.js'
import { runSynthesizeVoice } from './synthesizeVoice.js'
import { runTranscribeAudio } from './transcribeAudio.js'
import { runRenderLanguageTrack } from './renderLanguageTrack.js'
import { BRAND_PROFILE } from '../../prompts/index.js'
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
} from '../../adapters/types.js'
import type { VideoStorageUploader } from '../../adapters/storage.js'

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
// scene's combined words are shifted by the first scene's duration_ms, not
// just that 4 words exist.
function makeMockTranscriptionService() {
  let counter = 0
  const submit = vi.fn(async () => ({ providerRef: `transcript-${++counter}` }))
  const poll = vi.fn(
    async (): Promise<TranscriptionPollResult> => ({
      status: 'ready',
      timingData: [
        { text: 'word1', start: 0, end: 400 },
        { text: 'word2', start: 400, end: 800 },
      ],
      text: 'word1 word2',
    }),
  )
  return { submit, poll } satisfies TranscriptionService
}

function makeMockAVMerger() {
  let counter = 0
  const submitVideoConcat = vi.fn(async () => ({ providerRef: `video-concat-${++counter}` }))
  const submitAudioConcat = vi.fn(async () => ({ providerRef: `audio-concat-${++counter}` }))
  const submitMux = vi.fn(async () => ({ providerRef: `mux-${++counter}` }))
  const submitCaptionBurn = vi.fn(async () => ({ providerRef: `caption-${++counter}` }))
  const poll = vi.fn(async (): Promise<AVMergeResult> => ({ status: 'ready', fileBuffer: Buffer.from(`fake-video-${counter}`) }))
  return { submitVideoConcat, submitAudioConcat, submitMux, submitCaptionBurn, poll } satisfies AVMerger
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

    await runGenerateCharacterRef(client, approved, 'a reference prompt', image, uploader)
    const { data: generating } = await client.from('content_pipelines').select('*').eq('id', pipeline.id).single()
    expect(generating.status).toBe('generating')

    // Two ticks: each tick advances every scene by exactly one sub-step
    // (image, then clip) — matching the real polling model, where a scene's
    // clip generation only starts once its image is already ready.
    await runGenerateSceneVisual(client, generating as PipelineRow, 'https://example.com/mock-img-1.png', image, video, uploader)
    await runGenerateSceneVisual(client, generating as PipelineRow, 'https://example.com/mock-img-1.png', image, video, uploader)

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

    await runGenerateCharacterRef(client, approved, 'a reference prompt', image, uploader)
    const { data: generating } = await client.from('content_pipelines').select('*').eq('id', pipeline.id).single()
    await runGenerateSceneVisual(client, generating as PipelineRow, 'https://example.com/mock-img-1.png', image, video, uploader)
    await runGenerateSceneVisual(client, generating as PipelineRow, 'https://example.com/mock-img-1.png', image, video, uploader)

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

  it('re-running generate_character_ref and generate_scene_visual after success does not call any provider again', async () => {
    const { pipeline } = await makeJobAndPipeline('EN')
    const script = makeMockScriptGenerator()
    await runGenerateScript(client, pipeline, scriptInput, script)
    const { data: draftReady } = await client.from('content_pipelines').select('*').eq('id', pipeline.id).single()
    const approved = await approve(draftReady as PipelineRow, ['EN'])

    const image = makeMockImageGenerator()
    const video = makeMockVideoGenerator()
    const uploader = makeFakeVideoUploader()

    await runGenerateCharacterRef(client, approved, 'a reference prompt', image, uploader)
    const { data: generating } = await client.from('content_pipelines').select('*').eq('id', pipeline.id).single()
    // Two ticks to reach real completion (image, then clip, per scene).
    await runGenerateSceneVisual(client, generating as PipelineRow, 'https://example.com/mock-img-1.png', image, video, uploader)
    await runGenerateSceneVisual(client, generating as PipelineRow, 'https://example.com/mock-img-1.png', image, video, uploader)
    const { data: ready } = await client.from('content_pipelines').select('*').eq('id', pipeline.id).single()
    expect(ready.status).toBe('ready')

    // Third tick — genuinely a no-op now that everything already succeeded.
    await runGenerateCharacterRef(client, ready as PipelineRow, 'a reference prompt', image, uploader)
    await runGenerateSceneVisual(client, ready as PipelineRow, 'https://example.com/mock-img-1.png', image, video, uploader)

    expect(image.submit).toHaveBeenCalledTimes(3) // character_ref + 2 scene images, not re-called
    expect(video.submit).toHaveBeenCalledTimes(2)
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

  it('M4: EN-only reaches a real generated_content row end-to-end (script -> approve -> visuals -> audio/captions -> render)', async () => {
    const { jobId, pipeline } = await makeJobAndPipeline('EN')
    const scriptGen = makeLocalizeAwareScriptGenerator()
    await runGenerateScript(client, pipeline, scriptInput, scriptGen)
    const { data: draftReady } = await client.from('content_pipelines').select('*').eq('id', pipeline.id).single()
    const approved = await approve(draftReady as PipelineRow, ['EN'])

    const image = makeMockImageGenerator()
    const video = makeMockVideoGenerator()
    const uploader = makeFakeVideoUploader()
    await runGenerateCharacterRef(client, approved, 'a reference prompt', image, uploader)
    const { data: generating } = await client.from('content_pipelines').select('*').eq('id', pipeline.id).single()
    await runGenerateSceneVisual(client, generating as PipelineRow, 'https://example.com/mock-img-1.png', image, video, uploader)
    await runGenerateSceneVisual(client, generating as PipelineRow, 'https://example.com/mock-img-1.png', image, video, uploader)
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
    await runGenerateCharacterRef(client, approved, 'a reference prompt', image, uploader)
    let fresh = (await client.from('content_pipelines').select('*').eq('id', pipeline.id).single()).data as PipelineRow
    await runGenerateSceneVisual(client, fresh, 'https://example.com/mock-img-1.png', image, video, uploader)
    await runGenerateSceneVisual(client, fresh, 'https://example.com/mock-img-1.png', image, video, uploader)
    const { data: readyGen1 } = await client.from('content_pipelines').select('*').eq('id', pipeline.id).single()
    expect(readyGen1.status).toBe('ready')

    const { data: scenesBeforeRegen } = await client.from('video_scenes').select('*').eq('content_pipeline_id', pipeline.id)
    expect(scenesBeforeRegen).toHaveLength(2) // unchanged from M1 — never rewritten by a visuals regen

    // ── Regenerate visuals ──────────────────────────────────────────────
    const { newGeneration } = await regenerateVisuals(readyGen1 as PipelineRow)
    expect(newGeneration).toBe(2)

    const image2 = makeMockImageGenerator()
    const video2 = makeMockVideoGenerator()
    await runGenerateCharacterRef(client, { ...(readyGen1 as PipelineRow), current_generation: newGeneration, status: 'generating' }, 'a reference prompt', image2, uploader)
    fresh = (await client.from('content_pipelines').select('*').eq('id', pipeline.id).single()).data as PipelineRow
    await runGenerateSceneVisual(client, fresh, 'https://example.com/mock-img-2.png', image2, video2, uploader)
    await runGenerateSceneVisual(client, fresh, 'https://example.com/mock-img-2.png', image2, video2, uploader)
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
