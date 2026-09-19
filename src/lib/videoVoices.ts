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
// FR fixed 2026-09-19: this list used to reuse the SAME 7 English premade
// voice IDs (Liam, Chris, Daniel, Sarah, Jessica, Alice, Bella — all
// English-labeled, `language: 'en'`) for both EN and FR, on the reasoning
// that the account's own /v1/voices library only has ONE real French voice
// (the existing default below) and eleven_multilingual_v2 can technically
// narrate French from an English voice. That's true, but it's not the same
// as an actual FRENCH voice, and it's what "the French voices are English
// only" was reporting. Replaced with 7 genuine `language: 'fr'` voices
// pulled from ElevenLabs' shared voice library (GET /v1/shared-voices?
// language=fr) — confirmed live that a shared-library voice_id works
// directly in /v1/text-to-speech with no "add to my voices" step needed
// first, so no ElevenLabs account changes were required for this fix.
// Prioritized `accent: 'quebec'` candidates over standard/Parisian French
// where a good one existed, to match Fresh-CAN's own Canadian setting
// (missionStatement/voiceGuidelines) and the existing default voice, which
// is itself Quebec French.
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
    { id: 'n2pCwUKS6q9Iur03Rten', name: 'Current default (male, Québec)', gender: 'male', previewUrl: 'https://storage.googleapis.com/eleven-public-prod/database/workspace/447660a0d48745be9f618782b9398f9b/voices/n2pCwUKS6q9Iur03Rten/5fS0nWB0dDTV9E21JUvf.mp3' },
    { id: 'OHqYMl9NiX64DHfebC8X', name: 'Marc André - Calm, Charismatic, Canadian', gender: 'male', previewUrl: 'https://api.us.elevenlabs.io/v1/voices/OHqYMl9NiX64DHfebC8X/previews/audio?payload=eyJ2b2ljZV9zb3VyY2UiOiJjdXN0b20iLCJ3b3Jrc3BhY2VfaWQiOiIxY2U2ODcwYWI2YzY0OTIyYjExYmU4NDRiYmEwYmMyNiIsImZpbGVuYW1lIjoiZmFmZDhmM2UtZmY4NC00MDFkLWJlYTQtZmY4MzQ4ZWQzMjBiLm1wMyIsInRpbWVzdGFtcCI6MTc4OTgxMjAwMDAwMDAwMH0%3D' },
    { id: 'nXbV1oNjVZJeyUXiHwTn', name: 'Pascal - Warm Quebec', gender: 'male', previewUrl: 'https://api.us.elevenlabs.io/v1/voices/nXbV1oNjVZJeyUXiHwTn/previews/audio?payload=eyJ2b2ljZV9zb3VyY2UiOiJjdXN0b20iLCJ3b3Jrc3BhY2VfaWQiOiIyNTRkMjZlMTk2NzA0ODkzYWRhYWNiOTgwOGQzMmFmYiIsImZpbGVuYW1lIjoiNXVRT3lkTFJPSVNyQUd3Q21ZREYubXAzIiwidGltZXN0YW1wIjoxNzg5ODEyMDAwMDAwMDAwfQ%3D%3D' },
    { id: 'EAhzpkWim8EBTKok47fw', name: 'Jean-François - Confident', gender: 'male', previewUrl: 'https://storage.googleapis.com/eleven-public-prod/database/user/yhamPBrw4dgbJkTtwBjPMmWNjc53/voices/EAhzpkWim8EBTKok47fw/mnaDnRACMoPZioHs5p5L.mp3' },
    { id: 'bBRsDJSAcL1ubkrtJ3hM', name: 'Caroline - Soft Quebec Accent', gender: 'female', previewUrl: 'https://api.us.elevenlabs.io/v1/voices/bBRsDJSAcL1ubkrtJ3hM/previews/audio?payload=eyJ2b2ljZV9zb3VyY2UiOiJjdXN0b20iLCJ3b3Jrc3BhY2VfaWQiOiIyZmY0Y2ZiNzZjZWU0ODY3YmRkOGI4YTNhMTQ3Y2EwZCIsImZpbGVuYW1lIjoiRGh3bE9PdFU4Tmt1b3VFdlVaVDMubXAzIiwidGltZXN0YW1wIjoxNzg5ODEyMDAwMDAwMDAwfQ%3D%3D' },
    { id: 'WW0JfNPk5DgcQdM0d6X6', name: 'Claudia - Warm, Energetic and Confident', gender: 'female', previewUrl: 'https://api.us.elevenlabs.io/v1/voices/WW0JfNPk5DgcQdM0d6X6/previews/audio?payload=eyJ2b2ljZV9zb3VyY2UiOiJjdXN0b20iLCJ1c2VyX2lkIjoiRXZ0TmQ5YlZmUWg4Q0p6UmJ4alFqRlVTSW5YMiIsImZpbGVuYW1lIjoiNTVmZjFlNDMtNmM3MS00NTQ1LThiODQtZWY5ODVmYjQxMzIwLm1wMyIsInRpbWVzdGFtcCI6MTc4OTgxMjAwMDAwMDAwMH0%3D' },
    { id: 'UJCi4DDncuo0VJDSIegj', name: 'Amélie - Young, Confident and Friendly', gender: 'female', previewUrl: 'https://storage.googleapis.com/eleven-public-prod/database/workspace/bead6b5e681541d58fb18a316046c5f1/voices/UJCi4DDncuo0VJDSIegj/cHWK1vigSE6tDlgEyjIB.mp3' },
    { id: 'K7gx0ylJdff0yjM2uVQS', name: 'Jeanne Mance - Charming, Clear and Young', gender: 'female', previewUrl: 'https://storage.googleapis.com/eleven-public-prod/database/user/eFmYIzNi7fVTAUiSkCFaPtNH8aQ2/voices/K7gx0ylJdff0yjM2uVQS/Ky5MZg2iu3cQm2YO5DHt.mp3' },
  ],
}

// The voice used today, before this feature existed — kept as its own
// constant (rather than reaching into VIDEO_VOICES[0]) so the form's
// default doesn't silently change if the curated list's ordering ever does.
export const DEFAULT_VOICE_ID: Record<'EN' | 'FR', string> = {
  EN: 'epkQ8pqDcY2DxhmFi8xl',
  FR: 'n2pCwUKS6q9Iur03Rten',
}
