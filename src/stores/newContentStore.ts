import { create } from 'zustand'

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
// default) is converted to null before persisting, same convention as
// province's 'auto' sentinel.
export type ContentAngle = 'auto' | 'community_story' | 'behind_scenes' | 'fresh_produce' | 'stat_fact' | 'call_to_action'

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
  province:        string   // 'auto' or one of the 10 provinces
  city:            string   // free-text, empty = omit
  scene_notes:     string   // optional custom scene/story idea from user
  image_style:     ImageStyle
  content_angle:   ContentAngle
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
  province:        'auto',
  city:            '',
  scene_notes:     '',
  image_style:     'photo',
  content_angle:   'auto',
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
    content_types: s.content_types, province: s.province, city: s.city,
    scene_notes: s.scene_notes, image_style: s.image_style, content_angle: s.content_angle,
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
        const saved = JSON.parse(raw) as FormFields & GenState
        set(saved)
        return saved.status === 'pending' && !!saved.pendingJobId
      }
      // One-time migration from old sessionStorage keys
      const oldForm    = sessionStorage.getItem('fc_new_form')
      const oldPending = sessionStorage.getItem('fc_pending_job')
      if (oldForm || oldPending) {
        const form = oldForm ? (JSON.parse(oldForm) as Partial<FormFields>) : {}
        const pj   = oldPending ? (JSON.parse(oldPending) as { id?: string }) : {}
        const merged: FormFields & GenState = {
          ...FORM_DEFAULTS, ...GEN_DEFAULTS, ...form,
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
