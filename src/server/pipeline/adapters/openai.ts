import {
  ProviderCallError,
  type ScriptGenerator,
  type ScriptGenerationInput,
  type ScriptGenerationResult,
  type ImageValidator,
  type ImageValidationInput,
  type ImageValidationResult,
} from './types'

// Models routinely wrap JSON answers in a Markdown code fence (```json ... ```)
// even when explicitly asked for "strictly valid JSON" — confirmed against
// the real API (gpt-4o-mini) during the Phase 2 e2e test run, where this
// caused JSON.parse to fail silently and finalize_draft to write a raw
// fenced string as content_drafts.draft_data instead of the expected
// post_title/content/seo fields. Stripping a wrapping fence before parsing
// fixes that without needing prompt-engineering to be perfectly reliable.
function stripCodeFence(text: string): string {
  const match = text.trim().match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/)
  return match ? match[1] : text
}

function safeJsonParse(text: string): unknown | null {
  try {
    return JSON.parse(stripCodeFence(text))
  } catch {
    return null
  }
}

/**
 * Real OpenAI Chat Completions call — this is a documented, stable API and
 * implemented here with confidence (unlike the KIE.ai adapter). Not yet
 * exercised against the live API in this session (no OPENAI_API_KEY
 * available) — unit-tested against a mocked fetch instead.
 */
export class OpenAIScriptGenerator implements ScriptGenerator {
  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async generate(input: ScriptGenerationInput): Promise<ScriptGenerationResult> {
    const res = await this.fetchImpl('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: input.model ?? 'gpt-4o',
        messages: [
          { role: 'system', content: input.systemPrompt },
          { role: 'user', content: input.userPrompt },
        ],
        // Every caller's system prompt already asks for "strictly valid
        // JSON" and describes the exact shape, but without this the model
        // is free to preface the JSON with conversational text (e.g. "Sure,
        // here's the script:") — stripCodeFence's anchored regex only
        // strips a fence wrapping the ENTIRE response, so any preamble
        // makes JSON.parse fail on the whole string, not just the fence.
        // Confirmed live: generate_script (the video scriptwriter prompt,
        // a more "creative writing" framing than blog/image's more
        // clinical prompts) hit exactly this failure mode 3 attempts in a
        // row. json_object mode makes the API itself guarantee a bare JSON
        // object — no prompt-engineering reliability needed.
        response_format: { type: 'json_object' },
      }),
    })

    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new ProviderCallError('openai', res.status, detail)
    }

    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[]
    }
    const content = data.choices?.[0]?.message?.content
    if (typeof content !== 'string') {
      throw new ProviderCallError('openai', res.status, 'response had no message content')
    }

    return { raw: content, parsed: safeJsonParse(content) }
  }
}

// Kept short and scoped to the exact high-value defect classes this gate
// exists for — a longer, exhaustive checklist would just make the model
// nitpick minor stylistic/lighting issues that were never the problem (see
// generateSceneVisual.ts's own header for why this is deliberately narrow).
//
// Revised 2026-09-23 to cut false positives: every rejection costs a paid
// KIE regeneration, and real data showed the old prompt flagging
// "unexplained hand on the left side of frame" on scenes whose own
// description REQUIRES hands (tapping a phone, picking produce, cooking,
// reading a note). Hands the scene implies are now explicitly allowed, and
// each issue carries a severity + confidence so only a clear, blocking
// defect rejects the image (see isRejectingIssue below).
const IMAGE_VALIDATION_SYSTEM_PROMPT =
  'You are a visual QA checker for AI-generated marketing images. Each rejection triggers a paid ' +
  'regeneration, so only report defects a typical viewer would clearly notice. Check ONLY for: an extra ' +
  'person not implied by the scene, a hand or arm that clearly belongs to no visible or implied person ' +
  '(disembodied, floating, or coming out of an impossible place), duplicate or malformed limbs on one ' +
  'person, a floating or impossible object, a required subject missing entirely, or an obviously ' +
  'illogical scene. NOT defects: hands or arms of a visible person, or hands implied by the described ' +
  'action (holding, tapping, picking up, cooking, reading, eating, first-person or over-the-shoulder ' +
  'framing) even when the rest of the body is cropped out of frame; any person the scene describes ' +
  '(e.g. a vendor, a friend); and any stylistic, lighting, or composition preference. ' +
  'Respond with strictly valid JSON: { "issues": [ { "text": string, "severity": "blocking" | "minor", ' +
  '"confidence": "high" | "medium" | "low" } ] } — an empty array when there are no defects. "text" is one ' +
  'short, specific phrase (e.g. "disembodied hand floating above the counter"), never a generic verdict. ' +
  'Use "blocking" only for a defect that would make the image unusable in a professional ad; use "high" ' +
  'confidence only when the defect is unambiguous, not merely possible.'

// Only a blocking, high-confidence issue rejects an image — anything
// softer is kept for observability (ImageValidationResult.ignoredIssues)
// but never spends another KIE generation.
function isRejectingIssue(issue: { severity?: unknown; confidence?: unknown }): boolean {
  return issue.severity === 'blocking' && issue.confidence === 'high'
}

/**
 * Vision-capable QA gate (see ImageValidator's own header, adapters/types.ts)
 * — same provider as OpenAIScriptGenerator above, reusing the existing
 * OpenAI credential/infrastructure rather than adding a second vision
 * provider. Uses gpt-4o rather than gpt-4o-mini (changed 2026-09-23): a
 * false positive here costs a paid KIE image, which is far more than the
 * difference in OpenAI cost for one vision call per scene.
 */
export class OpenAIImageValidator implements ImageValidator {
  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async validate(input: ImageValidationInput): Promise<ImageValidationResult> {
    const sceneText =
      'Scene description (the people, objects, and actions it names are expected, not defects): ' +
      `${input.visualDescription}${input.shotNotes ? ` Shot notes: ${input.shotNotes}` : ''}`

    const res = await this.fetchImpl('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: IMAGE_VALIDATION_SYSTEM_PROMPT },
          {
            role: 'user',
            content: [
              { type: 'text', text: sceneText },
              { type: 'image_url', image_url: { url: input.imageUrl } },
            ],
          },
        ],
        response_format: { type: 'json_object' },
      }),
    })

    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new ProviderCallError('openai', res.status, detail)
    }

    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[]
    }
    const content = data.choices?.[0]?.message?.content
    const parsed = typeof content === 'string' ? safeJsonParse(content) : null

    const rawIssues = parsed && typeof parsed === 'object' ? (parsed as { issues?: unknown }).issues : undefined
    if (!Array.isArray(rawIssues)) {
      // Fail OPEN, not closed — a malformed/unparseable validator response
      // (or a provider hiccup a caller chooses to swallow the same way)
      // must never itself block an otherwise-successful, already-paid-for
      // image from proceeding — this is a quality gate on top of a working
      // pipeline, never a new single point of failure for it.
      return { pass: true, issues: [] }
    }

    const issues: string[] = []
    const ignoredIssues: string[] = []
    for (const item of rawIssues) {
      // A bare string (old response shape) carries no severity/confidence,
      // so it can't meet the rejection bar — logged, never acted on.
      if (typeof item === 'string') {
        ignoredIssues.push(item)
        continue
      }
      if (!item || typeof item !== 'object') continue
      const issue = item as { text?: unknown; severity?: unknown; confidence?: unknown }
      if (typeof issue.text !== 'string' || !issue.text.trim()) continue
      if (isRejectingIssue(issue)) issues.push(issue.text)
      else ignoredIssues.push(`${issue.text} (${String(issue.severity)}, ${String(issue.confidence)} confidence)`)
    }

    return { pass: issues.length === 0, issues, ...(ignoredIssues.length ? { ignoredIssues } : {}) }
  }
}
