import {
  ProviderCallError,
  type SocialPlatform,
  type SocialPlatformOutcome,
  type SocialPublishInput,
  type SocialPublishJobRef,
  type SocialPublishOutcome,
  type SocialPublishPollResult,
  type SocialPublisher,
} from './types'

type PlatformResult = { success: boolean; url?: string; error?: string }

function toOutcomes(
  platforms: SocialPlatform[],
  results: Record<string, PlatformResult>,
): SocialPlatformOutcome[] {
  return platforms.map((platform) => {
    const r = results[platform]
    return { platform, success: r?.success ?? false, url: r?.url, error: r?.error }
  })
}

/**
 * Wraps upload-post.com's publish API — replaces n8n's social branch
 * (ARCHITECTURE.MD §2.5): n8n used to build this exact payload, POST it,
 * poll, and callback on completion; this adapter is the same three calls,
 * now driven by worker/src/steps/social/publishPost.ts's own poll-loop
 * tick instead of an n8n execution.
 *
 * CONFIRMED against docs.upload-post.com's OpenAPI spec, 2026-09-17:
 * - POST /api/upload (video) / POST /api/upload_photos (image_post/blog),
 *   both multipart/form-data, both `Authorization: Apikey <key>` — the
 *   same scheme avMerger.ts already confirmed live for the FFmpeg Editor
 *   API, consistent across upload-post.com's whole surface.
 * - Required fields: `user` (a profile identifier — the upload-post.com
 *   account/profile that owns the connected IG/FB/X accounts, not an
 *   end-user of this app), `platform[]`, and `video` (file-or-URL) /
 *   `photos[]` (binary array). `video` is explicitly documented as
 *   accepting a plain https:// URL string in place of a binary upload.
 * - A call resolves one of three ways: synchronously (200, `results` keyed
 *   by platform), asynchronously in the background (200, `request_id` +
 *   `total_platforms`, no `results` yet — uploads over ~59s always take
 *   this path even without asking for it), or scheduled/queued (202,
 *   `job_id`). GET /api/uploadposts/status?request_id=... (or ?job_id=...)
 *   resolves the latter two.
 *
 * NOT independently verified — same flagging convention as avMerger.ts's
 * escapeDrawtextValue/kie.ts's endpoints — confirm against a real call
 * before trusting on user-facing content:
 * - Whether `photos[]` accepts a plain URL string the same way `video`
 *   does, or requires an actual binary part. Assumed URL-capable here
 *   (this app never holds raw bytes for image_post/blog content, only
 *   Supabase Storage URLs) — if upload-post.com rejects it, the fix is
 *   fetching the URL into a Buffer and appending it as a Blob part
 *   instead, not a redesign of this adapter's interface.
 * - The exact shape of GET /api/uploadposts/status's response body — the
 *   OpenAPI spec's schema definitions were truncated mid-fetch. poll()
 *   below assumes it mirrors the sync response's own `results` shape once
 *   resolved (both are the same underlying per-platform publish result,
 *   just delivered on a different timeline) and treats an unrecognized
 *   body as still-pending rather than guessing at a failure — the same
 *   fail-safe-to-"still polling" choice avMerger.ts's poll() makes for any
 *   unrecognized upload-post.com status string.
 * - Whether `title` is really the right field for a full caption+hashtags
 *   string on every platform, vs. `description` mattering more on some
 *   (Facebook/LinkedIn/Pinterest per the docs) — publishPost.ts passes one
 *   combined caption string into `title` for now; worth revisiting per
 *   platform if a real post looks truncated or malformed on any of them.
 */
export class UploadPostSocialPublisher implements SocialPublisher {
  constructor(
    private readonly apiKey: string,
    private readonly profile: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly baseUrl: string = 'https://api.upload-post.com',
  ) {}

  async publish(input: SocialPublishInput): Promise<SocialPublishOutcome> {
    const isVideo = input.contentType === 'video'
    const path = isVideo ? '/api/upload' : '/api/upload_photos'

    const form = new FormData()
    form.set('user', this.profile)
    for (const platform of input.platforms) {
      form.append('platform[]', platform)
    }
    const caption = [input.caption, ...input.hashtags.map((h) => `#${h}`)].join(' ')
    form.set('title', caption)
    if (isVideo) {
      form.set('video', input.mediaUrl)
    } else {
      form.append('photos[]', input.mediaUrl)
    }

    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { Authorization: `Apikey ${this.apiKey}` },
      body: form,
    })

    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new ProviderCallError('upload-post', res.status, detail)
    }

    const data = (await res.json()) as {
      results?: Record<string, PlatformResult>
      request_id?: string
      job_id?: string
    }

    if (data.results) {
      return { status: 'ready', perPlatform: toOutcomes(input.platforms, data.results) }
    }
    if (data.request_id) {
      return { status: 'pending', jobRef: { kind: 'request', requestId: data.request_id } }
    }
    if (data.job_id) {
      return { status: 'pending', jobRef: { kind: 'job', jobId: data.job_id } }
    }

    throw new ProviderCallError(
      'upload-post',
      res.status,
      `response had neither results, request_id, nor job_id: ${JSON.stringify(data)}`,
    )
  }

  async poll(jobRef: SocialPublishJobRef): Promise<SocialPublishPollResult> {
    const query =
      jobRef.kind === 'request'
        ? `request_id=${encodeURIComponent(jobRef.requestId)}`
        : `job_id=${encodeURIComponent(jobRef.jobId)}`

    const res = await this.fetchImpl(`${this.baseUrl}/api/uploadposts/status?${query}`, {
      headers: { Authorization: `Apikey ${this.apiKey}` },
    })

    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new ProviderCallError('upload-post', res.status, detail)
    }

    const data = (await res.json()) as {
      results?: Record<string, PlatformResult>
      status?: string
      error?: string
    }

    if (data.results) {
      const platforms = Object.keys(data.results) as SocialPlatform[]
      return { status: 'ready', perPlatform: toOutcomes(platforms, data.results) }
    }
    if (data.status && /fail|error/i.test(data.status)) {
      return { status: 'failed', detail: data.error ?? data.status }
    }

    return { status: 'pending' }
  }
}
