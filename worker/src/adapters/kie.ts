import {
  ProviderCallError,
  type ImageGenerator,
  type ImageGenerationInput,
  type ImageJobRef,
  type ImagePollResult,
  type VideoGenerator,
  type VideoGenerationInput,
  type VideoJobRef,
  type VideoPollResult,
} from './types.js'

/**
 * KIE.ai image generation — Flux Kontext submit + poll, verified against the
 * real API reference at docs.kie.ai/flux-kontext-api (generate-or-edit-image,
 * get-image-details) on 2026-09-09. Replaces an earlier best-effort guess
 * (`/v1/images`) that 404'd against the live API — see git history for that
 * version if you need to compare.
 */
export class KieImageGenerator implements ImageGenerator {
  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly baseUrl: string = 'https://api.kie.ai',
  ) {}

  async submit(input: ImageGenerationInput): Promise<ImageJobRef> {
    const res = await this.fetchImpl(`${this.baseUrl}/api/v1/flux/kontext/generate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        prompt: input.prompt,
        // '1:1' remains the default for callers that never set this
        // (blog/image_post) — unchanged from before this field existed.
        aspectRatio: input.aspectRatio ?? '1:1',
        outputFormat: 'png',
        ...(input.referenceImageUrl ? { inputImage: input.referenceImageUrl } : {}),
      }),
    })

    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new ProviderCallError('kie', res.status, detail)
    }

    const data = (await res.json()) as { code?: number; msg?: string; data?: { taskId?: string } }
    const taskId = data.data?.taskId
    if (data.code !== 200 || !taskId) {
      throw new ProviderCallError('kie', res.status, data.msg ?? 'response had no data.taskId')
    }

    return { providerRef: taskId }
  }

  async poll(jobRef: ImageJobRef): Promise<ImagePollResult> {
    const res = await this.fetchImpl(
      `${this.baseUrl}/api/v1/flux/kontext/record-info?taskId=${encodeURIComponent(jobRef.providerRef)}`,
      { headers: { Authorization: `Bearer ${this.apiKey}` } },
    )

    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new ProviderCallError('kie', res.status, detail)
    }

    const data = (await res.json()) as {
      data?: {
        successFlag?: number
        errorMessage?: string | null
        response?: { resultImageUrl?: string }
      }
    }
    const inner = data.data

    // successFlag: 0 GENERATING, 1 SUCCESS, 2 CREATE_TASK_FAILED, 3 GENERATE_FAILED
    if (inner?.successFlag === 1) {
      const fileUrl = inner.response?.resultImageUrl
      if (!fileUrl) {
        return { status: 'failed', detail: 'successFlag=1 but response.resultImageUrl was missing' }
      }
      return { status: 'ready', fileUrl }
    }
    if (inner?.successFlag === 2 || inner?.successFlag === 3) {
      return { status: 'failed', detail: inner.errorMessage ?? 'unknown KIE.ai failure' }
    }
    return { status: 'pending' }
  }
}

/**
 * KIE.ai scene video-clip generation — Kling 2.6 image-to-video via the
 * unified Market job endpoints (POST /api/v1/jobs/createTask, GET
 * /api/v1/jobs/recordInfo), verified against docs.kie.ai/market/kling/
 * image-to-video and docs.kie.ai/market/common/get-task-detail on
 * 2026-09-12. `referenceImageUrl` is always the scene's already-generated
 * scene_image — this is what keeps the character/likeness consistent
 * (Kling animates from that one locked frame; it never regenerates the
 * subject's appearance independently), so a caller must never pass a bare
 * text-only prompt with no image here.
 */
export class KieVideoGenerator implements VideoGenerator {
  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly baseUrl: string = 'https://api.kie.ai',
  ) {}

  async submit(input: VideoGenerationInput): Promise<VideoJobRef> {
    const res = await this.fetchImpl(`${this.baseUrl}/api/v1/jobs/createTask`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: 'kling-2.6/image-to-video',
        input: {
          prompt: input.prompt,
          image_urls: [input.referenceImageUrl],
          // Narration audio is composited separately at render time
          // (avMerger.ts) — this call never carries the language-specific
          // narration, so no ambient/sound track is requested here either.
          sound: false,
          duration: input.durationSeconds,
        },
      }),
    })

    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new ProviderCallError('kie', res.status, detail)
    }

    const data = (await res.json()) as { code?: number; msg?: string; data?: { taskId?: string } }
    const taskId = data.data?.taskId
    if (data.code !== 200 || !taskId) {
      throw new ProviderCallError('kie', res.status, data.msg ?? 'response had no data.taskId')
    }

    return { providerRef: taskId }
  }

  async poll(jobRef: VideoJobRef): Promise<VideoPollResult> {
    const res = await this.fetchImpl(
      `${this.baseUrl}/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(jobRef.providerRef)}`,
      { headers: { Authorization: `Bearer ${this.apiKey}` } },
    )

    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new ProviderCallError('kie', res.status, detail)
    }

    const data = (await res.json()) as {
      data?: {
        state?: 'waiting' | 'queuing' | 'generating' | 'success' | 'fail'
        resultJson?: string
        failMsg?: string
      }
    }
    const inner = data.data

    if (inner?.state === 'success') {
      let resultUrls: string[] | undefined
      try {
        resultUrls = inner.resultJson ? (JSON.parse(inner.resultJson) as { resultUrls?: string[] }).resultUrls : undefined
      } catch {
        // fall through to the "missing" failure below
      }
      const fileUrl = resultUrls?.[0]
      if (!fileUrl) {
        return { status: 'failed', detail: 'state=success but resultJson had no resultUrls[0]' }
      }
      return { status: 'ready', fileUrl }
    }
    if (inner?.state === 'fail') {
      return { status: 'failed', detail: inner.failMsg ?? 'unknown KIE.ai failure' }
    }
    // 'waiting' | 'queuing' | 'generating'
    return { status: 'pending' }
  }
}
