import {
  ProviderCallError,
  type ImageGenerator,
  type ImageGenerationInput,
  type ImageJobRef,
  type ImagePollResult,
} from './types.js'
import { kieSubmitLimiter } from '../lib/kieRateLimiter.js'

/**
 * KIE.ai `nano-banana-2` — a different underlying model than Flux Kontext,
 * reached through a different KIE endpoint shape (jobs/createTask +
 * jobs/recordInfo, not flux/kontext/*). Used specifically for
 * image_style: 'infographic' — confirmed live (2026-09-10) that this model
 * renders headline/subtitle/logo/CTA-bar text onto an image correctly,
 * where Flux Kontext reliably garbles the same kind of text (see
 * prompts/brand/fresh-can.ts's incident notes on the infographic style
 * that was tried and removed). Implements the same ImageGenerator
 * interface as KieImageGenerator so callers don't need to know which
 * underlying model they're talking to.
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
          image_size: '4:5',
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
