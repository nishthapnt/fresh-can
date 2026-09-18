// Unit test of the social-posting worker step's ORCHESTRATION LOGIC only —
// db.ts is fully mocked (vi.mock below), so this never makes a real
// Supabase call and never touches the live database. This matters beyond
// the usual "fast, isolated unit test" reasons: getApprovedSocialPostsAwaitingSubmission/
// getPostingSocialPlatformLogGroups operate GLOBALLY across every
// social_posts/social_platform_logs row (by design — that's how the real
// worker loop has to work, it has no per-job scope), so a version of this
// test that hit the real shared Supabase project would also pick up and
// mutate real, pre-existing rows from actual past user activity (confirmed
// live, 2026-09-17: 5 real social_posts rows already sitting at
// status='approved' from actual historical jobs) using this test's MOCK
// SocialPublisher's fake responses — corrupting real data with fabricated
// "posted" results. Mocking db.ts entirely avoids that risk altogether,
// at the cost of not exercising the real Postgres round trip (the adapter
// itself is separately covered, over a mocked fetch, in
// socialPublisher.test.ts).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { runSubmitSocialPosts, runPollSocialPosts } from './publishPost'
import type {
  SocialPublisher,
  SocialPublishInput,
  SocialPublishOutcome,
  SocialPublishPollResult,
} from '../../adapters/types'
import type { SocialPostRow, SocialPlatformLogRow } from '../../db'

vi.mock('../../db.js', () => ({
  getApprovedSocialPostsAwaitingSubmission: vi.fn(),
  getGeneratedContentFileUrl: vi.fn(),
  insertSocialPlatformLogs: vi.fn(),
  getPostingSocialPlatformLogGroups: vi.fn(),
  resolveSocialPlatformLogs: vi.fn(),
  markSocialPlatformLogFailed: vi.fn(),
  bumpSocialPlatformLogAttempt: vi.fn(),
  rollupSocialPostStatus: vi.fn(),
}))

import * as db from '../../db'

const client = {} as SupabaseClient // never touched directly by publishPost.ts — only forwarded to the mocked db.ts functions above

function makePost(overrides: Partial<SocialPostRow> = {}): SocialPostRow {
  return {
    id: 'post-1',
    job_id: 'job-1',
    content_type: 'image_post',
    caption: 'Fresh produce today!',
    hashtags: ['fresh', 'local'],
    platforms: ['instagram', 'facebook'],
    status: 'approved',
    created_at: '2026-09-17T00:00:00Z',
    updated_at: '2026-09-17T00:00:00Z',
    ...overrides,
  }
}

function makeLog(overrides: Partial<SocialPlatformLogRow> = {}): SocialPlatformLogRow {
  return {
    id: 'log-1',
    social_post_id: 'post-1',
    job_id: 'job-1',
    content_type: 'image_post',
    platform: 'instagram',
    status: 'posting',
    platform_post_id: null,
    post_url: null,
    error_message: null,
    provider_job_ref: 'request:req-1',
    attempt_count: 1,
    last_attempted_at: new Date().toISOString(),
    created_at: '2026-09-17T00:00:00Z',
    updated_at: '2026-09-17T00:00:00Z',
    ...overrides,
  }
}

function makeMockPublisher(overrides: Partial<SocialPublisher> = {}): SocialPublisher {
  return {
    publish: vi.fn(async () => ({ status: 'ready', perPlatform: [] }) as SocialPublishOutcome),
    poll: vi.fn(async () => ({ status: 'pending' }) as SocialPublishPollResult),
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  // Default resolved values for the void-returning db.ts writes — a bare
  // vi.fn() with no implementation returns undefined, not a Promise, which
  // breaks real code that awaits/chains .catch() on the call (as
  // publishPost.ts's own failure-fallback path does). Individual tests
  // still assert on these calls via toHaveBeenCalledWith; only their
  // resolved value is defaulted here.
  vi.mocked(db.insertSocialPlatformLogs).mockResolvedValue(undefined)
  vi.mocked(db.resolveSocialPlatformLogs).mockResolvedValue(undefined)
  vi.mocked(db.markSocialPlatformLogFailed).mockResolvedValue(undefined)
  vi.mocked(db.bumpSocialPlatformLogAttempt).mockResolvedValue(undefined)
  vi.mocked(db.rollupSocialPostStatus).mockResolvedValue(undefined)
})

describe('runSubmitSocialPosts', () => {
  it('resolves the media URL, publishes, and writes one posted platform log per platform on a sync-ready outcome', async () => {
    vi.mocked(db.getApprovedSocialPostsAwaitingSubmission).mockResolvedValue([makePost()])
    vi.mocked(db.getGeneratedContentFileUrl).mockResolvedValue('https://example.com/photo.png')
    const publisher = makeMockPublisher({
      publish: vi.fn(
        async (input: SocialPublishInput): Promise<SocialPublishOutcome> => ({
          status: 'ready',
          perPlatform: input.platforms.map((platform) => ({ platform, success: true, url: `https://x.com/${platform}` })),
        }),
      ),
    })

    await runSubmitSocialPosts(client, publisher)

    expect(db.getGeneratedContentFileUrl).toHaveBeenCalledWith(client, 'job-1', 'image_post')
    expect(publisher.publish).toHaveBeenCalledWith({
      contentType: 'image_post',
      platforms: ['instagram', 'facebook'],
      caption: 'Fresh produce today!',
      hashtags: ['fresh', 'local'],
      mediaUrl: 'https://example.com/photo.png',
    })
    expect(db.insertSocialPlatformLogs).toHaveBeenCalledWith(client, {
      socialPostId: 'post-1',
      jobId: 'job-1',
      contentType: 'image_post',
      providerJobRef: null,
      outcomes: [
        { platform: 'instagram', status: 'posted', postUrl: 'https://x.com/instagram', errorMessage: undefined },
        { platform: 'facebook', status: 'posted', postUrl: 'https://x.com/facebook', errorMessage: undefined },
      ],
    })
    expect(db.rollupSocialPostStatus).toHaveBeenCalledWith(client, 'post-1')
  })

  it('writes posting rows with the encoded provider_job_ref for an async (pending) outcome', async () => {
    vi.mocked(db.getApprovedSocialPostsAwaitingSubmission).mockResolvedValue([makePost({ platforms: ['instagram'] })])
    vi.mocked(db.getGeneratedContentFileUrl).mockResolvedValue('https://example.com/photo.png')
    const publisher = makeMockPublisher({
      publish: vi.fn(
        async (): Promise<SocialPublishOutcome> => ({ status: 'pending', jobRef: { kind: 'request', requestId: 'req-9' } }),
      ),
    })

    await runSubmitSocialPosts(client, publisher)

    expect(db.insertSocialPlatformLogs).toHaveBeenCalledWith(client, {
      socialPostId: 'post-1',
      jobId: 'job-1',
      contentType: 'image_post',
      providerJobRef: 'request:req-9',
      outcomes: [{ platform: 'instagram', status: 'posting' }],
    })
  })

  it('encodes a job-kind jobRef distinctly from a request-kind one', async () => {
    vi.mocked(db.getApprovedSocialPostsAwaitingSubmission).mockResolvedValue([makePost({ platforms: ['instagram'] })])
    vi.mocked(db.getGeneratedContentFileUrl).mockResolvedValue('https://example.com/photo.png')
    const publisher = makeMockPublisher({
      publish: vi.fn(
        async (): Promise<SocialPublishOutcome> => ({ status: 'pending', jobRef: { kind: 'job', jobId: 'sched-9' } }),
      ),
    })

    await runSubmitSocialPosts(client, publisher)

    expect(db.insertSocialPlatformLogs).toHaveBeenCalledWith(
      client,
      expect.objectContaining({ providerJobRef: 'job:sched-9' }),
    )
  })

  it('never calls publish() when no generated_content.file_url exists, and records a failed row per platform instead', async () => {
    vi.mocked(db.getApprovedSocialPostsAwaitingSubmission).mockResolvedValue([makePost({ platforms: ['instagram'] })])
    vi.mocked(db.getGeneratedContentFileUrl).mockResolvedValue(null)
    const publisher = makeMockPublisher()

    await runSubmitSocialPosts(client, publisher)

    expect(publisher.publish).not.toHaveBeenCalled()
    expect(db.insertSocialPlatformLogs).toHaveBeenCalledWith(
      client,
      expect.objectContaining({
        outcomes: [expect.objectContaining({ platform: 'instagram', status: 'failed' })],
      }),
    )
    const call = vi.mocked(db.insertSocialPlatformLogs).mock.calls[0][1]
    expect(call.outcomes[0].errorMessage).toMatch(/no generated_content\.file_url found/)
    expect(db.rollupSocialPostStatus).toHaveBeenCalledWith(client, 'post-1')
  })

  it('records a failed row per platform when publish() itself throws, instead of leaving the post stuck at approved', async () => {
    vi.mocked(db.getApprovedSocialPostsAwaitingSubmission).mockResolvedValue([makePost({ platforms: ['instagram', 'facebook'] })])
    vi.mocked(db.getGeneratedContentFileUrl).mockResolvedValue('https://example.com/photo.png')
    const publisher = makeMockPublisher({
      publish: vi.fn(async () => {
        throw new Error('simulated upload-post.com outage')
      }),
    })

    await runSubmitSocialPosts(client, publisher)

    expect(db.insertSocialPlatformLogs).toHaveBeenCalledWith(client, {
      socialPostId: 'post-1',
      jobId: 'job-1',
      contentType: 'image_post',
      providerJobRef: null,
      outcomes: [
        { platform: 'instagram', status: 'failed', errorMessage: 'simulated upload-post.com outage' },
        { platform: 'facebook', status: 'failed', errorMessage: 'simulated upload-post.com outage' },
      ],
    })
    expect(db.rollupSocialPostStatus).toHaveBeenCalledWith(client, 'post-1')
  })

  it('processes every approved post independently, in a single tick', async () => {
    vi.mocked(db.getApprovedSocialPostsAwaitingSubmission).mockResolvedValue([
      makePost({ id: 'post-1', job_id: 'job-1' }),
      makePost({ id: 'post-2', job_id: 'job-2' }),
    ])
    vi.mocked(db.getGeneratedContentFileUrl).mockResolvedValue('https://example.com/photo.png')
    const publisher = makeMockPublisher()

    await runSubmitSocialPosts(client, publisher)

    expect(publisher.publish).toHaveBeenCalledTimes(2)
    expect(db.rollupSocialPostStatus).toHaveBeenCalledWith(client, 'post-1')
    expect(db.rollupSocialPostStatus).toHaveBeenCalledWith(client, 'post-2')
  })
})

describe('runPollSocialPosts', () => {
  it('resolves a ready group via resolveSocialPlatformLogs and rolls up the post', async () => {
    const rows = [makeLog({ id: 'log-1', platform: 'instagram' }), makeLog({ id: 'log-2', platform: 'facebook' })]
    vi.mocked(db.getPostingSocialPlatformLogGroups).mockResolvedValue(new Map([['request:req-1', rows]]))
    const publisher = makeMockPublisher({
      poll: vi.fn(
        async (): Promise<SocialPublishPollResult> => ({
          status: 'ready',
          perPlatform: [
            { platform: 'instagram', success: true, url: 'https://x.com/instagram' },
            { platform: 'facebook', success: false, error: 'rejected' },
          ],
        }),
      ),
    })

    await runPollSocialPosts(client, publisher)

    expect(db.bumpSocialPlatformLogAttempt).toHaveBeenCalledWith(client, ['log-1', 'log-2'])
    expect(publisher.poll).toHaveBeenCalledWith({ kind: 'request', requestId: 'req-1' })
    expect(db.resolveSocialPlatformLogs).toHaveBeenCalledWith(client, rows, [
      { platform: 'instagram', success: true, url: 'https://x.com/instagram' },
      { platform: 'facebook', success: false, error: 'rejected' },
    ])
    expect(db.rollupSocialPostStatus).toHaveBeenCalledWith(client, 'post-1')
  })

  it('decodes a job-kind provider_job_ref correctly', async () => {
    const rows = [makeLog({ id: 'log-1', provider_job_ref: 'job:sched-1' })]
    vi.mocked(db.getPostingSocialPlatformLogGroups).mockResolvedValue(new Map([['job:sched-1', rows]]))
    const publisher = makeMockPublisher()

    await runPollSocialPosts(client, publisher)

    expect(publisher.poll).toHaveBeenCalledWith({ kind: 'job', jobId: 'sched-1' })
  })

  it('marks every row in a group failed when poll() reports status=failed', async () => {
    const rows = [makeLog({ id: 'log-1' }), makeLog({ id: 'log-2' })]
    vi.mocked(db.getPostingSocialPlatformLogGroups).mockResolvedValue(new Map([['request:req-1', rows]]))
    const publisher = makeMockPublisher({
      poll: vi.fn(async (): Promise<SocialPublishPollResult> => ({ status: 'failed', detail: 'account disconnected' })),
    })

    await runPollSocialPosts(client, publisher)

    expect(db.markSocialPlatformLogFailed).toHaveBeenCalledWith(client, 'log-1', 'account disconnected')
    expect(db.markSocialPlatformLogFailed).toHaveBeenCalledWith(client, 'log-2', 'account disconnected')
    expect(db.rollupSocialPostStatus).toHaveBeenCalledWith(client, 'post-1')
  })

  it('leaves a pending group untouched — no resolve, no fail, no rollup', async () => {
    const rows = [makeLog({ id: 'log-1' })]
    vi.mocked(db.getPostingSocialPlatformLogGroups).mockResolvedValue(new Map([['request:req-1', rows]]))
    const publisher = makeMockPublisher({ poll: vi.fn(async (): Promise<SocialPublishPollResult> => ({ status: 'pending' })) })

    await runPollSocialPosts(client, publisher)

    expect(db.resolveSocialPlatformLogs).not.toHaveBeenCalled()
    expect(db.markSocialPlatformLogFailed).not.toHaveBeenCalled()
    expect(db.rollupSocialPostStatus).not.toHaveBeenCalled()
  })

  it('flips a stale group to failed WITHOUT calling poll() at all (the fix for the confirmed-live stuck-at-posting-forever bug)', async () => {
    const staleTimestamp = new Date(Date.now() - 15 * 60 * 1000).toISOString()
    const rows = [makeLog({ id: 'log-1', last_attempted_at: staleTimestamp })]
    vi.mocked(db.getPostingSocialPlatformLogGroups).mockResolvedValue(new Map([['request:req-1', rows]]))
    const publisher = makeMockPublisher()

    await runPollSocialPosts(client, publisher)

    expect(publisher.poll).not.toHaveBeenCalled()
    expect(db.markSocialPlatformLogFailed).toHaveBeenCalledWith(client, 'log-1', expect.stringMatching(/timed out/i))
    expect(db.rollupSocialPostStatus).toHaveBeenCalledWith(client, 'post-1')
  })

  it('does not treat a recently-attempted row as stale', async () => {
    const rows = [makeLog({ id: 'log-1', last_attempted_at: new Date().toISOString() })]
    vi.mocked(db.getPostingSocialPlatformLogGroups).mockResolvedValue(new Map([['request:req-1', rows]]))
    const publisher = makeMockPublisher()

    await runPollSocialPosts(client, publisher)

    expect(publisher.poll).toHaveBeenCalled()
    expect(db.markSocialPlatformLogFailed).not.toHaveBeenCalled()
  })

  it('swallows a poll() error and leaves the row for the next tick, rather than crashing the whole loop', async () => {
    const rows = [makeLog({ id: 'log-1' })]
    vi.mocked(db.getPostingSocialPlatformLogGroups).mockResolvedValue(new Map([['request:req-1', rows]]))
    const publisher = makeMockPublisher({
      poll: vi.fn(async () => {
        throw new Error('simulated transient network failure')
      }),
    })

    await expect(runPollSocialPosts(client, publisher)).resolves.not.toThrow()
    expect(db.markSocialPlatformLogFailed).not.toHaveBeenCalled()
    expect(db.rollupSocialPostStatus).not.toHaveBeenCalled()
  })

  it('polls multiple in-flight groups independently in one tick', async () => {
    const groupA = [makeLog({ id: 'log-1', social_post_id: 'post-1', provider_job_ref: 'request:req-a' })]
    const groupB = [makeLog({ id: 'log-2', social_post_id: 'post-2', provider_job_ref: 'request:req-b' })]
    vi.mocked(db.getPostingSocialPlatformLogGroups).mockResolvedValue(
      new Map([
        ['request:req-a', groupA],
        ['request:req-b', groupB],
      ]),
    )
    const publisher = makeMockPublisher({
      poll: vi.fn(
        async (): Promise<SocialPublishPollResult> => ({
          status: 'ready',
          perPlatform: [{ platform: 'instagram', success: true, url: 'x' }],
        }),
      ),
    })

    await runPollSocialPosts(client, publisher)

    expect(publisher.poll).toHaveBeenCalledTimes(2)
    expect(db.rollupSocialPostStatus).toHaveBeenCalledWith(client, 'post-1')
    expect(db.rollupSocialPostStatus).toHaveBeenCalledWith(client, 'post-2')
  })
})
