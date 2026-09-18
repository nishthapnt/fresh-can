import {
  ProviderCallError,
  type TranscriptionService,
  type TranscriptionInput,
  type TranscriptionJobRef,
  type TranscriptionPollResult,
} from './types'

/**
 * AssemblyAI transcription — async submit + poll. Confirmed against
 * assemblyai.com/docs (Submit a transcription request: POST /v2/transcript;
 * Get a transcription: GET /v2/transcript/{id}) 2026-09-12. Used here for
 * caption timing, not for the transcript text itself (the words are already
 * known from localize_script's output — this call is only to time them).
 */
export class AssemblyAITranscriptionService implements TranscriptionService {
  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly baseUrl: string = 'https://api.assemblyai.com',
  ) {}

  async submit(input: TranscriptionInput): Promise<TranscriptionJobRef> {
    const res = await this.fetchImpl(`${this.baseUrl}/v2/transcript`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        authorization: this.apiKey,
      },
      body: JSON.stringify({ audio_url: input.audioUrl }),
    })

    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new ProviderCallError('assemblyai', res.status, detail)
    }

    const data = (await res.json()) as { id?: string; error?: string }
    if (!data.id) {
      throw new ProviderCallError('assemblyai', res.status, data.error ?? 'response had no id')
    }

    return { providerRef: data.id }
  }

  async poll(jobRef: TranscriptionJobRef): Promise<TranscriptionPollResult> {
    const res = await this.fetchImpl(
      `${this.baseUrl}/v2/transcript/${encodeURIComponent(jobRef.providerRef)}`,
      { headers: { authorization: this.apiKey } },
    )

    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new ProviderCallError('assemblyai', res.status, detail)
    }

    const data = (await res.json()) as {
      status?: 'queued' | 'processing' | 'completed' | 'error'
      error?: string
      text?: string
      words?: unknown
    }

    if (data.status === 'completed') {
      return { status: 'ready', timingData: data.words ?? [], text: data.text ?? '' }
    }
    if (data.status === 'error') {
      return { status: 'failed', detail: data.error ?? 'unknown AssemblyAI failure' }
    }
    // 'queued' | 'processing'
    return { status: 'pending' }
  }
}
