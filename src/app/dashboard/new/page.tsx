'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  AlertCircle,
  Loader2,
  ArrowLeft,
  FileVideo,
  Image,
  FileText,
  Sparkles,
  Volume2,
} from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { useNewContentStore } from '@/stores/newContentStore'
import type { ContentType, ScriptType, Language, ImageStyle, ContentAngle, AspectRatio } from '@/stores/newContentStore'
import { VIDEO_VOICES } from '@/lib/videoVoices'

// ─── Local types ──────────────────────────────────────────────────────────────

interface FormData {
  topic:           string
  keywords:        string
  category:        string
  target_audience: string
  script_type:     ScriptType
  video_duration:  string
  language:        Language
  content_types:   ContentType[]
  scene_notes:     string
  image_style:     ImageStyle
  content_angle:   ContentAngle
  aspect_ratio:    AspectRatio
  voice_id_en:     string
  voice_id_fr:     string
}

type Phase = 'idle' | 'creating' | 'awaiting_questions' | 'triggering'

interface QuestionItem {
  id: number
  question: string
  options: string[]
  placeholder?: string
}

// ─── Constants ────────────────────────────────────────────────────────────────

const CATEGORIES = [
  'Food Desert Education',
  'AI & Mobile Technology',
  'Community Impact',
  'Customer Stories',
  'Behind the Mobile Unit',
  'How FreshCAN Works',
  'Fresh Produce & Local Farms',
] as const

// image_post only — see worker/src/prompts/brand/fresh-can.ts's
// adAngleBriefs, keyed by these exact same values. A fixed dropdown, never
// free text, so the caption and (for Infographic style) the on-image
// headline/subtitle share one known creative brief instead of being two
// independent, unrelated guesses at the same topic.
const CONTENT_ANGLES: { value: ContentAngle; label: string }[] = [
  { value: 'auto',             label: 'Auto (Let AI Decide)' },
  { value: 'community_story',  label: 'A real community story' },
  { value: 'behind_scenes',    label: 'Behind-the-scenes / how it works' },
  { value: 'fresh_produce',    label: 'Fresh produce & health' },
  { value: 'stat_fact',        label: 'Lead with a stat or fact' },
  { value: 'call_to_action',   label: 'Call-to-action — find a unit' },
]

const TARGET_AUDIENCES = [
  'Food-insecure families',
  'Community members',
  'Local farmers & partners',
  'General public',
] as const

const VIDEO_DURATIONS = ['24', '28', '32', '36', '40', '44', '48', '52'] as const

const CONTENT_TYPES: {
  id: ContentType
  label: string
  description: string
  icon: React.ReactNode
  iconBg: string
}[] = [
  {
    id: 'video',
    label: 'Video',
    description: 'AI video with voiceover script',
    icon: <FileVideo className="h-5 w-5" />,
    iconBg: 'text-purple-600 bg-purple-50',
  },
  {
    id: 'image_post',
    label: 'Image Post',
    description: 'KIE AI generated image + caption',
    icon: <Image className="h-5 w-5" />,
    iconBg: 'text-blue-600 bg-blue-50',
  },
  {
    id: 'blog',
    label: 'Blog Post',
    description: 'GPT-4o written long-form post',
    icon: <FileText className="h-5 w-5" />,
    iconBg: 'text-green-600 bg-green-50',
  },
]


function FL({ children, htmlFor }: { children: React.ReactNode; htmlFor?: string }) {
  return (
    <label htmlFor={htmlFor} className="block text-sm font-medium text-gray-700">
      {children}
    </label>
  )
}

// A grid of selectable voice cards — one radio-style choice per language,
// visually matching "What to Generate"'s content-type cards (border-2,
// green when selected) — plus a "play preview" button on each card using
// ElevenLabs' own free, pre-generated preview_url (src/lib/videoVoices.ts),
// no API call needed, just an <audio> element. A card's preview button is
// disabled (not hidden) when that voice has no preview yet, since the
// curated list starts out with placeholder entries until real ElevenLabs
// voice IDs are swapped in.
function VoiceCardGroup({
  label,
  value,
  onChange,
  voices,
  disabled,
}: {
  label: string
  value: string
  onChange: (id: string) => void
  voices: { id: string; name: string; gender: 'male' | 'female'; previewUrl: string }[]
  disabled: boolean
}) {
  const [playingId, setPlayingId] = useState<string | null>(null)

  const handlePreview = (e: React.MouseEvent, voice: { id: string; previewUrl: string }) => {
    e.preventDefault()
    e.stopPropagation()
    if (!voice.previewUrl) return
    const audio = new window.Audio(voice.previewUrl)
    setPlayingId(voice.id)
    const clear = () => setPlayingId((cur) => (cur === voice.id ? null : cur))
    audio.addEventListener('ended', clear)
    audio.play().catch(clear)
  }

  return (
    <div className="space-y-2">
      <FL>{label} <span className="text-red-500">*</span></FL>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {voices.map((v) => {
          const selected = value === v.id
          const playing = playingId === v.id
          return (
            <label
              key={v.id}
              className={`flex cursor-pointer flex-col gap-2 rounded-xl border-2 p-3 transition-all ${
                selected
                  ? 'border-green-500 bg-green-50/50'
                  : 'border-gray-200 hover:border-gray-300 hover:bg-gray-50'
              } ${disabled ? 'pointer-events-none opacity-50' : ''}`}
            >
              <input
                type="radio"
                name={`voice-${label}`}
                className="sr-only"
                checked={selected}
                onChange={() => onChange(v.id)}
                disabled={disabled}
              />
              <div className="flex items-center justify-between">
                <span
                  className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-2 ${
                    selected ? 'border-green-500 bg-green-500' : 'border-gray-300'
                  }`}
                >
                  {selected && <span className="h-1.5 w-1.5 rounded-full bg-white" />}
                </span>
                <button
                  type="button"
                  onClick={(e) => handlePreview(e, v)}
                  disabled={disabled || !v.previewUrl}
                  className={`flex h-7 w-7 items-center justify-center rounded-full border transition-colors ${
                    v.previewUrl
                      ? 'border-gray-300 text-gray-600 hover:bg-gray-100'
                      : 'border-gray-200 text-gray-300'
                  }`}
                  title={v.previewUrl ? 'Play preview' : 'No preview available for this voice yet'}
                >
                  <Volume2 className={`h-3.5 w-3.5 ${playing ? 'animate-pulse' : ''}`} />
                </button>
              </div>
              <div>
                <p className="text-sm font-semibold text-gray-900">{v.name}</p>
                <p className="text-xs capitalize text-gray-500">{v.gender}</p>
              </div>
            </label>
          )
        })}
      </div>
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function NewContentPage() {
  const router = useRouter()
  const [phase, setPhase] = useState<Phase>('idle')
  const [error, setError] = useState<string | null>(null)

  const {
    topic, keywords, category, target_audience, script_type, video_duration,
    language, content_types, scene_notes, image_style, content_angle, aspect_ratio,
    voice_id_en, voice_id_fr, status, pendingJobId,
    restoreSession, setField, toggleType, startGeneration, clearOnCancel,
  } = useNewContentStore()

  useEffect(() => {
    restoreSession()
  }, [restoreSession])

  const isSubmitting = phase !== 'idle'
  const videoOn = content_types.includes('video')

  // Holds the created job + returned questions while the user answers them.
  // Only ever populated when 'image_post' is one of the selected content types.
  const [pendingImageJob, setPendingImageJob] = useState<{
    jobId: string
    formSnapshot: FormData
    questions: QuestionItem[]
  } | null>(null)
  const [answers, setAnswers] = useState<Record<number, string>>({})

  async function triggerNonImageTypes(jobId: string, formSnapshot: FormData) {
    const otherTypes = formSnapshot.content_types.filter((t) => t !== 'image_post')
    if (otherTypes.length === 0) return { failed: [] as string[] }

    const results = await Promise.allSettled(
      otherTypes.map(async (type) => {
        // Blog runs on the new pipeline/worker (docs/IMPLEMENTATION_PLAN.md M5):
        // this creates a content_pipelines + content_language_tracks row and
        // returns immediately — the worker does the actual generation, and
        // finalize_draft writes the result to content_drafts, which this page
        // already displays via realtime. No n8n involved for blog anymore.
        if (type === 'blog') {
          const res = await fetch(`/api/jobs/${jobId}/blog/generate`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({}),
          })
          // src/proxy.ts gates every /api/jobs/* route behind the session
          // cookie — an expired/missing session makes this request redirect
          // to /login instead of running. fetch() follows redirects by
          // default, so res.ok is still true for the resulting login-page
          // response: confirmed live, this silently "succeeded" while never
          // creating the content_pipelines row, leaving the job stuck
          // forever with no error shown and nothing for the worker to poll.
          if (res.redirected && res.url.includes('/login')) {
            throw new Error('[blog] Your session has expired — please log in again and resubmit.')
          }
          if (!res.ok) {
            const b = await res.json().catch(() => ({}))
            throw new Error(`[blog] ${b.error ?? `HTTP ${res.status}`}`)
          }
          return type
        }

        // Video runs on the new pipeline/worker too now (see the video
        // migration plan) — creates a content_pipelines row (no
        // requestedLanguages yet: video gates language-track creation
        // behind approval, unlike blog/image, ARCHITECTURE.MD §6.4). The
        // worker picks it up and writes the master script+scene draft to
        // content_drafts, same as blog's finalize_draft does.
        if (type === 'video') {
          const res = await fetch(`/api/jobs/${jobId}/video/generate`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({}),
          })
          if (res.redirected && res.url.includes('/login')) {
            throw new Error('[video] Your session has expired — please log in again and resubmit.')
          }
          if (!res.ok) {
            const b = await res.json().catch(() => ({}))
            throw new Error(`[video] ${b.error ?? `HTTP ${res.status}`}`)
          }
          return type
        }

        // Unreachable: otherTypes only ever holds 'blog'/'video' (image_post
        // is filtered out above, and ContentType has no fourth member), and
        // both are handled above with an early return. Guards against a
        // future ContentType addition silently falling through to nothing.
        throw new Error(`[${type}] no generation route wired up for this content type`)
      }),
    )
    const failed = results
      .filter((r) => r.status === 'rejected')
      .map((r) => (r as PromiseRejectedResult).reason.message as string)
    return { failed }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)

    if (!topic.trim())              return setError('Topic is required')
    if (!keywords.trim())           return setError('Keywords are required')
    if (!scene_notes.trim())        return setError('Your Scene Idea is required')
    if (content_types.length === 0) return setError('Select at least one content type')

    setPhase('creating')
    const { data: job, error: insertError } = await supabase
      .from('content_jobs')
      .insert({
        topic:           topic.trim(),
        keywords:        keywords.trim(),
        category,
        target_audience,
        brand:           'Fresh-CAN',
        language,
        content_types,
        status:          'pending',
        scene_notes:     scene_notes.trim(),
        // Read directly by the worker (worker/src/prompts) when building
        // image prompts for whatever this job generates (blog hero/inline
        // and/or image_post photo) — supabase/migrations/20260910000000.
        image_style:     image_style,
        // image_post only — read by generate_caption and (for infographic
        // style) generate_ad_copy so both stay cohesive — supabase/
        // migrations/20260911000000. 'auto' means let AI decide and is never
        // persisted as a literal value.
        content_angle:   (content_angle && content_angle !== 'auto') ? content_angle : null,
        // video only — read directly by the worker (worker/src/index.ts's
        // fetchJobInputs) for character-ref/scene-image generation, passed
        // straight to Flux Kontext's own aspectRatio param — supabase/
        // migrations/20260912120000.
        aspect_ratio:    aspect_ratio,
        // video only — read by the worker (fetchJobInputs) and passed to
        // generate_script as a target runtime for the script's total
        // duration — supabase/migrations/20260914000000. Previously
        // collected here but never persisted (only read by the retired n8n
        // buildPayload branch), leaving the worker with no length signal at
        // all — confirmed live 2026-09-13: a real run picked 90s of total
        // runtime, nearly double this dropdown's own 52s ceiling.
        video_duration_seconds: Number(video_duration),
        // video only — user-selected narration voice per language (src/lib/
        // videoVoices.ts's curated list), read by the worker (fetchJobInputs)
        // and passed to synthesize_voice as an override of the fixed brand
        // default — supabase/migrations/20260915000000. Defaults match that
        // brand default exactly, so an unedited job's voice never changes.
        voice_id_en:     voice_id_en,
        voice_id_fr:     voice_id_fr,
      })
      .select()
      .single()

    if (insertError || !job) {
      setError(insertError?.message ?? 'Failed to create job. Please try again.')
      setPhase('idle')
      return
    }

    const formSnapshot: FormData = {
      topic, keywords, category, target_audience,
      script_type, video_duration, language, content_types,
      scene_notes, image_style, content_angle, aspect_ratio,
      voice_id_en, voice_id_fr,
    }

    // ── If image_post wasn't selected, nothing changes — same flow as before ──
    if (!content_types.includes('image_post')) {
      setPhase('triggering')
      const { failed } = await triggerNonImageTypes(job.id, formSnapshot)
      supabase.from('content_jobs')
        .update({ webhook_sent_at: new Date().toISOString() })
        .eq('id', job.id).then(() => {})

      if (failed.length > 0) {
        setError(`Generation error: ${failed.join(' · ')}`)
        setPhase('idle')
        return
      }
      startGeneration(job.id)
      router.push(`/dashboard/jobs/${job.id}`)
      return
    }

    // ── image_post is selected — fetch clarifying questions first ──────────
    setPhase('triggering')
    // Fire video/blog immediately if also selected — they don't need a brief
    const { failed } = await triggerNonImageTypes(job.id, formSnapshot)
    if (failed.length > 0) {
      setError(`Generation error: ${failed.join(' · ')}`)
      setPhase('idle')
      return
    }

    const qRes = await fetch(`/api/jobs/${job.id}/image/questions`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({}),
    })

    if (qRes.redirected && qRes.url.includes('/login')) {
      setError('Your session has expired — please log in again and resubmit.')
      setPhase('idle')
      return
    }
    if (!qRes.ok) {
      const b = await qRes.json().catch(() => ({}))
      setError(b.error ?? 'Failed to get clarifying questions from n8n')
      setPhase('idle')
      return
    }

    const qData = await qRes.json()
    const questions: QuestionItem[] = qData.questions ?? []

    if (questions.length === 0) {
      // Fallback: no questions came back — just generate straight away.
      // image_post runs on the new pipeline/worker now; scene_notes was
      // already persisted above and there are no answers to store.
      const res = await fetch(`/api/jobs/${job.id}/image/generate`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({}),
      })
      if (res.redirected && res.url.includes('/login')) {
        setError('Your session has expired — please log in again and resubmit.')
        setPhase('idle')
        return
      }
      if (!res.ok) {
        const b = await res.json().catch(() => ({}))
        setError(b.error ?? 'Failed to trigger image generation')
        setPhase('idle')
        return
      }
      startGeneration(job.id)
      router.push(`/dashboard/jobs/${job.id}`)
      return
    }

    setPendingImageJob({ jobId: job.id, formSnapshot, questions })
    setAnswers({})
    setPhase('awaiting_questions')
  }

  const handleAnswersSubmit = async () => {
    if (!pendingImageJob) return
    setPhase('triggering')

    const answersArray = pendingImageJob.questions.map((q) => ({
      question: q.question,
      answer:   answers[q.id] || '',
    }))

    // Persist the answers before triggering — the worker pipeline reads
    // content_jobs.image_answers the way it already reads topic/category,
    // it has no access to this in-memory answersArray otherwise.
    const { error: answersErr } = await supabase
      .from('content_jobs')
      .update({ image_answers: answersArray })
      .eq('id', pendingImageJob.jobId)
    if (answersErr) {
      setError(answersErr.message)
      setPhase('awaiting_questions')
      return
    }

    const res = await fetch(`/api/jobs/${pendingImageJob.jobId}/image/generate`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({}),
    })

    if (res.redirected && res.url.includes('/login')) {
      setError('Your session has expired — please log in again and resubmit.')
      setPhase('awaiting_questions')
      return
    }
    if (!res.ok) {
      const b = await res.json().catch(() => ({}))
      setError(b.error ?? 'Failed to trigger image generation')
      setPhase('awaiting_questions')
      return
    }

    supabase.from('content_jobs')
      .update({ webhook_sent_at: new Date().toISOString() })
      .eq('id', pendingImageJob.jobId).then(() => {})

    startGeneration(pendingImageJob.jobId)
    router.push(`/dashboard/jobs/${pendingImageJob.jobId}`)
  }

  const handleCancel = () => {
    if (status === 'pending') {
      const ok = window.confirm('Content is being generated. Cancel and lose all progress?')
      if (!ok) return
    }
    clearOnCancel()
    router.push('/dashboard')
  }

  return (
    <div className="mx-auto max-w-[600px] py-6">

      {/* ── Clarifying questions step — shown only after image_post job creation ── */}
      {phase === 'awaiting_questions' && pendingImageJob && (
        <div className="mb-6 space-y-5">
          <div className="mb-2">
            <h1 className="text-2xl font-bold tracking-tight text-gray-900">
              A few quick questions
            </h1>
            <p className="mt-1 text-sm text-gray-500">
              Answer these to help the AI create a more specific image for &ldquo;{pendingImageJob.formSnapshot.topic}&rdquo;
            </p>
          </div>

          {pendingImageJob.questions.map((q) => (
            <Card key={q.id} className="border bg-white shadow-sm">
              <CardContent className="space-y-3 pt-5">
                <p className="text-sm font-medium text-gray-800">{q.question}</p>
                <div className="flex flex-wrap gap-2">
                  {q.options.map((opt) => (
                    <button
                      key={opt}
                      type="button"
                      onClick={() => setAnswers((prev) => ({ ...prev, [q.id]: opt }))}
                      className={`rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${
                        answers[q.id] === opt
                          ? 'border-gray-900 bg-gray-900 text-white'
                          : 'border-gray-200 text-gray-600 hover:border-gray-300'
                      }`}
                    >
                      {opt}
                    </button>
                  ))}
                </div>
                <Input
                  value={answers[q.id] && !q.options.includes(answers[q.id]) ? answers[q.id] : ''}
                  onChange={(e) => setAnswers((prev) => ({ ...prev, [q.id]: e.target.value }))}
                  placeholder={q.placeholder || 'Or type your own answer…'}
                  className="text-sm"
                />
              </CardContent>
            </Card>
          ))}

          {error && (
            <div className="flex items-start gap-3 rounded-xl border border-red-200 bg-red-50 p-4">
              <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-red-500" />
              <p className="text-sm text-red-700">{error}</p>
            </div>
          )}

          <Button
            onClick={handleAnswersSubmit}
            disabled={(phase as string) === 'triggering'}
            size="lg"
            className="w-full bg-gray-900 py-6 text-base font-semibold hover:bg-gray-800"
          >
            {(phase as string) === 'triggering' ? (
              <><Loader2 className="mr-2 h-5 w-5 animate-spin" />Generating…</>
            ) : (
              <><Sparkles className="mr-2 h-5 w-5" />Continue &amp; Generate Image</>
            )}
          </Button>
        </div>
      )}

      {/* ── Normal form — hidden while the questions step above is showing ── */}
      {phase !== 'awaiting_questions' && (
      <>

      {/* ── Pending-job banner (shown when returning mid-generation) ── */}
      {status === 'pending' && pendingJobId && (
        <div className="mb-5 flex items-center gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-amber-100">
            <Loader2 className="h-4 w-4 animate-spin text-amber-600" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-amber-900">Content generation in progress</p>
            <p className="truncate text-xs text-amber-700">{topic}</p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Link
              href={`/dashboard/jobs/${pendingJobId}`}
              className="rounded-lg border border-amber-300 bg-white px-3 py-1.5 text-xs font-medium text-amber-800 hover:bg-amber-50"
            >
              View Job →
            </Link>
            <button
              type="button"
              onClick={() => {
                const ok = window.confirm('Cancel this generation and start a new request?')
                if (ok) clearOnCancel()
              }}
              className="rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50"
            >
              Start New
            </button>
          </div>
        </div>
      )}

      {/* Page header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight text-gray-900">
          Generate New Content
        </h1>
        <p className="mt-1 text-sm text-gray-500">
          One topic → Video, Image Post &amp; Blog generated simultaneously by AI
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-5">

        {/* ── Section 1: Content Details ─────────────────────────────── */}
        <Card className="border bg-white shadow-sm">
          <CardHeader className="border-b py-4">
            <CardTitle className="flex items-center gap-2 text-sm font-semibold text-gray-800">
              <Sparkles className="h-4 w-4 text-amber-500" />
              Content Details
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-5 pt-5">

            <div className="space-y-1.5">
              <FL htmlFor="topic">Topic <span className="text-red-500">*</span></FL>
              <Input
                id="topic"
                value={topic}
                onChange={(e) => setField('topic', e.target.value)}
                placeholder="e.g. Food Deserts in Calgary"
                disabled={isSubmitting}
              />
            </div>

            <div className="space-y-1.5">
              <FL htmlFor="keywords">Keywords <span className="text-red-500">*</span></FL>
              <Input
                id="keywords"
                value={keywords}
                onChange={(e) => setField('keywords', e.target.value)}
                placeholder="food desert, mobile grocery, fresh food, Canada"
                disabled={isSubmitting}
              />
              <p className="text-xs text-gray-400">Separate with commas</p>
            </div>

            <div className="space-y-1.5">
              <FL>Content Category <span className="text-red-500">*</span></FL>
              <Select
                value={category}
                onValueChange={(v) => { if (v) setField('category', v) }}
                disabled={isSubmitting}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {CATEGORIES.map((c) => (
                    <SelectItem key={c} value={c}>{c}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <FL>Target Audience <span className="text-red-500">*</span></FL>
              <Select
                value={target_audience}
                onValueChange={(v) => { if (v) setField('target_audience', v) }}
                disabled={isSubmitting}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {TARGET_AUDIENCES.map((a) => (
                    <SelectItem key={a} value={a}>{a}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <FL>Language <span className="text-red-500">*</span></FL>
              <Select
                value={language}
                onValueChange={(v) => { if (v) setField('language', v as Language) }}
                disabled={isSubmitting}
              >
                <SelectTrigger className="w-48"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="EN">EN — English</SelectItem>
                  <SelectItem value="FR">FR — French</SelectItem>
                  <SelectItem value="BOTH">BOTH — EN + FR</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <FL>Image Style <span className="text-red-500">*</span></FL>
              <Select
                value={image_style}
                onValueChange={(v) => { if (v) setField('image_style', v as ImageStyle) }}
                disabled={isSubmitting}
              >
                <SelectTrigger className="w-64"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="photo">Photo — no text on the image</SelectItem>
                  <SelectItem value="infographic">Infographic — headline &amp; text on the image</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-gray-400">
                Applies to every image this job generates (blog hero/inline and/or the social photo).
              </p>
            </div>

            <div className="space-y-1.5">
              <FL>Content Angle</FL>
              <Select
                value={content_angle}
                onValueChange={(v) => { if (v) setField('content_angle', v as ContentAngle) }}
                disabled={isSubmitting}
              >
                <SelectTrigger className="w-64"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {CONTENT_ANGLES.map((a) => (
                    <SelectItem key={a.value} value={a.value}>{a.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-gray-400">
                Image Post only. Keeps the caption — and, with Infographic style, the headline/subtitle
                rendered on the image — built around the same idea instead of two unrelated guesses.
              </p>
            </div>

            {/* ── Custom scene / story idea (required) ──────────────── */}
            <div className="space-y-1.5">
              <FL htmlFor="scene_notes">Your Scene Idea <span className="text-red-500">*</span></FL>
              <Textarea
                id="scene_notes"
                value={scene_notes}
                onChange={(e) => setField('scene_notes', e.target.value)}
                placeholder="e.g. Show a senior who can't reach the food bank during a heatwave, then Fresh-CAN arrives with cold groceries..."
                disabled={isSubmitting}
                rows={4}
              />
              <p className="text-xs text-gray-400">
                This is the creative brief the Image Post photo, the Blog post&apos;s angle and images, and the
                Video&apos;s story and scenes are all built around. Fresh-CAN&apos;s own brand details only shape
                how the truck, interior, and voice must look or sound if they appear; they don&apos;t decide what
                the scene is.
              </p>
            </div>

          </CardContent>
        </Card>

        {/* ── Section 2: What to Generate ────────────────────────────── */}
        <Card className="border bg-white shadow-sm">
          <CardHeader className="border-b py-4">
            <CardTitle className="text-sm font-semibold text-gray-800">
              What to Generate
            </CardTitle>
            <p className="mt-0.5 text-xs text-gray-500">
              All selected types fire simultaneously from the same topic.
            </p>
          </CardHeader>
          <CardContent className="space-y-3 pt-4">
            {CONTENT_TYPES.map(({ id, label, description, icon, iconBg }) => {
              const checked = content_types.includes(id)
              return (
                <label
                  key={id}
                  className={`flex cursor-pointer items-center gap-4 rounded-xl border-2 p-4 transition-all ${
                    checked
                      ? 'border-green-500 bg-green-50/50'
                      : 'border-gray-200 hover:border-gray-300 hover:bg-gray-50'
                  }`}
                >
                  <Checkbox
                    checked={checked}
                    onCheckedChange={() => toggleType(id)}
                    disabled={isSubmitting}
                    className="shrink-0"
                  />
                  <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${iconBg}`}>
                    {icon}
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-gray-900">{label}</p>
                    <p className="text-xs text-gray-500">{description}</p>
                  </div>
                </label>
              )
            })}
          </CardContent>
        </Card>

        {/* ── Section 3: Video Settings ───────────────────────────────── */}
        {videoOn && (
          <Card className="border border-purple-200 bg-purple-50/30 shadow-sm">
            <CardHeader className="border-b border-purple-200 py-4">
              <CardTitle className="flex items-center gap-2 text-sm font-semibold text-purple-800">
                <FileVideo className="h-4 w-4" />
                Video Settings
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-5 pt-5">

              <div className="space-y-1.5">
                <FL>Script Type <span className="text-red-500">*</span></FL>
                <Select
                  value={script_type}
                  onValueChange={(v) => { if (v) setField('script_type', v as ScriptType) }}
                  disabled={isSubmitting}
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="SOLUTION">SOLUTION</SelectItem>
                    <SelectItem value="COMMUNITY">COMMUNITY</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-gray-500">
                  {script_type === 'SOLUTION'
                    ? 'Data-driven, community advocate perspective'
                    : 'First-person, food-insecure person perspective'}
                </p>
              </div>

              <div className="space-y-1.5">
                <FL>Video Duration <span className="text-red-500">*</span></FL>
                <Select
                  value={video_duration}
                  onValueChange={(v) => { if (v) setField('video_duration', v) }}
                  disabled={isSubmitting}
                >
                  <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {VIDEO_DURATIONS.map((d) => (
                      <SelectItem key={d} value={d}>{d} seconds</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <FL>Aspect Ratio <span className="text-red-500">*</span></FL>
                <Select
                  value={aspect_ratio}
                  onValueChange={(v) => { if (v) setField('aspect_ratio', v as AspectRatio) }}
                  disabled={isSubmitting}
                >
                  <SelectTrigger className="w-64"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="9:16">9:16 — TikTok / Reels / Shorts</SelectItem>
                    <SelectItem value="1:1">1:1 — Square</SelectItem>
                    <SelectItem value="16:9">16:9 — Landscape</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {(language === 'EN' || language === 'BOTH') && (
                <VoiceCardGroup
                  label="English Narration Voice"
                  value={voice_id_en}
                  onChange={(v) => setField('voice_id_en', v)}
                  voices={VIDEO_VOICES.EN}
                  disabled={isSubmitting}
                />
              )}

              {(language === 'FR' || language === 'BOTH') && (
                <VoiceCardGroup
                  label="French Narration Voice"
                  value={voice_id_fr}
                  onChange={(v) => setField('voice_id_fr', v)}
                  voices={VIDEO_VOICES.FR}
                  disabled={isSubmitting}
                />
              )}

            </CardContent>
          </Card>
        )}

        {/* Error */}
        {error && (
          <div className="flex items-start gap-3 rounded-xl border border-red-200 bg-red-50 p-4">
            <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-red-500" />
            <p className="text-sm text-red-700">{error}</p>
          </div>
        )}

        {/* Submit */}
        <Button
          type="submit"
          disabled={isSubmitting || content_types.length === 0}
          size="lg"
          className="w-full bg-gray-900 py-6 text-base font-semibold hover:bg-gray-800 disabled:opacity-50"
        >
          {phase === 'creating' ? (
            <><Loader2 className="mr-2 h-5 w-5 animate-spin" />Creating job…</>
          ) : phase === 'triggering' ? (
            <><Loader2 className="mr-2 h-5 w-5 animate-spin" />Starting generation…</>
          ) : (
            <>
              <Sparkles className="mr-2 h-5 w-5" />
              {content_types.length === 3
                ? 'Generate All 3 Content Types'
                : content_types.length === 0
                  ? 'Select a content type'
                  : `Generate ${content_types.length} Content Type${content_types.length > 1 ? 's' : ''}`}
            </>
          )}
        </Button>

        {/* Cancel */}
        <div className="text-center">
          <button
            type="button"
            onClick={handleCancel}
            className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-700"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Cancel — back to Dashboard
          </button>
        </div>

      </form>

      </>
      )}
    </div>
  )
}
