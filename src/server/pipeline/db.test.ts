// Live integration tests — run against the real Supabase project configured
// in the root .env.local. Skipped automatically if SUPABASE_SERVICE_ROLE_KEY
// isn't available (e.g. CI without secrets), per AGENTS.md's testing rule:
// never claim a DB-dependent test "passed" when it only skipped. Every test
// creates its own throwaway content_jobs row and cleans up in afterEach —
// there is no separate test/staging database, per your instruction, so this
// runs against the same project the app uses, scoped to obviously-tagged
// rows only.
import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  createServiceClient,
  claimPipeline,
  claimTrack,
  hasSucceededStep,
  getLastSucceededStepOutput,
  getLastSucceededStepOutputAnyGeneration,
  recordStepAttempt,
  upsertVisualAsset,
  getVisualAssets,
  upsertBlogDraft,
  getGeneratedContentFileUrl,
  markJobDraftReadyIfPending,
  markJobReadyIfAllContentComplete,
} from './db'

// db.ts imports env.ts, which loads the root .env.local as an import-time
// side effect — by the time this line runs, process.env is already
// populated if a real .env.local exists.
const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY

describe.skipIf(!hasCreds)('db.ts (live integration)', () => {
  let client: SupabaseClient
  const createdJobIds: string[] = []

  beforeAll(() => {
    client = createServiceClient()
  })

  afterEach(async () => {
    // cascade cleanup: tracks/visual-assets/steps/drafts reference the
    // pipeline which references the job; deleting the job's pipelines'
    // children first, then the pipeline, then the job.
    for (const jobId of createdJobIds.splice(0)) {
      const { data: pipelines } = await client
        .from('content_pipelines')
        .select('id')
        .eq('job_id', jobId)
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
      await client.from('generated_content').delete().eq('job_id', jobId)
      await client.from('content_pipelines').delete().eq('job_id', jobId)
      await client.from('content_jobs').delete().eq('id', jobId)
    }
  })

  async function makeJob(): Promise<string> {
    const { data, error } = await client
      .from('content_jobs')
      .insert({
        topic: 'WORKER DB TEST - DELETE ME',
        category: 'Community Impact',
        target_audience: 'General public',
        language: 'EN',
        content_types: ['blog'],
        status: 'pending',
      })
      .select('id')
      .single()
    if (error) throw error
    createdJobIds.push(data.id)
    return data.id
  }

  async function makePipeline(jobId: string) {
    const { data, error } = await client
      .from('content_pipelines')
      .insert({ job_id: jobId, content_type: 'blog' })
      .select()
      .single()
    if (error) throw error
    return data
  }

  it('claimPipeline succeeds when the row is in fromStatus, and fails (returns null) if already claimed', async () => {
    const jobId = await makeJob()
    const pipeline = await makePipeline(jobId)

    const claimed = await claimPipeline(client, pipeline.id, 'created', 'drafting')
    expect(claimed?.status).toBe('drafting')

    // second claim attempt against the now-stale fromStatus must lose the race
    const secondAttempt = await claimPipeline(client, pipeline.id, 'created', 'drafting')
    expect(secondAttempt).toBeNull()
  })

  it('claimTrack works the same way, scoped to one track', async () => {
    const jobId = await makeJob()
    const pipeline = await makePipeline(jobId)
    const { data: track, error } = await client
      .from('content_language_tracks')
      .insert({ content_pipeline_id: pipeline.id, language: 'EN', master_generation_used: 1 })
      .select()
      .single()
    if (error) throw error

    const claimed = await claimTrack(client, track.id, 'waiting_on_shared', 'generating')
    expect(claimed?.status).toBe('generating')

    const secondAttempt = await claimTrack(client, track.id, 'waiting_on_shared', 'generating')
    expect(secondAttempt).toBeNull()
  })

  it('hasSucceededStep is false before an attempt, true after recordStepAttempt(succeeded)', async () => {
    const jobId = await makeJob()
    const pipeline = await makePipeline(jobId)

    expect(await hasSucceededStep(client, { contentPipelineId: pipeline.id }, 'generate_outline', 1)).toBe(
      false,
    )

    await recordStepAttempt(client, {
      contentPipelineId: pipeline.id,
      stepName: 'generate_outline',
      generation: 1,
      attemptNumber: 1,
      status: 'succeeded',
      provider: 'openai',
      outputSnapshot: { outline: 'test outline' },
    })

    expect(await hasSucceededStep(client, { contentPipelineId: pipeline.id }, 'generate_outline', 1)).toBe(
      true,
    )
  })

  it('getLastSucceededStepOutput returns the most recent succeeded attempt\'s output', async () => {
    const jobId = await makeJob()
    const pipeline = await makePipeline(jobId)

    await recordStepAttempt(client, {
      contentPipelineId: pipeline.id,
      stepName: 'generate_outline',
      generation: 1,
      attemptNumber: 1,
      status: 'failed_retryable',
      errorMessage: 'transient',
    })
    await recordStepAttempt(client, {
      contentPipelineId: pipeline.id,
      stepName: 'generate_outline',
      generation: 1,
      attemptNumber: 2,
      status: 'succeeded',
      outputSnapshot: { outline: 'the real outline' },
    })

    const output = await getLastSucceededStepOutput(
      client,
      { contentPipelineId: pipeline.id },
      'generate_outline',
      1,
    )
    expect(output).toEqual({ outline: 'the real outline' })
  })

  it('getLastSucceededStepOutputAnyGeneration finds a step\'s output even when the pipeline has since moved to a later generation', async () => {
    // Reproduces the exact blog visual-regen bug: generate_outline succeeds
    // once at generation 1 and never runs again, but a visual-only regen
    // (blog/regenerate/route.ts) bumps content_pipelines.current_generation
    // to 2+ without touching outline at all. Looking outline up by the
    // pipeline's CURRENT generation (getLastSucceededStepOutput) would find
    // nothing; the "any generation" variant must still find it.
    const jobId = await makeJob()
    const pipeline = await makePipeline(jobId)

    await recordStepAttempt(client, {
      contentPipelineId: pipeline.id,
      stepName: 'generate_outline',
      generation: 1,
      attemptNumber: 1,
      status: 'succeeded',
      outputSnapshot: { headline: 'Real Headline', subtitle: 'Real Subtitle' },
    })

    // Simulate a visual regen having bumped the pipeline's generation.
    await client.from('content_pipelines').update({ current_generation: 3 }).eq('id', pipeline.id)

    const exact = await getLastSucceededStepOutput(
      client,
      { contentPipelineId: pipeline.id },
      'generate_outline',
      3,
    )
    expect(exact).toBeNull() // demonstrates the bug this test guards against

    const anyGen = await getLastSucceededStepOutputAnyGeneration(
      client,
      { contentPipelineId: pipeline.id },
      'generate_outline',
    )
    expect(anyGen).toEqual({ headline: 'Real Headline', subtitle: 'Real Subtitle' })
  })

  it('upsertVisualAsset creates one row per asset_type per generation, and re-calling with the same asset_type updates rather than duplicates', async () => {
    const jobId = await makeJob()
    const pipeline = await makePipeline(jobId)

    await upsertVisualAsset(client, {
      contentPipelineId: pipeline.id,
      generation: 1,
      assetType: 'hero_image',
      status: 'ready',
      fileUrl: 'https://example.com/hero.png',
    })
    await upsertVisualAsset(client, {
      contentPipelineId: pipeline.id,
      generation: 1,
      assetType: 'inline_image',
      status: 'ready',
      fileUrl: 'https://example.com/inline.png',
    })
    // re-upsert hero — should UPDATE the existing row, not add a second one
    await upsertVisualAsset(client, {
      contentPipelineId: pipeline.id,
      generation: 1,
      assetType: 'hero_image',
      status: 'ready',
      fileUrl: 'https://example.com/hero-v2.png',
    })

    const assets = await getVisualAssets(client, pipeline.id, 1)
    expect(assets).toHaveLength(2)
    const hero = assets.find((a) => a.asset_type === 'hero_image')
    expect(hero?.file_url).toBe('https://example.com/hero-v2.png')
  })

  it('upsertBlogDraft writes a content_drafts row addressable by content_language_track_id', async () => {
    const jobId = await makeJob()
    const pipeline = await makePipeline(jobId)
    const { data: track } = await client
      .from('content_language_tracks')
      .insert({ content_pipeline_id: pipeline.id, language: 'EN', master_generation_used: 1 })
      .select()
      .single()

    await upsertBlogDraft(client, {
      jobId,
      language: 'EN',
      contentLanguageTrackId: track!.id,
      draftData: { post_title: 'Test Post' },
    })

    const { data: draft } = await client
      .from('content_drafts')
      .select('*')
      .eq('content_language_track_id', track!.id)
      .single()
    expect(draft?.draft_data).toEqual({ post_title: 'Test Post' })
    expect(draft?.job_id).toBe(jobId)
  })

  // Regression coverage for the 2026-09-17 fix: pre-migration, n8n-era
  // image_post rows only ever populated `image_url`, never `file_url` — any
  // such job approved for social posting failed with "nothing to post"
  // despite a real, displayable image existing. getGeneratedContentFileUrl
  // must fall back to image_url, matching contentService.ts's
  // getImageLibrary, which already had this same fallback.
  it('getGeneratedContentFileUrl falls back to image_url when file_url is null (legacy image_post rows)', async () => {
    const jobId = await makeJob()
    const { error } = await client.from('generated_content').insert({
      job_id: jobId,
      content_type: 'image_post',
      language: 'EN',
      status: 'completed',
      file_url: null,
      image_url: 'https://example.com/legacy-image-post.jpg',
    })
    if (error) throw error

    const url = await getGeneratedContentFileUrl(client, jobId, 'image_post', 'EN')
    expect(url).toBe('https://example.com/legacy-image-post.jpg')
  })

  it('getGeneratedContentFileUrl prefers file_url over image_url when both are present', async () => {
    const jobId = await makeJob()
    const { error } = await client.from('generated_content').insert({
      job_id: jobId,
      content_type: 'image_post',
      language: 'EN',
      status: 'completed',
      file_url: 'https://example.com/current-worker-file.jpg',
      image_url: 'https://example.com/also-present.jpg',
    })
    if (error) throw error

    const url = await getGeneratedContentFileUrl(client, jobId, 'image_post', 'EN')
    expect(url).toBe('https://example.com/current-worker-file.jpg')
  })

  it('getGeneratedContentFileUrl returns null when neither column is set', async () => {
    const jobId = await makeJob()
    const { error } = await client.from('generated_content').insert({
      job_id: jobId,
      content_type: 'image_post',
      language: 'EN',
      status: 'completed',
    })
    if (error) throw error

    const url = await getGeneratedContentFileUrl(client, jobId, 'image_post', 'EN')
    expect(url).toBeNull()
  })

  it('getGeneratedContentFileUrl is scoped to the requested language — a BOTH job\'s EN and FR rows are independently postable', async () => {
    const jobId = await makeJob()
    const { error } = await client.from('generated_content').insert([
      {
        job_id: jobId,
        content_type: 'image_post',
        language: 'EN',
        status: 'completed',
        file_url: 'https://example.com/en.jpg',
      },
      {
        job_id: jobId,
        content_type: 'image_post',
        language: 'FR',
        status: 'completed',
        file_url: 'https://example.com/fr.jpg',
      },
    ])
    if (error) throw error

    expect(await getGeneratedContentFileUrl(client, jobId, 'image_post', 'EN')).toBe('https://example.com/en.jpg')
    expect(await getGeneratedContentFileUrl(client, jobId, 'image_post', 'FR')).toBe('https://example.com/fr.jpg')
  })

  describe('markJobDraftReadyIfPending', () => {
    it('moves a pending job to draft_ready', async () => {
      const jobId = await makeJob()
      await markJobDraftReadyIfPending(client, jobId)
      const { data } = await client.from('content_jobs').select('status').eq('id', jobId).single()
      expect(data?.status).toBe('draft_ready')
    })

    it('never overwrites a job already past pending', async () => {
      const jobId = await makeJob()
      await client.from('content_jobs').update({ status: 'ready' }).eq('id', jobId)
      await markJobDraftReadyIfPending(client, jobId)
      const { data } = await client.from('content_jobs').select('status').eq('id', jobId).single()
      expect(data?.status).toBe('ready')
    })
  })

  describe('markJobReadyIfAllContentComplete', () => {
    it('advances to ready once every requested content_type has a generated_content row', async () => {
      const jobId = await makeJob() // content_types: ['blog']
      await client.from('generated_content').insert({ job_id: jobId, content_type: 'blog', status: 'completed' })
      await markJobReadyIfAllContentComplete(client, jobId)
      const { data } = await client.from('content_jobs').select('status').eq('id', jobId).single()
      expect(data?.status).toBe('ready')
    })

    it('does not advance until EVERY requested content_type has a row (multi-type job)', async () => {
      const { data: job, error } = await client
        .from('content_jobs')
        .insert({
          topic: 'WORKER DB TEST - DELETE ME',
          category: 'Community Impact',
          target_audience: 'General public',
          language: 'EN',
          content_types: ['blog', 'image_post'],
          status: 'draft_ready',
        })
        .select('id')
        .single()
      if (error) throw error
      createdJobIds.push(job.id)

      // Only blog has a row so far — image_post is still missing.
      await client.from('generated_content').insert({ job_id: job.id, content_type: 'blog', status: 'completed' })
      await markJobReadyIfAllContentComplete(client, job.id)
      let { data } = await client.from('content_jobs').select('status').eq('id', job.id).single()
      expect(data?.status).toBe('draft_ready')

      // Now image_post's row arrives too — both requested types are done.
      await client.from('generated_content').insert({ job_id: job.id, content_type: 'image_post', status: 'completed' })
      await markJobReadyIfAllContentComplete(client, job.id)
      ;({ data } = await client.from('content_jobs').select('status').eq('id', job.id).single())
      expect(data?.status).toBe('ready')
    })

    it('never overwrites a job already at a terminal status', async () => {
      const jobId = await makeJob()
      await client.from('content_jobs').update({ status: 'failed' }).eq('id', jobId)
      await client.from('generated_content').insert({ job_id: jobId, content_type: 'blog', status: 'completed' })
      await markJobReadyIfAllContentComplete(client, jobId)
      const { data } = await client.from('content_jobs').select('status').eq('id', jobId).single()
      expect(data?.status).toBe('failed')
    })
  })
})
