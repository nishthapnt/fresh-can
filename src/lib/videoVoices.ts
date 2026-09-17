// Curated narration voice options for video jobs — deliberately a small,
// hand-picked list (not the full ElevenLabs voice library, which would be
// unwieldy to pick from and includes voices never vetted for this brand's
// use), 4 male + 4 female per language. `previewUrl` is ElevenLabs' own
// free, pre-generated sample for that voice (GET /v1/voices' preview_url
// field) — playing it directly costs nothing and needs no API call, unlike
// a live synthesize-on-demand preview.
//
// The first entry per language is today's hardcoded default
// (worker/src/prompts/brand/fresh-can.ts's videoVoiceIds) so an unedited
// job keeps producing exactly the same narration voice it always has.
//
// The account only owns two language-specific custom voices (the two
// defaults below — EN "Mr. Internatianil", FR "Christian Page V2", Quebec
// French). Every other slot is filled from the account's stock/premade
// voice library, which is English-labeled and has just 7 distinct female
// voices total — too few to keep EN and FR pools disjoint. The same 7
// non-default voices are reused for both languages rather than invented;
// this is safe because narration always renders through ElevenLabs'
// eleven_multilingual_v2 model (worker/src/adapters/elevenlabs.ts), which
// synthesizes EN and FR equally well from any voice regardless of its
// library language label.
export interface VideoVoiceOption {
  id: string
  name: string
  gender: 'male' | 'female'
  previewUrl: string
}

export const VIDEO_VOICES: Record<'EN' | 'FR', VideoVoiceOption[]> = {
  EN: [
    { id: 'epkQ8pqDcY2DxhmFi8xl', name: 'Current default (male)', gender: 'male', previewUrl: 'https://storage.googleapis.com/eleven-public-prod/database/workspace/9f451350024149bb8ffdad22ffd131e7/voices/epkQ8pqDcY2DxhmFi8xl/ISnzs529q1VwUgRPnLYz.mp3' },
    { id: 'TX3LPaxmHKxFdv7VOQHJ', name: 'Liam - Energetic, Social Media Creator', gender: 'male', previewUrl: 'https://storage.googleapis.com/eleven-public-prod/premade/voices/TX3LPaxmHKxFdv7VOQHJ/63148076-6363-42db-aea8-31424308b92c.mp3' },
    { id: 'iP95p4xoKVk53GoZ742B', name: 'Chris - Charming, Down-to-Earth', gender: 'male', previewUrl: 'https://storage.googleapis.com/eleven-public-prod/premade/voices/iP95p4xoKVk53GoZ742B/3f4bde72-cc48-40dd-829f-57fbf906f4d7.mp3' },
    { id: 'onwK4e9ZLuTAKqWW03F9', name: 'Daniel - Steady Broadcaster', gender: 'male', previewUrl: 'https://api.us.elevenlabs.io/v1/voices/onwK4e9ZLuTAKqWW03F9/previews/audio?payload=eyJ2b2ljZV9zb3VyY2UiOiJwcmVtYWRlIiwiZmlsZW5hbWUiOiI3ZWVlMDIzNi0xYTcyLTRiODYtYjMwMy01ZGNhZGMwMDdiYTkubXAzIiwidGltZXN0YW1wIjoxNzg5NDQ4NDAwMDAwMDAwfQ%3D%3D' },
    { id: 'EXAVITQu4vr4xnSDxMaL', name: 'Sarah - Mature, Reassuring, Confident', gender: 'female', previewUrl: 'https://storage.googleapis.com/eleven-public-prod/premade/voices/EXAVITQu4vr4xnSDxMaL/01a3e33c-6e99-4ee7-8543-ff2216a32186.mp3' },
    { id: 'cgSgspJ2msm6clMCkdW9', name: 'Jessica - Playful, Bright, Warm', gender: 'female', previewUrl: 'https://storage.googleapis.com/eleven-public-prod/premade/voices/cgSgspJ2msm6clMCkdW9/56a97bf8-b69b-448f-846c-c3a11683d45a.mp3' },
    { id: 'Xb7hH8MSUJpSbSDYk0k2', name: 'Alice - Clear, Engaging Educator', gender: 'female', previewUrl: 'https://storage.googleapis.com/eleven-public-prod/premade/voices/Xb7hH8MSUJpSbSDYk0k2/d10f7534-11f6-41fe-a012-2de1e482d336.mp3' },
    { id: 'hpp4J3VqNfWAUOO0d1Us', name: 'Bella - Professional, Bright, Warm', gender: 'female', previewUrl: 'https://storage.googleapis.com/eleven-public-prod/premade/voices/hpp4J3VqNfWAUOO0d1Us/dab0f5ba-3aa4-48a8-9fad-f138fea1126d.mp3' },
  ],
  FR: [
    { id: 'n2pCwUKS6q9Iur03Rten', name: 'Current default (male)', gender: 'male', previewUrl: 'https://storage.googleapis.com/eleven-public-prod/database/workspace/447660a0d48745be9f618782b9398f9b/voices/n2pCwUKS6q9Iur03Rten/5fS0nWB0dDTV9E21JUvf.mp3' },
    { id: 'TX3LPaxmHKxFdv7VOQHJ', name: 'Liam - Energetic, Social Media Creator', gender: 'male', previewUrl: 'https://storage.googleapis.com/eleven-public-prod/premade/voices/TX3LPaxmHKxFdv7VOQHJ/63148076-6363-42db-aea8-31424308b92c.mp3' },
    { id: 'iP95p4xoKVk53GoZ742B', name: 'Chris - Charming, Down-to-Earth', gender: 'male', previewUrl: 'https://storage.googleapis.com/eleven-public-prod/premade/voices/iP95p4xoKVk53GoZ742B/3f4bde72-cc48-40dd-829f-57fbf906f4d7.mp3' },
    { id: 'onwK4e9ZLuTAKqWW03F9', name: 'Daniel - Steady Broadcaster', gender: 'male', previewUrl: 'https://api.us.elevenlabs.io/v1/voices/onwK4e9ZLuTAKqWW03F9/previews/audio?payload=eyJ2b2ljZV9zb3VyY2UiOiJwcmVtYWRlIiwiZmlsZW5hbWUiOiI3ZWVlMDIzNi0xYTcyLTRiODYtYjMwMy01ZGNhZGMwMDdiYTkubXAzIiwidGltZXN0YW1wIjoxNzg5NDQ4NDAwMDAwMDAwfQ%3D%3D' },
    { id: 'EXAVITQu4vr4xnSDxMaL', name: 'Sarah - Mature, Reassuring, Confident', gender: 'female', previewUrl: 'https://storage.googleapis.com/eleven-public-prod/premade/voices/EXAVITQu4vr4xnSDxMaL/01a3e33c-6e99-4ee7-8543-ff2216a32186.mp3' },
    { id: 'cgSgspJ2msm6clMCkdW9', name: 'Jessica - Playful, Bright, Warm', gender: 'female', previewUrl: 'https://storage.googleapis.com/eleven-public-prod/premade/voices/cgSgspJ2msm6clMCkdW9/56a97bf8-b69b-448f-846c-c3a11683d45a.mp3' },
    { id: 'Xb7hH8MSUJpSbSDYk0k2', name: 'Alice - Clear, Engaging Educator', gender: 'female', previewUrl: 'https://storage.googleapis.com/eleven-public-prod/premade/voices/Xb7hH8MSUJpSbSDYk0k2/d10f7534-11f6-41fe-a012-2de1e482d336.mp3' },
    { id: 'hpp4J3VqNfWAUOO0d1Us', name: 'Bella - Professional, Bright, Warm', gender: 'female', previewUrl: 'https://storage.googleapis.com/eleven-public-prod/premade/voices/hpp4J3VqNfWAUOO0d1Us/dab0f5ba-3aa4-48a8-9fad-f138fea1126d.mp3' },
  ],
}

// The voice used today, before this feature existed — kept as its own
// constant (rather than reaching into VIDEO_VOICES[0]) so the form's
// default doesn't silently change if the curated list's ordering ever does.
export const DEFAULT_VOICE_ID: Record<'EN' | 'FR', string> = {
  EN: 'epkQ8pqDcY2DxhmFi8xl',
  FR: 'n2pCwUKS6q9Iur03Rten',
}
