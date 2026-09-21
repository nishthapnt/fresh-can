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
        model: input.model ?? 'gpt-4o-mini',
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
const IMAGE_VALIDATION_SYSTEM_PROMPT =
  'You are a strict visual QA checker for AI-generated marketing images. Check ONLY for these high-value ' +
  'defects: unexpected or extra people, unexplained/disembodied hands or arms, duplicate limbs, a floating ' +
  'or unexplained object, a missing required subject, a major inconsistency with the described objects, or ' +
  'an obviously illogical scene. Ignore minor stylistic, lighting, or composition preferences — those are ' +
  'not defects. Respond with strictly valid JSON: { "pass": boolean, "issues": string[] } — issues must be ' +
  'empty when pass is true; otherwise one short, specific phrase per real defect found (e.g. "unexplained ' +
  'hand on the right side of frame"), never a generic verdict.'

/**
 * Vision-capable QA gate (see ImageValidator's own header, adapters/types.ts)
 * — same provider/model family as OpenAIScriptGenerator above (gpt-4o-mini
 * supports image inputs via the same Chat Completions endpoint), so this
 * reuses the existing OpenAI credential/infrastructure rather than adding a
 * second vision provider.
 */
export class OpenAIImageValidator implements ImageValidator {
  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async validate(input: ImageValidationInput): Promise<ImageValidationResult> {
    const sceneText = `Scene: ${input.visualDescription}${input.shotNotes ? ` Shot notes: ${input.shotNotes}` : ''}`

    const res = await this.fetchImpl('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
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

    if (!parsed || typeof parsed !== 'object' || typeof (parsed as { pass?: unknown }).pass !== 'boolean') {
      // Fail OPEN, not closed — a malformed/unparseable validator response
      // (or a provider hiccup a caller chooses to swallow the same way)
      // must never itself block an otherwise-successful, already-paid-for
      // image from proceeding — this is a quality gate on top of a working
      // pipeline, never a new single point of failure for it.
      return { pass: true, issues: [] }
    }
    const p = parsed as { pass: boolean; issues?: unknown }
    return {
      pass: p.pass,
      issues: Array.isArray(p.issues) ? p.issues.filter((i): i is string => typeof i === 'string') : [],
    }
  }
}
