import { create } from 'zustand'
import { DEFAULT_VOICE_ID } from '@/lib/videoVoices'

export type ContentType = 'video' | 'image_post' | 'blog'
export type ScriptType  = 'SOLUTION' | 'COMMUNITY'
export type Language    = 'EN' | 'FR' | 'BOTH'
// 'photo': strictly no text baked into the image (default). 'infographic':
// headline/subtitle/logo/CTA text rendered onto the image via a
// text-capable model. User-selected, never an automatic per-category guess.
export type ImageStyle  = 'photo' | 'infographic'
// image_post only. A fixed dropdown (never free text) so the caption — and,
// for image_style: 'infographic', the on-image headline/subtitle — draw
// from one of a known set of creative briefs instead of two independent,
// unrelated guesses at the same topic. 'auto' ('let AI decide', the
// default) is converted to null before persisting.
export type ContentAngle = 'auto' | 'community_story' | 'behind_scenes' | 'fresh_produce' | 'stat_fact' | 'call_to_action'
// video only. Passed straight through to Flux Kontext's aspectRatio param
// for character-ref/scene-image generation, and (since the 2026-09-21
// Seedance 1.5 Pro swap) to KieVideoGenerator's own required aspect_ratio
// input too — see kie.ts's KieVideoGenerator header. Default '9:16': the
// native shape for TikTok/Reels/Shorts.
export type AspectRatio = '9:16' | '1:1' | '16:9'

const SESSION_KEY = 'fc_new_content'

interface FormFields {
  topic:           string
  keywords:        string
  category:        string
  target_audience: string
  script_type:     ScriptType
  video_duration:  string
  language:        Language
  content_types:   ContentType[]
  scene_notes:     string   // required creative brief for the post's scene/story — see page.tsx's validation
  image_style:     ImageStyle
  content_angle:   ContentAngle
  aspect_ratio:    AspectRatio
  // video only. ElevenLabs voice_id for each language's narration — see
  // src/lib/videoVoices.ts's curated list. Defaults to the voice already in
  // use before this was user-selectable, so an unedited job's narration
  // never changes.
  voice_id_en:     string
  voice_id_fr:     string
}

interface GenState {
  status:       'idle' | 'pending'
  pendingJobId: string | null
  generatedAt:  number | null
}

interface NewContentStore extends FormFields, GenState {
  restoreSession:     () => boolean
  setField:           <K extends keyof FormFields>(key: K, value: FormFields[K]) => void
  toggleType:         (type: ContentType) => void
  startGeneration:    (jobId: string) => void
  clearAfterApproval: (jobId?: string) => void
  clearOnCancel:      () => void
}

const FORM_DEFAULTS: FormFields = {
  topic:           '',
  keywords:        '',
  category:        'Food Desert Education',
  target_audience: 'General public',
  script_type:     'SOLUTION',
  video_duration:  '36',
  language:        'EN',
  content_types:   ['video', 'image_post', 'blog'],
  scene_notes:     '',
  image_style:     'photo',
  content_angle:   'auto',
  aspect_ratio:    '9:16',
  voice_id_en:     DEFAULT_VOICE_ID.EN,
  voice_id_fr:     DEFAULT_VOICE_ID.FR,
}

const GEN_DEFAULTS: GenState = {
  status:       'idle',
  pendingJobId: null,
  generatedAt:  null,
}

function pickPersisted(s: NewContentStore): FormFields & GenState {
  return {
    topic: s.topic, keywords: s.keywords, category: s.category,
    target_audience: s.target_audience, script_type: s.script_type,
    video_duration: s.video_duration, language: s.language,
    content_types: s.content_types,
    scene_notes: s.scene_notes, image_style: s.image_style, content_angle: s.content_angle,
    aspect_ratio: s.aspect_ratio, voice_id_en: s.voice_id_en, voice_id_fr: s.voice_id_fr,
    status: s.status, pendingJobId: s.pendingJobId, generatedAt: s.generatedAt,
  }
}

function saveToSession(data: FormFields & GenState) {
  try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(data)) } catch (_) {}
}

function clearSession() {
  try {
    sessionStorage.removeItem(SESSION_KEY)
    // clean up old keys from previous implementation
    sessionStorage.removeItem('fc_new_form')
    sessionStorage.removeItem('fc_pending_job')
  } catch (_) {}
}

export const useNewContentStore = create<NewContentStore>((set, get) => ({
  ...FORM_DEFAULTS,
  ...GEN_DEFAULTS,

  restoreSession: () => {
    try {
      const raw = sessionStorage.getItem(SESSION_KEY)
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<FormFields & GenState> & {
          province?: unknown
          city?: unknown
        }
        delete parsed.province
        delete parsed.city
        set(parsed)
        return parsed.status === 'pending' && !!parsed.pendingJobId
      }
      // One-time migration from old sessionStorage keys
      const oldForm    = sessionStorage.getItem('fc_new_form')
      const oldPending = sessionStorage.getItem('fc_pending_job')
      if (oldForm || oldPending) {
        const parsedForm = oldForm
          ? (JSON.parse(oldForm) as Partial<FormFields> & { province?: unknown; city?: unknown })
          : {}
        delete parsedForm.province
        delete parsedForm.city
        const pj   = oldPending ? (JSON.parse(oldPending) as { id?: string }) : {}
        const merged: FormFields & GenState = {
          ...FORM_DEFAULTS, ...GEN_DEFAULTS, ...parsedForm,
          status:       pj.id ? 'pending' : 'idle',
          pendingJobId: pj.id ?? null,
        }
        set(merged)
        try {
          sessionStorage.removeItem('fc_new_form')
          sessionStorage.removeItem('fc_pending_job')
        } catch (_) {}
        saveToSession(merged)
        return !!pj.id
      }
    } catch (_) {}
    return false
  },

  setField: (key, value) => {
    set({ [key]: value } as Partial<NewContentStore>)
    saveToSession(pickPersisted(get()))
  },

  toggleType: (type) => {
    const current = get().content_types
    const next = current.includes(type)
      ? current.filter(t => t !== type)
      : [...current, type]
    set({ content_types: next })
    saveToSession(pickPersisted(get()))
  },

  startGeneration: (jobId) => {
    set({ status: 'pending', pendingJobId: jobId, generatedAt: Date.now() })
    saveToSession(pickPersisted(get()))
  },

  // jobId: only clear if this job matches — prevents clearing a different session
  clearAfterApproval: (jobId) => {
    const { pendingJobId } = get()
    if (jobId && pendingJobId && pendingJobId !== jobId) return
    clearSession()
    set({ ...FORM_DEFAULTS, ...GEN_DEFAULTS })
  },

  clearOnCancel: () => {
    clearSession()
    set({ ...FORM_DEFAULTS, ...GEN_DEFAULTS })
  },
}))
