import type { SupabaseClient } from '@supabase/supabase-js'
import type { SocialPlatform, SocialPublisher, SocialPublishJobRef } from '../../adapters/types'
import {
  getApprovedSocialPostsAwaitingSubmission,
  getGeneratedContentFileUrl,
  insertSocialPlatformLogs,
  getPostingSocialPlatformLogGroups,
  resolveSocialPlatformLogs,
  markSocialPlatformLogFailed,
  bumpSocialPlatformLogAttempt,
  rollupSocialPostStatus,
  type SocialPostRow,
} from '../../db'

// A row stuck at status='posting' this long without resolving is treated as
// abandoned, not merely slow — same reasoning as renderLanguageTrack.ts's
// STALE_CLAIM_MS. upload-post.com's docs don't state an upper bound for the
// async path; 10 minutes is a deliberately generous multiple of the ~59s
// sync-to-async cutover they DO document, chosen to bound "stuck forever"
// (the exact bug confirmed live in TASKS.md/PROGRESS.md — 2 social_posts
// rows stuck at status='posting' since 2026-07-01 with zero platform-log
// rows and no error surfaced anywhere) to a fixed, visible window, without
// mistaking a genuinely slow-but-alive publish for an abandoned one.
const STALE_POSTING_MS = 10 * 60 * 1000

function isStale(lastAttemptedAt: string | null): boolean {
  if (!lastAttemptedAt) return false
  return Date.now() - new Date(lastAttemptedAt).getTime() > STALE_POSTING_MS
}

/** Encodes which of upload-post.com's two async identifiers (request_id vs.
 *  job_id — see socialPublisher.ts) a stored provider_job_ref is, so
 *  runPollSocialPosts can reconstruct the right query param without a
 *  second DB column. The 'job:' (scheduled-post) branch is currently dead
 *  in practice — this app never sets scheduled_date/add_to_queue, so
 *  publish() only ever returns the 'request' kind today — but encoding it
 *  explicitly here means a future scheduling feature doesn't have to guess
 *  at a stored string's shape retroactively. */
function encodeJobRef(jobRef: SocialPublishJobRef): string {
  return jobRef.kind === 'request' ? `request:${jobRef.requestId}` : `job:${jobRef.jobId}`
}

function decodeJobRef(stored: string): SocialPublishJobRef {
  const sepIndex = stored.indexOf(':')
  const kind = stored.slice(0, sepIndex)
  const id = stored.slice(sepIndex + 1)
  if (kind === 'job') return { kind: 'job', jobId: id }
  return { kind: 'request', requestId: id }
}

/** Submits ONE platform's publish() call for a post, and records its own
 *  outcome independently of every other platform's call. This isolation is
 *  the whole point: upload-post.com validates the entire platform[] array
 *  of a single call together, so a batched multi-platform call can fail
 *  EVERY platform in it over just one being invalid/unsupported — confirmed
 *  live (2026-09-25): a 3-platform image_post call was rejected wholesale
 *  with "Invalid platforms for photo upload: ['twitter']", marking
 *  Instagram and Facebook 'failed' too, with that same misattributed error,
 *  even though neither was the actual problem. Calling publish() once per
 *  platform means one platform's rejection can never affect another's
 *  outcome, status, or error message. */
async function submitOnePlatform(
  client: SupabaseClient,
  publisher: SocialPublisher,
  post: SocialPostRow,
  platform: SocialPlatform,
  mediaUrl: string,
): Promise<void> {
  try {
    const outcome = await publisher.publish({
      contentType: post.content_type as 'video' | 'image_post' | 'blog',
      platforms: [platform],
      caption: post.caption,
      hashtags: post.hashtags,
      mediaUrl,
    })

    if (outcome.status === 'ready') {
      const result = outcome.perPlatform.find((p) => p.platform === platform)
      await insertSocialPlatformLogs(client, {
        socialPostId: post.id,
        jobId: post.job_id,
        contentType: post.content_type,
        providerJobRef: null,
        outcomes: [
          {
            platform,
            status: result?.success ? 'posted' : 'failed',
            postUrl: result?.url,
            errorMessage: result?.error,
          },
        ],
      })
    } else if (outcome.status === 'pending') {
      await insertSocialPlatformLogs(client, {
        socialPostId: post.id,
        jobId: post.job_id,
        contentType: post.content_type,
        providerJobRef: encodeJobRef(outcome.jobRef),
        outcomes: [{ platform, status: 'posting' }],
      })
    } else {
      // 'failed' — UploadPostSocialPublisher.publish() never actually
      // returns this today (it throws ProviderCallError instead, caught
      // below), but SocialPublishOutcome's type allows a future/different
      // SocialPublisher implementation to report a synchronous failure
      // without throwing, so it's handled the same way as the catch block.
      await insertSocialPlatformLogs(client, {
        socialPostId: post.id,
        jobId: post.job_id,
        contentType: post.content_type,
        providerJobRef: null,
        outcomes: [{ platform, status: 'failed', errorMessage: outcome.detail }],
      })
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[worker] social post ${post.id} platform ${platform} submit failed:`, message)
    // No social_platform_logs row exists yet for this (post, platform) —
    // write a failed row directly, rather than leaving it silently stuck
    // at 'approved' forever, which is the exact class of bug this
    // migration replaces. Caught here, not in submitOnePost, so this
    // platform's failure never stops the loop from attempting the rest.
    await insertSocialPlatformLogs(client, {
      socialPostId: post.id,
      jobId: post.job_id,
      contentType: post.content_type,
      providerJobRef: null,
      outcomes: [{ platform, status: 'failed', errorMessage: message }],
    }).catch((insertErr) => {
      console.error(`[worker] social post ${post.id} platform ${platform}: failed to record submit failure:`, insertErr)
    })
  }
}

/** `platformsToSubmit` is the subset of post.platforms that still needs
 *  submission (no 'posted' log row yet) — see getApprovedSocialPostsAwaitingSubmission's
 *  own header for why this is safe to trust as-is rather than re-deriving
 *  it here. Using ONLY this subset (never post.platforms) is what makes a
 *  partial retry resubmit just the platforms that previously failed,
 *  instead of re-posting to one that already went out live. */
async function submitOnePost(
  client: SupabaseClient,
  publisher: SocialPublisher,
  post: SocialPostRow,
  platformsToSubmit: SocialPlatform[],
): Promise<void> {
  const mediaUrl = await getGeneratedContentFileUrl(client, post.job_id, post.content_type, post.language)
  if (!mediaUrl) {
    // Not platform-specific — there's nothing to post at all regardless of
    // platform, so every platform genuinely shares this one failure reason
    // (unlike a provider-side per-platform rejection), and batching it here
    // doesn't reintroduce the coupling this fix removes.
    await insertSocialPlatformLogs(client, {
      socialPostId: post.id,
      jobId: post.job_id,
      contentType: post.content_type,
      providerJobRef: null,
      outcomes: platformsToSubmit.map((platform) => ({
        platform,
        status: 'failed',
        errorMessage: `no generated_content.file_url found for job ${post.job_id} / ${post.content_type} — nothing to post`,
      })),
    })
  } else {
    for (const platform of platformsToSubmit) {
      await submitOnePlatform(client, publisher, post, platform, mediaUrl)
    }
  }

  await rollupSocialPostStatus(client, post.id)
}

/** Submits every approved social_posts row's still-pending platforms to
 *  upload-post.com — one call per post covering whichever of its
 *  platforms[] haven't already succeeded (a first submission: all of
 *  them; a partial retry: just the ones that failed last time), fanning
 *  the result out into one social_platform_logs row per platform.
 *  Replaces the fire-and-forget N8N_SOCIAL_WEBHOOK call
 *  src/app/api/social/post/route.ts used to make. */
export async function runSubmitSocialPosts(client: SupabaseClient, publisher: SocialPublisher): Promise<void> {
  const pending = await getApprovedSocialPostsAwaitingSubmission(client)
  for (const { post, platforms } of pending) {
    await submitOnePost(client, publisher, post, platforms as SocialPlatform[])
  }
}

/** Polls every in-flight upload-post.com job, resolving or timing out each
 *  group of platform-log rows it covers (one group per provider_job_ref —
 *  see getPostingSocialPlatformLogGroups). */
export async function runPollSocialPosts(client: SupabaseClient, publisher: SocialPublisher): Promise<void> {
  const groups = await getPostingSocialPlatformLogGroups(client)

  for (const [providerJobRef, rows] of groups) {
    const staleRows = rows.filter((r) => isStale(r.last_attempted_at))
    if (staleRows.length > 0) {
      for (const row of staleRows) {
        await markSocialPlatformLogFailed(
          client,
          row.id,
          `Timed out waiting on upload-post.com after ${STALE_POSTING_MS / 1000}s (provider_job_ref=${providerJobRef})`,
        )
      }
      await rollupSocialPostStatus(client, rows[0].social_post_id)
      continue
    }

    try {
      await bumpSocialPlatformLogAttempt(
        client,
        rows.map((r) => r.id),
      )
      const result = await publisher.poll(decodeJobRef(providerJobRef))

      if (result.status === 'ready') {
        await resolveSocialPlatformLogs(client, rows, result.perPlatform)
        await rollupSocialPostStatus(client, rows[0].social_post_id)
      } else if (result.status === 'failed') {
        for (const row of rows) {
          await markSocialPlatformLogFailed(client, row.id, result.detail)
        }
        await rollupSocialPostStatus(client, rows[0].social_post_id)
      }
      // 'pending' — leave as-is, the next tick checks again.
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`[worker] social poll for provider_job_ref=${providerJobRef} failed:`, message)
      // Leave status='posting' — isStale's check above is what eventually
      // terminates a group whose poll call keeps throwing, rather than
      // failing it on the first transient network error.
    }
  }
}
