import {
  ProviderCallError,
  type ImageGenerator,
  type ImageGenerationInput,
  type ImageJobRef,
  type ImagePollResult,
} from './types'
import { kieSubmitLimiter } from '../lib/kieRateLimiter'

/**
 * KIE.ai `nano-banana-2` — a different underlying model than Flux Kontext,
 * reached through a different KIE endpoint shape (jobs/createTask +
 * jobs/recordInfo, not flux/kontext/*). Originally adopted for
 * image_style: 'infographic' — confirmed live (2026-09-10) that this model
 * renders headline/subtitle/CTA-bar text onto an image correctly, where
 * Flux Kontext reliably garbles the same kind of text (see
 * prompts/brand/fresh-can.ts's incident notes on the infographic style
 * that was tried and removed) — then made the PERMANENT image generator
 * for all three content types (2026-09-23): blog hero/inline, image_post
 * 'photo' and 'infographic' styles, and video's character-ref/scene
 * images all route through this class now. adapters/kie.ts's
 * KieImageGenerator (Flux Kontext) is no longer wired into any pipeline as
 * a result — kept for potential future reuse, not dead code to delete.
 * Implements the same ImageGenerator interface as KieImageGenerator so
 * callers don't need to know which underlying model they're talking to.
 *
 * aspectRatio bug fixed 2026-09-23: this class was sending
 * `image_size: '4:5'` (hardcoded, ignoring `input.aspectRatio` entirely).
 * Live-verified against the real API that `image_size` is silently
 * ignored — every image came back a plain 2048x2048 square regardless of
 * its value — while `aspect_ratio` is the real, respected param name
 * (verified live for '4:5', '9:16', and '1:1'). This means every blog
 * hero/inline and image_post photo generated before this fix was
 * secretly square, not 4:5 as the code always intended. Now fixed to send
 * `aspect_ratio: input.aspectRatio ?? '4:5'` — '4:5' stays the default for
 * blog/image_post (unchanged intent, now actually enforced), video always
 * passes its own aspectRatio explicitly (see ImageGenerationInput's own
 * doc comment in adapters/types.ts).
 */
export class NanoBananaImageGenerator implements ImageGenerator {
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
        model: 'nano-banana-2',
        input: {
          prompt: input.prompt,
          // 'aspect_ratio' (not 'image_size' — see this class's own header
          // for the live-verified fix). '4:5' remains the default for
          // callers that never set aspectRatio (blog/image_post); video
          // always passes its own '9:16'/'1:1'/'16:9'.
          aspect_ratio: input.aspectRatio ?? '4:5',
          ...(input.referenceImageUrl ? { image_input: [input.referenceImageUrl] } : {}),
        },
      }),
    })

    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new ProviderCallError('kie-nano-banana', res.status, detail)
    }

    const data = (await res.json()) as { code?: number; msg?: string; data?: { taskId?: string } }
    const taskId = data.data?.taskId
    if (data.code !== 200 || !taskId) {
      throw new ProviderCallError('kie-nano-banana', res.status, data.msg ?? 'response had no data.taskId')
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
      throw new ProviderCallError('kie-nano-banana', res.status, detail)
    }

    const data = (await res.json()) as {
      data?: { state?: string; resultJson?: string; errorMessage?: string | null }
    }
    const inner = data.data
    const state = inner?.state

    if (state === 'success') {
      let fileUrl: string | undefined
      try {
        const parsed = inner?.resultJson ? (JSON.parse(inner.resultJson) as { resultUrls?: string[] }) : undefined
        fileUrl = parsed?.resultUrls?.[0]
      } catch {
        // fall through — treated as failed below
      }
      if (!fileUrl) {
        return { status: 'failed', detail: 'state=success but resultJson had no resultUrls[0]' }
      }
      return { status: 'ready', fileUrl }
    }
    if (state === 'fail' || state === 'failed') {
      return { status: 'failed', detail: inner?.errorMessage ?? 'unknown KIE.ai (nano-banana-2) failure' }
    }
    return { status: 'pending' }
  }
}
