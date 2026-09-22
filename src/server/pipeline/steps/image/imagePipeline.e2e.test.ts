// End-to-end test of the full image_post worker flow — REAL database (live
// Supabase, self-cleaning throwaway rows), MOCKED provider adapters AND a
// fake storage uploader (no OPENAI_API_KEY/KIE.ai key/network needed).
// Mirrors blogPipeline.e2e.test.ts's structure and the same core claims:
//   - EN-only, FR-only, and BOTH all work through the same step handlers
//   - BOTH's two tracks share the identical shared photo URL, and each gets
//     its own real language row in generated_content — never a literal
//     'BOTH' value or concatenated captions (the documented live bug this
//     migration fixes, ARCHITECTURE.MD §17.4)
//   - one language failing never corrupts or blocks the other
//   - provider failures retry and eventually succeed
//   - re-running a step that already succeeded does not call the provider again
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceClient, type PipelineRow, type TrackRow } from '../../db'
import { runGeneratePhoto } from './generatePhoto'
import { runGenerateCaption } from './generateCaption'
import { runGenerateAdCopy } from './generateAdCopy'
import { runFinalizeImageContent } from './finalizeImageContent'
import type { ScriptGenerator, ScriptGenerationInput, ImageGenerator, ImagePollResult } from '../../adapters/types'
import type { PhotoStorageUploader } from '../../adapters/storage'

const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY

function makeMockScriptGenerator(opts: { failFirstNCalls?: number } = {}) {
  let calls = 0
  const failFirstNCalls = opts.failFirstNCalls ?? 0
  const generate = vi.fn(async () => {
    calls++
    if (calls <= failFirstNCalls) throw new Error('simulated transient OpenAI failure')
    return {
      raw: '{}',
      parsed: { caption: 'A great caption', hashtags: ['fresh', 'local'], alt_text: 'A photo of fresh produce' },
    }
  })
  return { generate } satisfies ScriptGenerator
}

function makeMockImageGenerator() {
  let counter = 0
  const submit = vi.fn(async () => ({ providerRef: `mock-${++counter}` }))
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
    return { providerRef: `mock-${++counter}` }
  })
  const poll = vi.fn(
    async (jobRef: { providerRef: string }): Promise<ImagePollResult> => ({
      status: 'ready',
      fileUrl: `https://example.com/${jobRef.providerRef}.png`,
    }),
  )
  return { submit, poll } satisfies ImageGenerator
}

function makeFakeUploader() {
  const upload = vi.fn(async (jobId: string, tempImageUrl: string) => {
    return `https://fake-storage.example.com/fc-image-posts/${jobId}-final.jpg?src=${encodeURIComponent(tempImageUrl)}`
  })
  return { upload } satisfies PhotoStorageUploader
}

describe.skipIf(!hasCreds)('Image pipeline end-to-end (real DB, mocked providers)', () => {
  let client: SupabaseClient
  const createdJobIds: string[] = []

  beforeAll(() => {
    client = createServiceClient()
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
        }
        await client.from('content_language_tracks').delete().eq('content_pipeline_id', p.id)
        await client.from('content_visual_assets').delete().eq('content_pipeline_id', p.id)
      }
      await client.from('generated_content').delete().eq('job_id', jobId).eq('content_type', 'image_post')
      await client.from('content_pipelines').delete().eq('job_id', jobId)
      await client.from('content_jobs').delete().eq('id', jobId)
    }
  })

  async function makeJobAndPipeline(languages: ('EN' | 'FR')[]) {
    const { data: job, error: jobErr } = await client
      .from('content_jobs')
      .insert({
        topic: 'E2E IMAGE TEST - DELETE ME',
        category: 'Community Impact',
        target_audience: 'General public',
        language: languages.length === 2 ? 'BOTH' : languages[0],
        content_types: ['image_post'],
        status: 'pending',
      })
      .select('id')
      .single()
    if (jobErr) throw jobErr
    createdJobIds.push(job.id)

    const { data: pipeline, error: pErr } = await client
      .from('content_pipelines')
      .insert({ job_id: job.id, content_type: 'image_post' })
      .select()
      .single()
    if (pErr) throw pErr

    const tracks: TrackRow[] = []
    for (const language of languages) {
      const { data: track, error: tErr } = await client
        .from('content_language_tracks')
        .insert({ content_pipeline_id: pipeline.id, language, master_generation_used: pipeline.current_generation })
        .select()
        .single()
      if (tErr) throw tErr
      tracks.push(track as TrackRow)
    }

    return { jobId: job.id, pipeline: pipeline as PipelineRow, tracks }
  }

  async function runSharedStep(pipeline: PipelineRow, image: ImageGenerator, uploader: PhotoStorageUploader) {
    await runGeneratePhoto(client, pipeline, 'a photo', image, uploader)
  }

  async function makeInfographicJobAndPipeline(languages: ('EN' | 'FR')[]) {
    const { data: job, error: jobErr } = await client
      .from('content_jobs')
      .insert({
        topic: 'E2E IMAGE TEST - DELETE ME',
        category: 'Community Impact',
        target_audience: 'General public',
        language: languages.length === 2 ? 'BOTH' : languages[0],
        content_types: ['image_post'],
        image_style: 'infographic',
        status: 'pending',
      })
      .select('id')
      .single()
    if (jobErr) throw jobErr
    createdJobIds.push(job.id)

    const { data: pipeline, error: pErr } = await client
      .from('content_pipelines')
      .insert({ job_id: job.id, content_type: 'image_post' })
      .select()
      .single()
    if (pErr) throw pErr

    const tracks: TrackRow[] = []
    for (const language of languages) {
      const { data: track, error: tErr } = await client
        .from('content_language_tracks')
        .insert({ content_pipeline_id: pipeline.id, language, master_generation_used: pipeline.current_generation })
        .select()
        .single()
      if (tErr) throw tErr
      tracks.push(track as TrackRow)
    }

    return { jobId: job.id, pipeline: pipeline as PipelineRow, tracks }
  }

  // Distinguishes generate_ad_copy's call from generate_caption's call by
  // the caller's own step_name (PROMPT_REFACTOR_BRIEF.md §13) — every real
  // .generate() call site now passes this, so dispatch no longer depends on
  // system-prompt wording that could get reworded and silently break routing.
  function makeAdCopyAwareScriptGenerator() {
    const generate = vi.fn(async (req: ScriptGenerationInput) => {
      if (req.stepName === 'generate_ad_copy') {
        return {
          raw: '{}',
          parsed: {
            headline: 'Fresh Food, Closer Than Ever',
            subtitle: 'Every neighbourhood deserves it',
            coreMessage: 'A family finds fresh, affordable produce close to home.',
          },
        }
      }
      return {
        raw: '{}',
        parsed: { caption: 'A great caption', hashtags: ['fresh', 'local'], alt_text: 'A photo of fresh produce' },
      }
    })
    return { generate } satisfies ScriptGenerator
  }

  async function runTrackSteps(pipeline: PipelineRow, track: TrackRow, jobId: string, script: ScriptGenerator) {
    await runGenerateCaption(client, track, { topic: 't', category: 'c' }, script)
    const { data: freshTrack } = await client.from('content_language_tracks').select('*').eq('id', track.id).single()
    const { data: freshPipeline } = await client.from('content_pipelines').select('*').eq('id', pipeline.id).single()
    await runFinalizeImageContent(
      client,
      freshPipeline as PipelineRow,
      freshTrack as TrackRow,
      jobId,
      { topic: 't', category: 'c' },
    )
  }

  it('EN-only: reaches draft_ready with a real generated_content row', async () => {
    const { jobId, pipeline, tracks } = await makeJobAndPipeline(['EN'])
    const script = makeMockScriptGenerator()
    const image = makeMockImageGenerator()
    const uploader = makeFakeUploader()

    await runSharedStep(pipeline, image, uploader)
    await runTrackSteps(pipeline, tracks[0], jobId, script)

    const { data: track } = await client.from('content_language_tracks').select('*').eq('id', tracks[0].id).single()
    expect(track.status).toBe('draft_ready')

    const { data: row } = await client
      .from('generated_content')
      .select('*')
      .eq('job_id', jobId)
      .eq('content_type', 'image_post')
      .eq('language', 'EN')
      .single()
    expect(row.caption).toBe('A great caption')
    expect(row.image_url).toContain('fake-storage.example.com')
    expect(row.status).toBe('completed')
  })

  it('caption prompt omits location guidance', async () => {
    const { tracks } = await makeJobAndPipeline(['EN'])
    const script = makeMockScriptGenerator()

    await runGenerateCaption(client, tracks[0], { topic: 't', category: 'c' }, script)

    const generateCall = (script.generate as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(generateCall.systemPrompt).not.toContain('locally relevant')
  })

  it('FR-only: caption generated in FR, no cross-contamination with EN prompt', async () => {
    const { jobId, pipeline, tracks } = await makeJobAndPipeline(['FR'])
    const script = makeMockScriptGenerator()
    const image = makeMockImageGenerator()
    const uploader = makeFakeUploader()

    await runSharedStep(pipeline, image, uploader)
    await runTrackSteps(pipeline, tracks[0], jobId, script)

    const generateCall = (script.generate as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(generateCall.systemPrompt).toContain('in FR')

    const { data: row } = await client
      .from('generated_content')
      .select('language, status')
      .eq('job_id', jobId)
      .eq('content_type', 'image_post')
      .eq('language', 'FR')
      .single()
    expect(row!.language).toBe('FR')
    expect(row!.status).toBe('completed')
  })

  it('BOTH: two independent tracks share the identical photo URL, never a literal BOTH value or concatenated captions', async () => {
    const { jobId, pipeline, tracks } = await makeJobAndPipeline(['EN', 'FR'])
    expect(tracks).toHaveLength(2)
    expect(tracks.map((t) => t.language).sort()).toEqual(['EN', 'FR'])

    const script = makeMockScriptGenerator()
    const image = makeMockImageGenerator()
    const uploader = makeFakeUploader()

    await runSharedStep(pipeline, image, uploader)
    for (const track of tracks) await runTrackSteps(pipeline, track, jobId, script)

    const { data: rows } = await client
      .from('generated_content')
      .select('*')
      .eq('job_id', jobId)
      .eq('content_type', 'image_post')
    expect(rows).toHaveLength(2)
    expect(rows!.map((r) => r.language).sort()).toEqual(['EN', 'FR'])
    // never the old bug's literal 'BOTH' value on either row
    expect(rows!.every((r) => r.language !== 'BOTH')).toBe(true)
    // each caption is the clean per-language string, never concatenated
    expect(rows!.every((r) => r.caption === 'A great caption')).toBe(true)
    // both tracks reference the exact same shared photo — one KIE.ai call, not two
    const urls = new Set(rows!.map((r) => r.image_url))
    expect(urls.size).toBe(1)
    expect(image.submit).toHaveBeenCalledTimes(1)
  })

  it('one language failing does not block or corrupt the other', async () => {
    const { jobId, pipeline, tracks } = await makeJobAndPipeline(['EN', 'FR'])
    const enTrack = tracks.find((t) => t.language === 'EN')!
    const frTrack = tracks.find((t) => t.language === 'FR')!

    const image = makeMockImageGenerator()
    const uploader = makeFakeUploader()
    await runSharedStep(pipeline, image, uploader)

    // EN's script generator always fails; FR's always succeeds
    const failingScript = { generate: vi.fn(async () => { throw new Error('EN caption provider down') }) } satisfies ScriptGenerator
    const workingScript = makeMockScriptGenerator()

    await runGenerateCaption(client, enTrack, { topic: 't', category: 'c' }, failingScript)
    await runTrackSteps(pipeline, frTrack, jobId, workingScript)

    const { data: enFresh } = await client.from('content_language_tracks').select('*').eq('id', enTrack.id).single()
    expect(enFresh.status).toBe('generating') // still retrying, not failed_terminal yet
    expect(enFresh.last_error).toContain('EN caption provider down')

    const { data: frRow } = await client
      .from('generated_content')
      .select('status, caption')
      .eq('job_id', jobId)
      .eq('content_type', 'image_post')
      .eq('language', 'FR')
      .single()
    expect(frRow!.status).toBe('completed')
    expect(frRow!.caption).toBe('A great caption')
  })

  it('photo generation retries after a transient failure and eventually succeeds', async () => {
    const { jobId, pipeline, tracks } = await makeJobAndPipeline(['EN'])
    const flakyImage = makeFlakyImageGenerator(1)
    const uploader = makeFakeUploader()

    await runSharedStep(pipeline, flakyImage, uploader) // attempt 1: fails
    const { data: p1 } = await client.from('content_pipelines').select('*').eq('id', pipeline.id).single()
    expect(p1.status).toBe('generating') // still generating, not failed — one attempt left of MAX_ATTEMPTS.kie

    // backoffBaseDelayMs=0 so the retry-eligibility check (isReadyToRetry)
    // is satisfied immediately instead of racing real elapsed wall-clock
    // time against the real backoff window — the exact flakiness class
    // blogPipeline.e2e.test.ts's own retry test already avoids this way.
    await runGeneratePhoto(client, p1 as PipelineRow, 'a photo', flakyImage, uploader, 0) // attempt 2: succeeds
    const { data: p2 } = await client.from('content_pipelines').select('*').eq('id', pipeline.id).single()
    expect(p2.status).toBe('ready')
    expect(flakyImage.submit).toHaveBeenCalledTimes(2)

    const script = makeMockScriptGenerator()
    await runTrackSteps(p2 as PipelineRow, tracks[0], jobId, script)
    const { data: row } = await client
      .from('generated_content')
      .select('status')
      .eq('job_id', jobId)
      .eq('content_type', 'image_post')
      .single()
    expect(row!.status).toBe('completed')
  })

  it('re-running finalize after it already succeeded does not call any provider again', async () => {
    const { jobId, pipeline, tracks } = await makeJobAndPipeline(['EN'])
    const script = makeMockScriptGenerator()
    const image = makeMockImageGenerator()
    const uploader = makeFakeUploader()

    await runSharedStep(pipeline, image, uploader)
    await runTrackSteps(pipeline, tracks[0], jobId, script)
    await runTrackSteps(pipeline, tracks[0], jobId, script) // second pass — should be a no-op

    expect(script.generate).toHaveBeenCalledTimes(1)
    expect(image.submit).toHaveBeenCalledTimes(1)
    expect(uploader.upload).toHaveBeenCalledTimes(1)
  })

  describe("'infographic' style: on-image headline/subtitle and the caption stay cohesive", () => {
    it('generate_caption waits (ran: false) until generate_ad_copy has succeeded', async () => {
      const { tracks } = await makeInfographicJobAndPipeline(['EN'])
      const script = makeAdCopyAwareScriptGenerator()

      const result = await runGenerateCaption(client, tracks[0], {
        topic: 't',
        category: 'c',
        imageStyle: 'infographic',
        pipelineGeneration: 1,
      }, script)

      expect(result.ran).toBe(false)
      expect(script.generate).not.toHaveBeenCalled()
      const { data: track } = await client.from('content_language_tracks').select('*').eq('id', tracks[0].id).single()
      expect(track.status).toBe('waiting_on_shared') // never claimed — nothing to do until ad copy exists
    })

    it('once generate_ad_copy succeeds, the caption prompt is told the exact headline/subtitle/coreMessage', async () => {
      const { pipeline, tracks } = await makeInfographicJobAndPipeline(['EN'])
      const script = makeAdCopyAwareScriptGenerator()

      await runGenerateAdCopy(client, pipeline, { topic: 't', category: 'c' }, script)
      const { data: freshPipeline } = await client.from('content_pipelines').select('*').eq('id', pipeline.id).single()
      expect(freshPipeline.status).toBe('generating') // created -> drafting -> generating, mirrors generate_outline

      const result = await runGenerateCaption(client, tracks[0], {
        topic: 't',
        category: 'c',
        imageStyle: 'infographic',
        pipelineGeneration: freshPipeline.current_generation,
      }, script)
      expect(result.ran).toBe(true)

      const captionCall = (script.generate as ReturnType<typeof vi.fn>).mock.calls.find(
        (c) => c[0].stepName === 'generate_caption',
      )!
      expect(captionCall[0].systemPrompt).toContain('Fresh Food, Closer Than Ever')
      expect(captionCall[0].systemPrompt).toContain('Every neighbourhood deserves it')
      expect(captionCall[0].systemPrompt).toContain('A family finds fresh, affordable produce close to home.')
    })

    it('re-running generate_ad_copy after success does not call the provider again', async () => {
      const { pipeline } = await makeInfographicJobAndPipeline(['EN'])
      const script = makeAdCopyAwareScriptGenerator()

      await runGenerateAdCopy(client, pipeline, { topic: 't', category: 'c' }, script)
      const { data: freshPipeline } = await client.from('content_pipelines').select('*').eq('id', pipeline.id).single()
      await runGenerateAdCopy(client, freshPipeline as PipelineRow, { topic: 't', category: 'c' }, script)

      expect(script.generate).toHaveBeenCalledTimes(1)
    })

    it('finalize writes headline_text/subtitle_text so the dashboard headline card is populated', async () => {
      const { jobId, pipeline, tracks } = await makeInfographicJobAndPipeline(['EN'])
      const script = makeAdCopyAwareScriptGenerator()
      const image = makeMockImageGenerator()
      const uploader = makeFakeUploader()

      await runGenerateAdCopy(client, pipeline, { topic: 't', category: 'c' }, script)
      const { data: p1 } = await client.from('content_pipelines').select('*').eq('id', pipeline.id).single()
      await runSharedStep(p1 as PipelineRow, image, uploader)
      const { data: p2 } = await client.from('content_pipelines').select('*').eq('id', pipeline.id).single()

      await runGenerateCaption(client, tracks[0], {
        topic: 't',
        category: 'c',
        imageStyle: 'infographic',
        pipelineGeneration: p2.current_generation,
      }, script)
      const { data: freshTrack } = await client.from('content_language_tracks').select('*').eq('id', tracks[0].id).single()
      await runFinalizeImageContent(client, p2 as PipelineRow, freshTrack as TrackRow, jobId, {
        topic: 't',
        category: 'c',
        imageStyle: 'infographic',
      })

      const { data: row } = await client
        .from('generated_content')
        .select('output_data')
        .eq('job_id', jobId)
        .eq('content_type', 'image_post')
        .eq('language', 'EN')
        .single()
      expect(row!.output_data.headline_text).toBe('Fresh Food, Closer Than Ever')
      expect(row!.output_data.subtitle_text).toBe('Every neighbourhood deserves it')
    })
  })
})
