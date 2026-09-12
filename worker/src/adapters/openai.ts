import {
  ProviderCallError,
  type ScriptGenerator,
  type ScriptGenerationInput,
  type ScriptGenerationResult,
} from './types.js'

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
