import {
  ProviderCallError,
  type VoiceSynthesizer,
  type VoiceSynthesisInput,
  type VoiceSynthesisResult,
} from './types'

/**
 * ElevenLabs text-to-speech — synchronous: the response body IS the audio
 * (mpeg bytes), not a job id. Confirmed against elevenlabs.io/docs
 * (Text-to-Speech, POST /v1/text-to-speech/{voice_id}) 2026-09-12.
 */
export class ElevenLabsVoiceSynthesizer implements VoiceSynthesizer {
  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly baseUrl: string = 'https://api.elevenlabs.io',
  ) {}

  async synthesize(input: VoiceSynthesisInput): Promise<VoiceSynthesisResult> {
    const res = await this.fetchImpl(
      `${this.baseUrl}/v1/text-to-speech/${encodeURIComponent(input.voiceId)}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'xi-api-key': this.apiKey,
        },
        body: JSON.stringify({
          text: input.text,
          model_id: 'eleven_multilingual_v2', // supports EN and FR from one model
        }),
      },
    )

    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new ProviderCallError('elevenlabs', res.status, detail)
    }

    const audioBuffer = Buffer.from(await res.arrayBuffer())
    if (audioBuffer.byteLength === 0) {
      throw new ProviderCallError('elevenlabs', res.status, 'response body was empty')
    }

    const providerRef = res.headers.get('request-id') ?? `elevenlabs-${Date.now()}`
    return { audioBuffer, providerRef }
  }
}
