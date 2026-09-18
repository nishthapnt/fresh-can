import { describe, it, expect, vi } from 'vitest'
import { OpenAIScriptGenerator } from './openai'
import { ProviderCallError } from './types'

function mockFetch(response: Partial<Response> & { jsonBody?: unknown; textBody?: string }) {
  return vi.fn(async () => ({
    ok: response.ok ?? true,
    status: response.status ?? 200,
    json: async () => response.jsonBody,
    text: async () => response.textBody ?? '',
  })) as unknown as typeof fetch
}

describe('OpenAIScriptGenerator', () => {
  it('sends the system/user prompt and returns raw + parsed JSON content', async () => {
    const fetchImpl = mockFetch({
      jsonBody: { choices: [{ message: { content: '{"title":"hello"}' } }] },
    })
    const gen = new OpenAIScriptGenerator('test-key', fetchImpl)
    const result = await gen.generate({ systemPrompt: 'sys', userPrompt: 'user' })

    expect(result.raw).toBe('{"title":"hello"}')
    expect(result.parsed).toEqual({ title: 'hello' })

    const [url, options] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(url).toBe('https://api.openai.com/v1/chat/completions')
    expect((options.headers as Record<string, string>).Authorization).toBe('Bearer test-key')
    const body = JSON.parse(options.body as string)
    expect(body.messages).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'user' },
    ])
    // Forces the API to guarantee a bare JSON object — the actual fix for a
    // live failure where the model prefaced JSON with conversational text,
    // which stripCodeFence's anchored regex can't recover from (see its
    // own doc comment) since it only strips a fence wrapping the ENTIRE
    // response.
    expect(body.response_format).toEqual({ type: 'json_object' })
  })

  it('returns parsed: null when content is not valid JSON', async () => {
    const fetchImpl = mockFetch({
      jsonBody: { choices: [{ message: { content: 'not json' } }] },
    })
    const gen = new OpenAIScriptGenerator('test-key', fetchImpl)
    const result = await gen.generate({ systemPrompt: 'sys', userPrompt: 'user' })

    expect(result.raw).toBe('not json')
    expect(result.parsed).toBeNull()
  })

  it('parses JSON wrapped in a ```json Markdown code fence (real gpt-4o-mini behavior)', async () => {
    const fenced = '```json\n{"post_title":"hello"}\n```'
    const fetchImpl = mockFetch({
      jsonBody: { choices: [{ message: { content: fenced } }] },
    })
    const gen = new OpenAIScriptGenerator('test-key', fetchImpl)
    const result = await gen.generate({ systemPrompt: 'sys', userPrompt: 'user' })

    expect(result.raw).toBe(fenced)
    expect(result.parsed).toEqual({ post_title: 'hello' })
  })

  it('parses JSON wrapped in a bare ``` code fence (no "json" language tag)', async () => {
    const fenced = '```\n{"post_title":"hello"}\n```'
    const fetchImpl = mockFetch({
      jsonBody: { choices: [{ message: { content: fenced } }] },
    })
    const gen = new OpenAIScriptGenerator('test-key', fetchImpl)
    const result = await gen.generate({ systemPrompt: 'sys', userPrompt: 'user' })

    expect(result.parsed).toEqual({ post_title: 'hello' })
  })

  it('throws ProviderCallError on a non-ok HTTP response', async () => {
    const fetchImpl = mockFetch({ ok: false, status: 429, textBody: 'rate limited' })
    const gen = new OpenAIScriptGenerator('test-key', fetchImpl)

    await expect(gen.generate({ systemPrompt: 'sys', userPrompt: 'user' })).rejects.toThrow(
      ProviderCallError,
    )
  })

  it('throws ProviderCallError when the response has no message content', async () => {
    const fetchImpl = mockFetch({ jsonBody: { choices: [{}] } })
    const gen = new OpenAIScriptGenerator('test-key', fetchImpl)

    await expect(gen.generate({ systemPrompt: 'sys', userPrompt: 'user' })).rejects.toThrow(
      ProviderCallError,
    )
  })
})
