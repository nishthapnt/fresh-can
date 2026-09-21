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
} from './types'
import { kieSubmitLimiter } from '../lib/kieRateLimiter'

/**
 * KIE.ai image generation — Flux Kontext submit + poll, verified against the
 * real API reference at docs.kie.ai/flux-kontext-api (generate-or-edit-image,
 * get-image-details) on 2026-09-09. Replaces an earlier best-effort guess
 * (`/v1/images`) that 404'd against the live API — see git history for that
 * version if you need to compare.
 *
 * Shared across video's character_ref, and blog/image_post's 'photo'-style
 * visuals (worker/src/index.ts's imageGeneratorFor) — never repoint this
 * class at a cheaper model to save credits on ONE of those callers without
 * checking the others. video's per-scene images use the cheaper, narrower
 * KieSceneImageGenerator below instead of touching this class, specifically
 * to keep that blast radius contained (see its own header for why).
 */
export class KieImageGenerator implements ImageGenerator {
  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly baseUrl: string = 'https://api.kie.ai',
  ) {}

  async submit(input: ImageGenerationInput): Promise<ImageJobRef> {
    await kieSubmitLimiter.acquire()
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
 * TEST-CHEAP MODE (2026-09-17) — video's per-scene image generation only.
 * Routes Flux Kontext through the unified Market job endpoints (POST
 * /api/v1/jobs/createTask, GET /api/v1/jobs/recordInfo — same endpoints
 * KieVideoGenerator/NanoBananaImageGenerator already use) with
 * `model: 'flux1-kontext'`, instead of KieImageGenerator's dedicated
 * /api/v1/flux/kontext/generate endpoint.
 *
 * Same underlying FLUX.1 Kontext model and same aspect_ratio/
 * reference-image behavior — confirmed via KIE's own
 * recordInfo.creditsConsumed to cost 5 credits/image here versus ~55
 * credits/image measured on KieImageGenerator's dedicated endpoint.
 *
 * NOT a drop-in replacement for KieImageGenerator in general: this unified
 * endpoint enforces a prompt-length cap KieImageGenerator's dedicated
 * endpoint doesn't. Confirmed live (2026-09-17): composeSceneImagePrompt's
 * ~500-600 char output submits fine here, but composeCharacterRefPrompt's
 * ~1300 char output (it embeds the full brand containerDescriptor)
 * hard-fails with "The text length cannot exceed the maximum limit" — so
 * this class is wired ONLY to generateSceneVisual.ts's scene_image step in
 * worker/src/index.ts, never to generateCharacterRef.ts, blog, or
 * image_post, all three of which keep using KieImageGenerator.
 *
 * NOT necessarily the right choice for production — this exists so testing
 * the pipeline doesn't burn ~55 credits per scene image. Point
 * generateSceneVisual.ts back at a KieImageGenerator instance (git history
 * had it sharing one with generateCharacterRef.ts) for production output.
 */
export class KieSceneImageGenerator implements ImageGenerator {
  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly baseUrl: string = 'https://api.kie.ai',
  ) {}

  async submit(input: ImageGenerationInput): Promise<ImageJobRef> {
    await kieSubmitLimiter.acquire()
    const res = await this.fetchImpl(`${this.baseUrl}/api/v1/jobs/createTask`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: 'flux1-kontext',
        input: {
          prompt: input.prompt,
          aspect_ratio: input.aspectRatio ?? '1:1',
          ...(input.referenceImageUrl ? { image_urls: [input.referenceImageUrl] } : {}),
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

  async poll(jobRef: ImageJobRef): Promise<ImagePollResult> {
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
        failMsg?: string | null
      }
    }
    const inner = data.data

    if (inner?.state === 'success') {
      let fileUrl: string | undefined
      try {
        const parsed = inner.resultJson ? (JSON.parse(inner.resultJson) as { resultUrls?: string[] }) : undefined
        fileUrl = parsed?.resultUrls?.[0]
      } catch {
        // fall through — treated as failed below
      }
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

/**
 * KIE.ai scene video-clip generation — Bytedance Seedance 1.5 Pro
 * image-to-video, the production model, via the unified Market job
 * endpoints (POST /api/v1/jobs/createTask, GET /api/v1/jobs/recordInfo),
 * verified against docs.kie.ai/market/bytedance/seedance-1-5-pro on
 * 2026-09-21. `referenceImageUrl` is always the scene's already-generated
 * scene_image — this is what keeps the character/likeness consistent
 * (Seedance animates from that one locked frame, passed as `input_urls[0]`;
 * it never regenerates the subject's appearance independently), so a caller
 * must never pass a bare text-only prompt with no image here.
 *
 * Swapped 2026-09-21 from Kling 2.6 (`kling-2.6/image-to-video`) to
 * Seedance 1.5 Pro. Field-level differences from the Kling call this
 * replaces: `input_urls` (plural array, same as Kling's `image_urls`) not
 * `image_url`; `generate_audio: false` not `sound: false`; `duration` is a
 * plain number (Seedance accepts 4-12s) rather than the '5'|'10' string
 * Kling required — `input.durationSeconds` is still bucketed to '5'/'10' by
 * lib/sceneClipDuration.ts (kept as-is per that function's own header) and
 * just gets Number()-coerced here. Unlike Kling, Seedance's `aspect_ratio`
 * is a required input field rather than something it infers from the
 * reference frame's own shape — threaded through from the same
 * content_jobs.aspect_ratio value already used for the character-ref/
 * scene-image generation, so both stay in sync.
 *
 * Confirmed NOT safe to assume (2026-09-21, same day): Seedance does NOT
 * reliably render at exactly the requested `duration` the way Kling/Hailuo
 * did — a real render showed caption/audio desync traced to exactly that,
 * because renderLanguageTrack.ts/avMerger.ts's buildSceneDurationMatchCommand
 * used to assume the clip's real length matched what was requested here.
 * Fixed the same day by no longer assuming it anywhere downstream — see
 * buildSceneDurationMatchCommand's header (avMerger.ts) for the actual fix
 * and sceneClipDuration.ts's header for what pickClipDurationSeconds is
 * (and is no longer) used for.
 *
 * `resolution: '720p'` is set explicitly (2026-09-21) to keep Seedance's
 * per-clip cost at or below Kling's. Unlike Kling, Seedance bills by
 * resolution x duration (tokens = height x width x 24fps x duration / 1024,
 * $1.2/million tokens with audio off — derived from fal.ai's published rate
 * for the same underlying model, NOT independently confirmed against
 * kie.ai's own dashboard). At 720p a no-audio clip is roughly 47% of
 * Kling's per-clip cost at both 5s and 10s; 1080p (this pipeline's actual
 * delivery resolution, ASPECT_RATIO_RESOLUTIONS in videoResolution.ts)
 * would be roughly break-even at 5s but ~6% MORE than Kling at 10s, so it
 * doesn't reliably satisfy "same or less." The trade-off: Kling's native
 * output already landed near the 1080x1920 delivery target (so
 * SceneClipScaler only ever downscaled slightly), but Seedance at 720p
 * natively outputs ~720x1280 — below that target — so every clip now gets
 * UPSCALED to delivery resolution instead, which will look softer than
 * Kling's clips did. Watch the first real renders for visible softness
 * before assuming this trade-off is acceptable at scale; bump back to
 * `1080p` here if it isn't.
 *
 * Reverted 2026-09-19 back from a 2026-09-17 TEST-CHEAP MODE swap to Hailuo
 * 02 Standard (`hailuo/02-image-to-video-standard`, 512P, `image_url`
 * singular, 2 credits/second) — that existed purely to avoid burning 55
 * credits/clip while testing the pipeline, at the cost of visibly lower
 * resolution than Kling's HD output; not appropriate once testing is done.
 * If cheap-mode testing is needed again: `model: 'hailuo/02-image-to-video-
 * standard'`, `input: { prompt, image_url: referenceImageUrl, duration:
 * durationSeconds === '5' ? 6 : 10, resolution: '512P' }` (git history) —
 * note Hailuo rejects `duration: 5` outright and needs that remap, and
 * takes `image_url` singular where Kling/Seedance take the plural array
 * form (400s on the singular form).
 */
export class KieVideoGenerator implements VideoGenerator {
  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly baseUrl: string = 'https://api.kie.ai',
  ) {}

  async submit(input: VideoGenerationInput): Promise<VideoJobRef> {
    await kieSubmitLimiter.acquire()
    const res = await this.fetchImpl(`${this.baseUrl}/api/v1/jobs/createTask`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: 'bytedance/seedance-1.5-pro',
        input: {
          prompt: input.prompt,
          input_urls: [input.referenceImageUrl],
          aspect_ratio: input.aspectRatio,
          // Cost lever, not a quality default — see this class's header for
          // the per-resolution cost math and the upscale trade-off it buys.
          resolution: '720p',
          // Narration audio is composited separately at render time
          // (avMerger.ts) — this call never carries the language-specific
          // narration, so no ambient/audio track is requested here either.
          generate_audio: false,
          duration: Number(input.durationSeconds),
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
