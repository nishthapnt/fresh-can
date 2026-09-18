// Shared parsing for the two step outputs shaped like { headline, subtitle }
// — blog's generate_outline and image_post's generate_ad_copy — so both
// index.ts (which builds image prompts from either) and generateCaption.ts
// (which reads generate_ad_copy's output to stay cohesive with it) use one
// tolerant extraction instead of two slightly-different copies.
export interface ParsedAdCopy {
  headline: string
  subtitle: string
  /** Only ever present on generate_ad_copy's output — generate_outline's
   *  shape doesn't include it. Empty string when absent. */
  coreMessage: string
}

/**
 * Falls back to the given plain values if the model omitted a field, or the
 * step hasn't succeeded yet (output is null) — so nothing downstream is ever
 * blocked waiting on a well-formed LLM response.
 */
export function parseAdCopy(
  output: unknown,
  fallbackHeadline: string,
  fallbackSubtitle: string,
): ParsedAdCopy {
  const obj = output as { headline?: unknown; subtitle?: unknown; coreMessage?: unknown } | null
  const headline =
    typeof obj?.headline === 'string' && obj.headline.trim() ? obj.headline.trim() : fallbackHeadline
  const subtitle =
    typeof obj?.subtitle === 'string' && obj.subtitle.trim() ? obj.subtitle.trim() : fallbackSubtitle
  const coreMessage = typeof obj?.coreMessage === 'string' ? obj.coreMessage.trim() : ''
  return { headline, subtitle, coreMessage }
}

/** Deterministic, no-LLM-call fallback headline — used only when a real
 *  model-authored one isn't available yet (see parseAdCopy call sites):
 *  blog's generate_outline output missing the field, or image_post falling
 *  back before generate_ad_copy exists for a 'photo'-style job (which never
 *  calls it, since there's no on-image text to derive). */
export function deriveHeadline(topic: string): string {
  return topic.trim().split(/\s+/).filter(Boolean).slice(0, 6).join(' ')
}
