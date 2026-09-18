// Social's Inngest orchestration — replaces worker/src/index.ts's
// tickSocial (see docs/IMPLEMENTATION_PLAN.md's Inngest migration plan,
// Phase 4). Calls the SAME step functions the worker used, unmodified.
//
// Unlike blog/image, this is ONE event triggering a global sweep, not one
// event per post: runSubmitSocialPosts/runPollSocialPosts (see
// src/server/pipeline/steps/social/publishPost.ts) already operate over
// EVERY approved-but-unsubmitted post / in-flight platform-log group in one
// call each — there is no per-post CAS or claim anywhere in this path.
// "Not yet submitted" is inferred purely from the ABSENCE of any
// social_platform_logs row for a post (a plain SELECT, no locking — see
// getApprovedSocialPostsAwaitingSubmission's own comment in db.ts). That's
// only safe today because the worker's tick loop is strictly single-process
// and sequential; reusing these functions unchanged means this function
// must preserve that same "exactly one execution at a time" guarantee
// itself, via the function-level concurrency limit below, rather than
// scoping to a single postId the way blog/image do.
import { inngest } from '../client'
import { createServiceClient, getPostingSocialPlatformLogGroups } from '../../server/pipeline/db'
import { runSubmitSocialPosts, runPollSocialPosts } from '../../server/pipeline/steps/social/publishPost'
import { UploadPostSocialPublisher } from '../../server/pipeline/adapters/socialPublisher'
import { env } from '../../server/pipeline/env'

const client = createServiceClient()

const POLL_INTERVAL = '10s'
// ~15 minutes — comfortably past publishPost.ts's own STALE_POSTING_MS
// (10 min), so any group that goes stale during THIS run's watch window is
// guaranteed to get marked failed (by runPollSocialPosts's own isStale
// check) before this function gives up, rather than being left 'posting'
// forever waiting for some future event to happen to check it again — the
// worker's always-on tick loop had that guarantee for free; this loop has
// to provide it itself since nothing else polls in between events.
const MAX_POLL_ITERATIONS = 90

export const socialPublish = inngest.createFunction(
  {
    id: 'social-publish',
    triggers: [{ event: 'content/social.publish' }],
    concurrency: { limit: 1 },
  },
  async ({ step }) => {
    if (!env.UPLOAD_POST_PROFILE) {
      // Mirrors worker/src/index.ts's main() guard — social posting is
      // optional infrastructure, not required for blog/image/video.
      return { status: 'skipped', reason: 'UPLOAD_POST_PROFILE not configured' }
    }
    const publisher = new UploadPostSocialPublisher(env.UPLOAD_POST_API_KEY, env.UPLOAD_POST_PROFILE)

    await step.run('submit', () => runSubmitSocialPosts(client, publisher))

    for (let attempt = 0; attempt < MAX_POLL_ITERATIONS; attempt++) {
      const remaining = await step.run(`poll-${attempt}`, async () => {
        await runPollSocialPosts(client, publisher)
        const groups = await getPostingSocialPlatformLogGroups(client)
        return groups.size
      })
      if (remaining === 0) return { status: 'done' }
      await step.sleep(`poll-backoff-${attempt}`, POLL_INTERVAL)
    }

    return { status: 'done', note: 'hit max poll iterations with rows still posting' }
  },
)
