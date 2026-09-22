// End-to-end test of the full Blog worker flow — REAL database (live
// Supabase, self-cleaning throwaway rows), MOCKED provider adapters (no
// OPENAI_API_KEY/KIE.ai key available in this environment). This is the
// test that actually proves the architecture's core claims:
//   - EN-only, FR-only, and BOTH all work through the same step handlers
//   - BOTH's two tracks share the identical hero/inline image URLs
//   - one language failing never corrupts or blocks the other
//   - provider failures retry and eventually succeed
//   - re-running a step that already succeeded does not call the provider again
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceClient, claimPipeline, type PipelineRow, type TrackRow } from '../../db'
import { runGenerateOutline } from './generateOutline'
import { runGenerateVisualImage } from './generateVisualImage'
import { runGenerateCopy } from './generateCopy'
import { runFinalizeDraft } from './finalizeDraft'
import type { ScriptGenerator, ScriptGenerationInput, ImageGenerator, ImagePollResult } from '../../adapters/types'

const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY

function makeMockScriptGenerator(opts: { failFirstNCalls?: number } = {}) {
  let calls = 0
  const failFirstNCalls = opts.failFirstNCalls ?? 0
  const generate = vi.fn(async (input: ScriptGenerationInput) => {
    calls++
    if (calls <= failFirstNCalls) throw new Error('simulated transient OpenAI failure')
    // Dispatch by the caller's own step_name (PROMPT_REFACTOR_BRIEF.md §13)
    // — every real .generate() call site now passes this. Replaces sniffing
    // a phrase from the system prompt's wording, which broke silently every
    // time a phase in the prompt refactor reworded a prompt.
    if (input.stepName === 'generate_outline') {
      return { raw: '{}', parsed: { title: 'Outline', sections: [{ heading: 'A', summary: 'a' }, { heading: 'B', summary: 'b' }] } }
    }
    return {
      raw: '{}',
      parsed: {
        post_title: 'A Great Blog Post',
        post_slug: 'a-great-blog-post',
        content: { introduction: 'Intro', sections: [], conclusion: 'End', cta: {} },
        seo: { title: 'A Great Blog Post', meta_description: 'desc' },
      },
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

describe.skipIf(!hasCreds)('Blog pipeline end-to-end (real DB, mocked providers)', () => {
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
        await client.from('content_drafts').delete().eq('job_id', jobId).eq('content_type', 'blog')
        await client.from('content_language_tracks').delete().eq('content_pipeline_id', p.id)
        await client.from('content_visual_assets').delete().eq('content_pipeline_id', p.id)
      }
      await client.from('content_pipelines').delete().eq('job_id', jobId)
      await client.from('content_jobs').delete().eq('id', jobId)
    }
  })

  async function makeJobAndPipeline(languages: ('EN' | 'FR')[]) {
    const { data: job, error: jobErr } = await client
      .from('content_jobs')
      .insert({
        topic: 'E2E BLOG TEST - DELETE ME',
        category: 'Community Impact',
        target_audience: 'General public',
        language: languages.length === 2 ? 'BOTH' : languages[0],
        content_types: ['blog'],
        status: 'pending',
      })
      .select('id')
      .single()
    if (jobErr) throw jobErr
    createdJobIds.push(job.id)

    const { data: pipeline, error: pErr } = await client
      .from('content_pipelines')
      .insert({ job_id: job.id, content_type: 'blog' })
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

  async function runSharedSteps(pipeline: PipelineRow, script: ScriptGenerator, image: ImageGenerator) {
    await runGenerateOutline(
      client,
      pipeline,
      { topic: 't', category: 'c', targetAudience: 'a' },
      script,
    )
    await runGenerateVisualImage(client, pipeline, 'hero_image', 'a hero image', image)
    await runGenerateVisualImage(client, pipeline, 'inline_image', 'an inline image', image)
  }

  async function runTrackSteps(
    pipeline: PipelineRow,
    track: TrackRow,
    jobId: string,
    script: ScriptGenerator,
  ) {
    await runGenerateCopy(client, track, pipeline.id, pipeline.current_generation, { topic: 't', category: 'c' }, script)
    const { data: freshTrack } = await client.from('content_language_tracks').select('*').eq('id', track.id).single()
    const { data: freshPipeline } = await client.from('content_pipelines').select('*').eq('id', pipeline.id).single()
    await runFinalizeDraft(client, freshPipeline as PipelineRow, freshTrack as TrackRow, jobId)
  }

  it('EN-only: reaches draft_ready with a real content_drafts row', async () => {
    const { jobId, pipeline, tracks } = await makeJobAndPipeline(['EN'])
    const script = makeMockScriptGenerator()
    const image = makeMockImageGenerator()

    await runSharedSteps(pipeline, script, image)
    await runTrackSteps(pipeline, tracks[0], jobId, script)

    const { data: track } = await client.from('content_language_tracks').select('*').eq('id', tracks[0].id).single()
    expect(track.status).toBe('draft_ready')

    const { data: draft } = await client.from('content_drafts').select('*').eq('content_language_track_id', tracks[0].id).single()
    expect(draft.draft_data.post_title).toBe('A Great Blog Post')
    expect(draft.language).toBe('EN')
  })

  it('BOTH: creates two independent tracks, never a literal BOTH value on either track', async () => {
    const { jobId, pipeline, tracks } = await makeJobAndPipeline(['EN', 'FR'])
    expect(tracks).toHaveLength(2)
    expect(tracks.map((t) => t.language).sort()).toEqual(['EN', 'FR'])

    const script = makeMockScriptGenerator()
    const image = makeMockImageGenerator()
    await runSharedSteps(pipeline, script, image)
    for (const track of tracks) await runTrackSteps(pipeline, track, jobId, script)

    const { data: allTracks } = await client.from('content_language_tracks').select('*').eq('content_pipeline_id', pipeline.id)
    expect(allTracks!.every((t: TrackRow) => t.status === 'draft_ready')).toBe(true)
    expect(allTracks!.every((t: TrackRow) => (t.language as string) !== 'BOTH')).toBe(true)

    const { data: drafts } = await client.from('content_drafts').select('language').eq('job_id', jobId)
    expect(drafts!.map((d: { language: string }) => d.language).sort()).toEqual(['EN', 'FR'])
  })

  it('BOTH: both language tracks reference the IDENTICAL shared hero/inline image URLs', async () => {
    const { jobId, pipeline, tracks } = await makeJobAndPipeline(['EN', 'FR'])
    const script = makeMockScriptGenerator()
    const image = makeMockImageGenerator()
    await runSharedSteps(pipeline, script, image)
    for (const track of tracks) await runTrackSteps(pipeline, track, jobId, script)

    // hero/inline generation only ran ONCE each, not once per language
    expect(image.submit).toHaveBeenCalledTimes(2) // one hero + one inline, total, not per-track

    const { data: drafts } = await client
      .from('content_drafts')
      .select('language, draft_data')
      .eq('job_id', jobId)
    const en = drafts!.find((d: { language: string }) => d.language === 'EN')!
    const fr = drafts!.find((d: { language: string }) => d.language === 'FR')!
    expect(en.draft_data.images.hero.url).toBe(fr.draft_data.images.hero.url)
    expect(en.draft_data.images.inline.url).toBe(fr.draft_data.images.inline.url)
  })

  it('visual image retry: hero failing once and retrying does not inflate inline\'s attempt count', async () => {
    const { pipeline } = await makeJobAndPipeline(['EN'])
    const script = makeMockScriptGenerator()
    await runGenerateOutline(client, pipeline, { topic: 't', category: 'c', targetAudience: 'a' }, script)
    const { data: pAfterOutline } = await client.from('content_pipelines').select('*').eq('id', pipeline.id).single()

    const flakyImage = makeFlakyImageGenerator(1) // fails once, succeeds on 2nd submit
    const goodImage = makeMockImageGenerator()

    // hero: first attempt fails
    await runGenerateVisualImage(client, pAfterOutline as PipelineRow, 'hero_image', 'hero', flakyImage, 0)
    const { data: heroAfterFail } = await client
      .from('content_visual_assets')
      .select('*')
      .eq('content_pipeline_id', pipeline.id)
      .eq('asset_type', 'hero_image')
      .single()
    expect(heroAfterFail.status).toBe('failed')
    expect(heroAfterFail.attempt_number).toBe(1)

    // inline: succeeds on its first (and only) attempt — independent counter, unaffected by hero's failure
    await runGenerateVisualImage(client, pAfterOutline as PipelineRow, 'inline_image', 'inline', goodImage, 0)
    const { data: inlineAfterSuccess } = await client
      .from('content_visual_assets')
      .select('*')
      .eq('content_pipeline_id', pipeline.id)
      .eq('asset_type', 'inline_image')
      .single()
    expect(inlineAfterSuccess.status).toBe('ready')
    expect(inlineAfterSuccess.attempt_number).toBe(1) // NOT inflated by hero's failed attempt

    // hero: retry (backoffBaseDelayMs=0) — succeeds this time
    await runGenerateVisualImage(client, pAfterOutline as PipelineRow, 'hero_image', 'hero', flakyImage, 0)
    const { data: heroAfterRetry } = await client
      .from('content_visual_assets')
      .select('*')
      .eq('content_pipeline_id', pipeline.id)
      .eq('asset_type', 'hero_image')
      .single()
    expect(heroAfterRetry.status).toBe('ready')
    expect(heroAfterRetry.attempt_number).toBe(2)

    // both ready now — pipeline should have advanced via the fan-in
    const { data: pFinal } = await client.from('content_pipelines').select('*').eq('id', pipeline.id).single()
    expect(pFinal.status).toBe('ready')
  })

  it('one language failing does not block or corrupt the other', async () => {
    const { jobId, pipeline, tracks } = await makeJobAndPipeline(['EN', 'FR'])
    const enTrack = tracks.find((t) => t.language === 'EN')!
    const frTrack = tracks.find((t) => t.language === 'FR')!

    const image = makeMockImageGenerator()
    const outlineScript = makeMockScriptGenerator()
    await runSharedSteps(pipeline, outlineScript, image)

    // EN succeeds normally
    await runTrackSteps(pipeline, enTrack, jobId, makeMockScriptGenerator())

    // FR's copy generation always fails (simulate exhausting all retries)
    const alwaysFailScript: ScriptGenerator = {
      generate: vi.fn(async () => {
        throw new Error('simulated permanent OpenAI failure')
      }),
    }
    // Re-fetch between attempts (as the real worker's polling loop would —
    // it always re-reads current state before each tick) and use
    // backoffBaseDelayMs=0 so each retry is immediately eligible instead of
    // waiting out the production backoff window.
    let currentFrTrack = frTrack
    for (let i = 0; i < 3; i++) {
      await runGenerateCopy(
        client,
        currentFrTrack,
        pipeline.id,
        pipeline.current_generation,
        { topic: 't', category: 'c' },
        alwaysFailScript,
        0,
      )
      const { data } = await client.from('content_language_tracks').select('*').eq('id', frTrack.id).single()
      currentFrTrack = data as TrackRow
    }

    const { data: enFinal } = await client.from('content_language_tracks').select('*').eq('id', enTrack.id).single()
    const { data: frFinal } = await client.from('content_language_tracks').select('*').eq('id', frTrack.id).single()

    expect(enFinal.status).toBe('draft_ready') // untouched by FR's failure
    expect(frFinal.status).toBe('failed')
    expect(frFinal.last_error).toContain('simulated permanent OpenAI failure')

    // EN's draft exists and is unaffected
    const { data: enDraft } = await client.from('content_drafts').select('*').eq('content_language_track_id', enTrack.id).single()
    expect(enDraft.draft_data.post_title).toBe('A Great Blog Post')
  }, 40_000)

  it('provider failure then success: retries and eventually succeeds, recording both attempts', async () => {
    const { pipeline } = await makeJobAndPipeline(['EN'])
    const flakyScript = makeMockScriptGenerator({ failFirstNCalls: 1 })
    const input = { topic: 't', keywords: 'k', category: 'c', targetAudience: 'a' }

    await runGenerateOutline(client, pipeline, input, flakyScript)
    const { data: pAfterFail } = await client.from('content_pipelines').select('*').eq('id', pipeline.id).single()
    expect(pAfterFail.status).toBe('drafting') // still stuck, first attempt failed
    expect(pAfterFail.retry_count).toBe(1)

    // second call: re-fetch the real row (as the worker's polling loop
    // would) and pass backoffBaseDelayMs=0 so the retry-eligibility check
    // doesn't require actually waiting out the production backoff window
    await runGenerateOutline(client, pAfterFail as PipelineRow, input, flakyScript, 0)
    const { data: pAfterRetry } = await client.from('content_pipelines').select('*').eq('id', pipeline.id).single()
    expect(pAfterRetry.status).toBe('generating') // advanced past drafting on success

    const { count } = await client
      .from('pipeline_steps')
      .select('id', { count: 'exact', head: true })
      .eq('content_pipeline_id', pipeline.id)
      .eq('step_name', 'generate_outline')
    expect(count).toBe(2) // one failed_retryable, one succeeded — full attempt history preserved
  }, 20_000)

  it('idempotency: calling generate_outline again after success does not call the provider a second time', async () => {
    const { pipeline } = await makeJobAndPipeline(['EN'])
    const script = makeMockScriptGenerator()

    await runGenerateOutline(client, pipeline, { topic: 't', category: 'c', targetAudience: 'a' }, script)
    expect(script.generate).toHaveBeenCalledTimes(1)

    // simulate a duplicate/retried call — claim will fail (already past 'created'), so this is a no-op
    const result = await runGenerateOutline(client, pipeline, { topic: 't', category: 'c', targetAudience: 'a' }, script)
    expect(result.ran).toBe(false)
    expect(script.generate).toHaveBeenCalledTimes(1) // still just once
  })

  it('claimPipeline (worker crash/recovery simulation): a second worker instance racing the same claim loses', async () => {
    const { pipeline } = await makeJobAndPipeline(['EN'])
    const [a, b] = await Promise.all([
      claimPipeline(client, pipeline.id, 'created', 'drafting'),
      claimPipeline(client, pipeline.id, 'created', 'drafting'),
    ])
    const winners = [a, b].filter((r) => r !== null)
    expect(winners).toHaveLength(1) // exactly one of the two "workers" won the race
  })
})
