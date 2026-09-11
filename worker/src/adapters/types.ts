// Provider adapter interfaces — ARCHITECTURE.MD §8. Business logic (worker
// steps) depends only on these, never on a provider SDK/HTTP client directly.

export class ProviderCallError extends Error {
  constructor(
    public readonly provider: string,
    public readonly httpStatus: number | null,
    public readonly detail: string,
  ) {
    super(`${provider} call failed (status ${httpStatus ?? 'n/a'}): ${detail}`)
    this.name = 'ProviderCallError'
  }
}

export interface ScriptGenerationInput {
  systemPrompt: string
  userPrompt: string
  model?: string
}

export interface ScriptGenerationResult {
  raw: string
  /** Best-effort JSON.parse of `raw`; null if the model didn't return valid JSON. */
  parsed: unknown | null
}

export interface ScriptGenerator {
  generate(input: ScriptGenerationInput): Promise<ScriptGenerationResult>
}

export interface ImageGenerationInput {
  prompt: string
  /**
   * A real photo of the branded subject (e.g. the Fresh-CAN truck) for
   * Flux Kontext's image-editing mode — the model edits/extends from this
   * instead of hallucinating the truck's appearance from a text description
   * alone. Flux Kontext's `inputImage` field accepts exactly one URL (see
   * docs.kie.ai/flux-kontext-api/generate-or-edit-image, confirmed
   * 2026-09-10) — never an array.
   */
  referenceImageUrl?: string
}

export interface ImageJobRef {
  providerRef: string
}

export type ImagePollResult =
  | { status: 'ready'; fileUrl: string }
  | { status: 'pending' }
  | { status: 'failed'; detail: string }

export interface ImageGenerator {
  submit(input: ImageGenerationInput): Promise<ImageJobRef>
  poll(jobRef: ImageJobRef): Promise<ImagePollResult>
}
