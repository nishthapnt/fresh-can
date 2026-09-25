'use client'

import { useEffect, useState, useCallback, useMemo } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import TopBar from '@/components/layout/TopBar'
import StatusBadge from '@/components/StatusBadge'
import LanguageToggle, { LANG_LABELS } from '@/components/LanguageToggle'
import type { ScriptPart } from '@/components/dashboard/ScriptPartCard'
import { supabase } from '@/lib/supabase'
import { maxNarrationWords, narrationWordCount } from '@/lib/videoNarrationBudget'
import { useContentJobStore } from '@/stores/contentJobStore'
import { useNewContentStore } from '@/stores/newContentStore'
import {
  AlertCircle,
  CheckCircle2,
  FileVideo,
  Image,
  FileText,
  Loader2,
  RefreshCw,
  Zap,
  Clock,
  Sparkles,
  Hash,
  StopCircle,
  Save,
} from 'lucide-react'

// ─── Types ────────────────────────────────────────────────────────────────────

type JobStatus =
  | 'pending'
  | 'draft_ready'
  | 'approved'
  | 'generating'
  | 'ready'
  | 'failed'
  | 'posted'

type ContentType = 'video' | 'image_post' | 'blog'

interface ContentJob {
  id: string
  topic: string
  category: string
  language: string
  keywords: string | null
  target_audience: string
  content_types: ContentType[]
  status: JobStatus
  created_at: string
  image_style?: 'photo' | 'infographic'
}

interface ScriptConfig {
  total_duration: number
  total_script_parts: number
  words_per_part: number
  cta_words: number
  clip_duration_each: number
}

interface VideoDraftData {
  // Legacy (n8n) shape — kept optional so any pre-migration draft row still
  // renders without crashing; new rows from generateScript.ts never set these.
  script_parts?: ScriptPart[]
  script_config?: ScriptConfig
  full_script?: string
  topic?: string
  category?: string
  language?: string
  script_type?: string
  // New shape, written by worker/src/steps/generateScript.ts — the ONE
  // master script+scene-plan draft (ARCHITECTURE.MD §4.2 step 2, §6.4).
  script?: string
  visual_description?: string
  duration_seconds?: number
}

// ─── Video pipeline/track status (worker/src/steps/{generateScript,
// generateCharacterRef,generateSceneVisual,localizeScript,synthesizeVoice,
// transcribeAudio,renderLanguageTrack}.ts) — fetched from
// GET /api/jobs/[jobId]/video/status, NOT from allDrafts/content_drafts
// realtime like blog/image. Video's master draft has no per-language
// `language` value that reliably matches job.language for a BOTH job (the
// row's denormalized `language` column is the job's own intent-only value,
// which can literally be the string "BOTH" — draftKey('video','EN') would
// never match it), so it's kept entirely separate from the
// allDrafts/getEffectiveLanguage machinery blog/image still use. ──────────

interface VideoPipelineRow {
  id: string
  job_id: string
  status: string
  current_step: string | null
  current_generation: number
  scenes_total: number | null
  scenes_visuals_ready_count: number
  last_error: string | null
}

interface VideoSceneRow {
  id: string
  scene_number: number
  visual_description: string
  shot_notes: string | null
  narration_intent: unknown
  target_duration_ms: number
}

interface VideoTrackRow {
  id: string
  language: 'EN' | 'FR'
  status: string
  current_step: string | null
  master_generation_used: number
  retry_count: number
  last_error: string | null
}

interface VideoVisualAssetRow {
  id: string
  asset_type: string
  status: string
  file_url: string | null
  video_scene_id: string | null
}

interface VideoStatusResponse {
  pipeline: VideoPipelineRow
  draft: { id: string; draft_data: VideoDraftData } | null
  scenes: VideoSceneRow[]
  tracks: VideoTrackRow[]
  visualAssets: VideoVisualAssetRow[]
}

interface BlogBlockquote { text: string; cite: string }

interface BlogSection {
  heading: string
  h3s: string[]
  paragraphs: string[]
  list_items: string[]
  blockquote: BlogBlockquote | null
  has_inline_image: boolean
}

interface BlogCTA {
  heading: string
  text: string
  button_label: string
  button_url: string
}

interface BlogSEO {
  title: string
  meta_description: string
  focus_keyword: string
  secondary_keywords: string[]
  og_title: string
  og_description: string
  estimated_read_time: string
  slug: string
}

interface BlogImages {
  hero: { url: string; alt: string }
  inline: { url: string; alt: string }
}

interface BlogEditState {
  post_title: string
  post_slug: string
  post_status: string
  generated_at: string
  intro: string
  sections: BlogSection[]
  conclusion: string
  cta: BlogCTA
  seo: BlogSEO
  images: BlogImages
  html_final: string | null
}

function strVal(v: unknown, fallback = ''): string {
  return v != null && v !== '' ? String(v) : fallback
}

function toStrArray(v: unknown): string[] {
  if (Array.isArray(v)) return (v as unknown[]).map(String)
  if (typeof v === 'string' && v) return v.split(',').map((s) => s.trim()).filter(Boolean)
  return []
}

function blogEditFromDraft(data: Record<string, unknown>): BlogEditState {
  // Unwrap array wrapper — a legacy shape from before blog moved onto the
  // worker pipeline; the current generate_copy step never produces one, but
  // older rows written by the old n8n-based blog flow can still have it.
  let d: Record<string, unknown> = data
  if (Array.isArray(d) && d.length > 0) d = (d[0] as Record<string, unknown>) ?? {}

  const content = (typeof d.content === 'object' && d.content && !Array.isArray(d.content)
    ? d.content : {}) as Record<string, unknown>

  const seoRaw = (typeof d.seo === 'object' && d.seo && !Array.isArray(d.seo)
    ? d.seo : {}) as Record<string, unknown>

  const imagesRaw = (typeof d.images === 'object' && d.images && !Array.isArray(d.images)
    ? d.images : {}) as Record<string, unknown>

  const heroRaw = (typeof imagesRaw.hero === 'object' && imagesRaw.hero
    ? imagesRaw.hero : {}) as Record<string, unknown>

  const inlineRaw = (typeof imagesRaw.inline === 'object' && imagesRaw.inline
    ? imagesRaw.inline : {}) as Record<string, unknown>

  const ctaRaw = (typeof content.cta === 'object' && content.cta
    ? content.cta : {}) as Record<string, unknown>

  // Parse sections
  const rawSections = Array.isArray(content.sections) ? content.sections as Record<string, unknown>[] : []
  const sections: BlogSection[] = rawSections.map((s) => {
    const bq = (typeof s.blockquote === 'object' && s.blockquote)
      ? s.blockquote as Record<string, unknown>
      : null
    return {
      heading:          strVal(s.heading),
      h3s:              toStrArray(s.h3s),
      paragraphs:       toStrArray(s.paragraphs),
      list_items:       toStrArray(s.list_items),
      blockquote:       bq ? { text: strVal(bq.text), cite: strVal(bq.cite) } : null,
      has_inline_image: s.has_inline_image === true,
    }
  })

  return {
    post_title:   strVal(d.post_title),
    post_slug:    strVal(d.post_slug ?? seoRaw.slug),
    post_status:  strVal(d.post_status, 'draft'),
    generated_at: strVal(d.generated_at),
    intro:        strVal(content.introduction),
    sections,
    conclusion:   strVal(content.conclusion),
    cta: {
      heading:      strVal(ctaRaw.heading),
      text:         strVal(ctaRaw.text),
      button_label: strVal(ctaRaw.button_label),
      button_url:   strVal(ctaRaw.button_url),
    },
    seo: {
      title:               strVal(seoRaw.title),
      meta_description:    strVal(seoRaw.meta_description),
      focus_keyword:       strVal(seoRaw.focus_keyword),
      secondary_keywords:  toStrArray(seoRaw.secondary_keywords),
      og_title:            strVal(seoRaw.og_title),
      og_description:      strVal(seoRaw.og_description),
      estimated_read_time: strVal(seoRaw.estimated_read_time),
      slug:                strVal(seoRaw.slug),
    },
    images: {
      hero:   { url: strVal(heroRaw.url),   alt: strVal(heroRaw.alt) },
      inline: { url: strVal(inlineRaw.url), alt: strVal(inlineRaw.alt) },
    },
    html_final: typeof d.html_final === 'string' && d.html_final ? d.html_final : null,
  }
}

function generateBlogHTML(edit: BlogEditState): string {
  let html = `<h1>${edit.post_title}</h1>\n`
  if (edit.images.hero.url) {
    html += `<img src="${edit.images.hero.url}" alt="${edit.images.hero.alt}" />\n`
  }
  if (edit.intro) {
    html += `<p>${edit.intro}</p>\n`
  }
  for (const sec of edit.sections) {
    if (sec.heading) html += `<h2>${sec.heading}</h2>\n`
    if (sec.has_inline_image && edit.images.inline.url) {
      html += `<img src="${edit.images.inline.url}" alt="${edit.images.inline.alt}" />\n`
    }
    for (const h3 of sec.h3s) {
      html += `<h3>${h3}</h3>\n`
    }
    for (const p of sec.paragraphs) {
      html += `<p>${p}</p>\n`
    }
    if (sec.list_items.length > 0) {
      html += `<ul>\n`
      for (const li of sec.list_items) {
        html += `<li>${li}</li>\n`
      }
      html += `</ul>\n`
    }
    if (sec.blockquote?.text) {
      html += `<blockquote>\n<p>${sec.blockquote.text}</p>\n`
      if (sec.blockquote.cite) {
        html += `<cite>${sec.blockquote.cite}</cite>\n`
      }
      html += `</blockquote>\n`
    }
  }
  if (edit.conclusion) {
    html += `<h2>Conclusion</h2>\n<p>${edit.conclusion}</p>\n`
  }
  if (edit.cta.heading || edit.cta.text) {
    html += `<h2>${edit.cta.heading}</h2>\n<p>${edit.cta.text}</p>\n`
    if (edit.cta.button_url && edit.cta.button_label) {
      html += `<a href="${edit.cta.button_url}">${edit.cta.button_label}</a>\n`
    }
  }
  return html
}

function blogEditToDraftData(edit: BlogEditState): Record<string, unknown> {
  return {
    post_title:   edit.post_title,
    post_slug:    edit.post_slug,
    post_status:  edit.post_status,
    generated_at: edit.generated_at,
    html_final:   generateBlogHTML(edit),
    seo:          { ...edit.seo, slug: edit.post_slug },
    content: {
      introduction: edit.intro,
      sections:     edit.sections,
      conclusion:   edit.conclusion,
      cta:          edit.cta,
    },
    images: edit.images,
  }
}

interface ContentDraft {
  id: string
  job_id: string
  content_type: ContentType
  language: string
  draft_data: Record<string, unknown>
  is_edited: boolean
  is_approved: boolean
  status: string
  created_at: string
  updated_at: string
}

function draftKey(type: ContentType, language: string): string {
  return `${type}::${language}`
}

interface ImagePostResult {
  id: string
  job_id: string
  content_type: string
  file_url: string | null
  output_data: Record<string, unknown> | null
  created_at: string
  updated_at: string
}

function imgField(r: ImagePostResult, key: string): string {
  // Direct column first, then output_data, then file_url fallback for image_url
  const row = r as unknown as Record<string, unknown>
  const direct = row[key]
  if (direct && typeof direct === 'string') return direct
  const fromOutput = r.output_data?.[key]
  if (fromOutput && typeof fromOutput === 'string') return fromOutput
  if (key === 'image_url') return r.file_url ?? ''
  return ''
}

function imgHashtags(r: ImagePostResult): string[] {
  // hashtags is a plain string, as written by the worker: "#FoodDesert #FreshCAN ..."
  const row = r as unknown as Record<string, unknown>
  const raw = row.hashtags ?? r.output_data?.hashtags
  if (typeof raw === 'string' && raw) return raw.split(/[\s,]+/).filter((t) => t.length > 0)
  if (Array.isArray(raw)) return (raw as unknown[]).map(String)
  return []
}

// ─── Constants ────────────────────────────────────────────────────────────────

const TYPE_LABELS: Record<ContentType, string> = {
  video:      'Video Script',
  image_post: 'Image Post',
  blog:       'Blog Post',
}

const TYPE_ICONS: Record<ContentType, React.ReactNode> = {
  video:      <FileVideo className="h-3.5 w-3.5" />,
  image_post: <Image className="h-3.5 w-3.5" />,
  blog:       <FileText className="h-3.5 w-3.5" />,
}

const TYPE_APPROVE_LABEL: Record<ContentType, string> = {
  video:      'Approve & Generate Video',
  image_post: 'Approve Image',
  blog:       'Approve Blog Post',
}

// ─── WaitingCard ──────────────────────────────────────────────────────────────

function WaitingCard({
  type,
  topic,
  timedOut = false,
  onRefresh,
  onRetryWithInput,
  startedAt,
  terminalError,
  onCancel,
  cancelling = false,
  cancelError,
}: {
  type: ContentType
  topic: string
  timedOut?: boolean
  onRefresh?: () => void
  onRetryWithInput?: () => void
  startedAt?: number | null
  // Set when the pipeline has already stopped server-side (status ===
  // 'failed') — either the user cancelled it or a provider genuinely
  // failed. Distinguished by the exact 'Cancelled by user' marker the
  // cancel routes write (see src/app/api/jobs/[jobId]/{blog,image}/cancel).
  terminalError?: string | null
  onCancel?: () => void
  cancelling?: boolean
  cancelError?: string | null
}) {
  const [progress, setProgress] = useState(0)

  useEffect(() => {
    if (!startedAt) return
    const update = () => {
      const elapsed = (Date.now() - startedAt) / 1000
      setProgress(Math.min(85, (elapsed / 90) * 85))
    }
    update()
    const id = setInterval(update, 1500)
    return () => clearInterval(id)
  }, [startedAt])

  const cancelControls = onCancel && (
    <div className="flex flex-col items-center gap-2">
      <Button
        variant="outline"
        size="sm"
        onClick={onCancel}
        disabled={cancelling}
        className="border-red-200 text-red-600 hover:bg-red-50 hover:text-red-700"
      >
        {cancelling ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <StopCircle className="mr-1.5 h-3.5 w-3.5" />}
        Stop generation
      </Button>
      {cancelError && <p className="max-w-xs text-xs text-red-600">{cancelError}</p>}
    </div>
  )

  if (terminalError) {
    const isCancelled = terminalError === 'Cancelled by user'
    return (
      <Card className="border bg-white shadow-sm">
        <CardContent className="flex flex-col items-center gap-4 py-14 text-center">
          <div className={`flex h-16 w-16 items-center justify-center rounded-full ${isCancelled ? 'bg-gray-100' : 'bg-red-50'}`}>
            {isCancelled
              ? <StopCircle className="h-8 w-8 text-gray-400" />
              : <AlertCircle className="h-8 w-8 text-red-400" />}
          </div>
          <div>
            <p className="text-base font-semibold text-gray-800">
              {isCancelled ? 'Generation stopped' : 'Generation failed'}
            </p>
            <p className="mt-1 text-sm text-gray-500">
              {isCancelled
                ? `You stopped the ${TYPE_LABELS[type].toLowerCase()} generation for “${topic}”.`
                : terminalError}
            </p>
          </div>
          {onRetryWithInput && (
            <Button onClick={onRetryWithInput} className="bg-gray-900 hover:bg-gray-800 text-white">
              <RefreshCw className="mr-2 h-4 w-4" />
              Retry with Instructions
            </Button>
          )}
        </CardContent>
      </Card>
    )
  }
  if (timedOut) {
    return (
      <Card className="border bg-white shadow-sm">
        <CardContent className="flex flex-col items-center gap-4 py-14 text-center">
          <div className="flex h-16 w-16 items-center justify-center rounded-full bg-amber-50">
            <AlertCircle className="h-8 w-8 text-amber-400" />
          </div>
          <div>
            <p className="text-base font-semibold text-gray-800">Taking longer than expected</p>
            <p className="mt-1 text-sm text-gray-500">
              The {TYPE_LABELS[type].toLowerCase()} is still being generated.
              Check back in a moment or try refreshing.
            </p>
          </div>
          <div className="flex flex-wrap items-center justify-center gap-3">
            <Button
              variant="outline"
              onClick={onRefresh ?? (() => window.location.reload())}
            >
              <RefreshCw className="mr-2 h-4 w-4" />
              Refresh Page
            </Button>
            {onRetryWithInput && (
              <Button
                onClick={onRetryWithInput}
                className="bg-gray-900 hover:bg-gray-800 text-white"
              >
                <RefreshCw className="mr-2 h-4 w-4" />
                Retry with Instructions
              </Button>
            )}
          </div>
          {cancelControls}
        </CardContent>
      </Card>
    )
  }

  const messages: Record<ContentType, { title: string; sub: string }> = {
    video:      { title: 'AI is writing your video script…',     sub: 'Generating the script and scene plan' },
    image_post: { title: 'AI is creating your image concept…',  sub: 'Generating the photo and caption' },
    blog:       { title: 'AI is writing your blog post…',       sub: 'Generating the outline, copy, and images' },
  }
  const { title, sub } = messages[type]

  return (
    <Card className="border bg-white shadow-sm">
      <CardContent className="flex flex-col items-center gap-4 py-14 text-center">
        <div className="flex h-16 w-16 items-center justify-center rounded-full bg-amber-50">
          <Clock className="h-8 w-8 text-amber-400" />
        </div>
        <div>
          <p className="text-base font-semibold text-gray-800">{title}</p>
          <p className="mt-1 text-sm text-gray-500">
            {sub} for &ldquo;{topic}&rdquo;. This page updates automatically.
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs text-gray-400">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Waiting for draft…
        </div>
        {startedAt && (
          <div className="w-full max-w-xs">
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-amber-100">
              <div
                className="h-full rounded-full bg-amber-400 transition-all duration-1000"
                style={{ width: `${progress}%` }}
              />
            </div>
            <p className="mt-1.5 text-center text-xs text-gray-400">
              {Math.round((Date.now() - startedAt) / 1000)}s · usually takes 60–90s
            </p>
          </div>
        )}
        {cancelControls}
      </CardContent>
    </Card>
  )
}

// ─── VideoTabContent ──────────────────────────────────────────────────────────

// Coarse pipeline/track statuses map onto a small badge vocabulary — the
// fine-grained phase (character ref vs. scene N vs. audio vs. render) lives
// in current_step, shown as a subtitle rather than driving the badge color,
// per CLAUDE.md's fixed status-color table.
function statusBadgeVariant(status: string): 'gray' | 'amber' | 'blue' | 'green' | 'red' {
  if (status === 'ready') return 'green'
  if (status === 'failed') return 'red'
  if (status === 'created' || status === 'waiting_on_shared') return 'gray'
  if (status === 'draft_ready') return 'amber'
  return 'blue' // drafting/approved/generating/awaiting_shared/rendering
}

// Scenes' narration_intent is `unknown` (jsonb) client-side (VideoSceneRow's
// own doc comment) — every scene generate_script writes always has a `text`
// field (generateScript.ts's runGenerateScript), so this only ever falls
// back to '' for a shape that shouldn't exist in practice.
function sceneNarrationText(narrationIntent: unknown): string {
  if (!narrationIntent || typeof narrationIntent !== 'object') return ''
  const text = (narrationIntent as Record<string, unknown>).text
  return typeof text === 'string' ? text : ''
}

function MiniStatusBadge({ status }: { status: string }) {
  const variant = statusBadgeVariant(status)
  const classes: Record<typeof variant, string> = {
    gray:  'bg-gray-100 text-gray-600',
    amber: 'bg-amber-100 text-amber-700',
    blue:  'bg-blue-100 text-blue-700',
    green: 'bg-green-100 text-green-700',
    red:   'bg-red-100 text-red-700',
  }
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${classes[variant]}`}>
      {status.replace(/_/g, ' ')}
    </span>
  )
}

function VideoTrackCard({ jobId, track }: { jobId: string; track: VideoTrackRow }) {
  // Self-contained (no lift-to-parent refresh call needed): a successful
  // retry flips the track's status server-side (waiting_on_shared —
  // src/app/api/jobs/[jobId]/video/tracks/[lang]/retry/route.ts), and this
  // page's own videoStatus poll picks that up on its next tick, same as
  // every other status change already shown here.
  const [retrying, setRetrying] = useState(false)
  const [retryError, setRetryError] = useState<string | null>(null)

  const handleRetry = async () => {
    setRetrying(true)
    setRetryError(null)
    try {
      const res = await fetch(`/api/jobs/${jobId}/video/tracks/${track.language}/retry`, { method: 'POST' })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? `Retry failed (status ${res.status})`)
      }
    } catch (err) {
      setRetryError(err instanceof Error ? err.message : 'Retry failed')
    } finally {
      setRetrying(false)
    }
  }

  return (
    <Card className="border-gray-200">
      <CardContent className="flex items-center justify-between p-4">
        <div>
          <p className="text-sm font-semibold text-gray-900">{LANG_LABELS[track.language] ?? track.language}</p>
          {track.current_step && (
            <p className="mt-0.5 text-xs text-gray-400">{track.current_step.replace(/_/g, ' ')}</p>
          )}
          {track.status === 'failed' && track.last_error && (
            <p className="mt-1 text-xs text-red-600">{track.last_error}</p>
          )}
          {retryError && <p className="mt-1 text-xs text-red-600">Retry failed: {retryError}</p>}
        </div>
        <div className="flex items-center gap-2">
          {track.status === 'failed' && (
            <Button variant="outline" size="sm" onClick={handleRetry} disabled={retrying}>
              <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${retrying ? 'animate-spin' : ''}`} />
              {retrying ? 'Retrying…' : 'Retry'}
            </Button>
          )}
          <MiniStatusBadge status={track.status} />
        </div>
      </CardContent>
    </Card>
  )
}

function VideoTabContent({
  job,
  videoStatus,
  disabled,
  approveError,
  onClearApproveError,
  onCancel,
  cancelling,
  cancelError,
  onScriptSaved,
}: {
  job: ContentJob
  videoStatus: VideoStatusResponse
  disabled: boolean
  approveError: string | null
  onClearApproveError: () => void
  onCancel: () => void
  cancelling: boolean
  cancelError: string | null
  onScriptSaved: () => void | Promise<void>
}) {
  const { pipeline, draft, scenes, tracks } = videoStatus
  const draftData = draft?.draft_data
  // Video's approval gate sits BEFORE any per-scene/per-language work exists
  // (ARCHITECTURE.MD §6.4) — before 'approved', this is a single master
  // script+scene-plan review, no language toggle and no per-track cards yet.
  const isPreApproval = pipeline.status === 'created' || pipeline.status === 'drafting' || pipeline.status === 'draft_ready'
  const isStoppable = pipeline.status !== 'ready' && pipeline.status !== 'failed'

  // ── Per-scene narration editing (draft_ready only) ──────────────────────
  // narration_intent.text is the ONLY thing localize_script/synthesize_voice
  // read (see updateScript.ts's own header) — editing it here is what makes
  // "editing the script" actually affect generation, unlike the old
  // draft_data.script summary blob which nothing downstream ever read.
  const isEditable = pipeline.status === 'draft_ready'
  const [editedNarration, setEditedNarration] = useState<Record<string, string>>({})
  const [savingScript, setSavingScript] = useState(false)
  const [scriptSaveError, setScriptSaveError] = useState<string | null>(null)

  // Re-seeds only when the scene PLAN itself changes (a script regenerate
  // bumps current_generation) — not on every 6s status poll (page.tsx's own
  // poll effect refetches videoStatus, and therefore `scenes`, continuously
  // while draft_ready), which would otherwise stomp in-progress edits.
  useEffect(() => {
    setEditedNarration(Object.fromEntries(scenes.map((s) => [s.id, sceneNarrationText(s.narration_intent)])))
    setScriptSaveError(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pipeline.current_generation])

  const dirtySceneIds = scenes
    .filter((s) => editedNarration[s.id] !== undefined && editedNarration[s.id] !== sceneNarrationText(s.narration_intent))
    .map((s) => s.id)

  // Mirrors the exact budget updateScript.ts's applyScriptEdits enforces
  // server-side (same lib/videoNarrationBudget functions) — this is a live
  // UX guardrail, not a second, possibly-diverging limit; the server call
  // below is still the authoritative gate.
  const overBudgetSceneIds = new Set(
    scenes
      .filter((s) => narrationWordCount(editedNarration[s.id] ?? '') > maxNarrationWords(s.target_duration_ms))
      .map((s) => s.id),
  )

  const handleSaveScript = async () => {
    if (dirtySceneIds.length === 0 || overBudgetSceneIds.size > 0) return
    setSavingScript(true)
    setScriptSaveError(null)
    try {
      const res = await fetch(`/api/jobs/${job.id}/video/script`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          scenes: dirtySceneIds.map((id) => ({ id, narration: editedNarration[id] })),
        }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? `Save failed (status ${res.status})`)
      }
      await onScriptSaved()
    } catch (err) {
      setScriptSaveError(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setSavingScript(false)
    }
  }

  return (
    <div className="space-y-4">
      {approveError && (
        <div className="flex items-start justify-between gap-3 rounded-xl border border-red-200 bg-red-50 p-4">
          <div className="flex items-start gap-3">
            <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-red-500" />
            <div>
              <p className="text-sm font-semibold text-red-800">Approve failed</p>
              <p className="mt-0.5 text-xs text-red-700">{approveError}</p>
            </div>
          </div>
          <button onClick={onClearApproveError} className="shrink-0 text-xs text-red-500 hover:text-red-700">✕</button>
        </div>
      )}

      {draftData && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-gray-200 bg-gray-50 px-4 py-3">
          <div className="flex flex-wrap items-center gap-3">
            <Chip label="Duration" value={draftData.duration_seconds ? `${draftData.duration_seconds}s` : '—'} />
            <div className="h-4 w-px bg-gray-300" />
            <Chip label="Scenes"   value={String(scenes.length)} />
            <div className="h-4 w-px bg-gray-300" />
            <Chip label="Language" value={job.language} />
          </div>
          {isStoppable && (
            <Button
              variant="outline"
              size="sm"
              onClick={onCancel}
              disabled={cancelling}
              className="border-red-200 text-red-600 hover:bg-red-50 hover:text-red-700"
            >
              {cancelling ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
              Stop generation
            </Button>
          )}
        </div>
      )}

      {cancelError && (
        <div className="flex items-start justify-between gap-3 rounded-xl border border-red-200 bg-red-50 p-4">
          <div className="flex items-start gap-3">
            <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-red-500" />
            <p className="text-xs text-red-700">{cancelError}</p>
          </div>
        </div>
      )}

      {isPreApproval ? (
        <>
          {draftData?.script && (
            <Card>
              <CardContent className="space-y-1 p-4">
                <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">Script</p>
                <p className="whitespace-pre-wrap text-sm leading-relaxed text-gray-800">{draftData.script}</p>
              </CardContent>
            </Card>
          )}
          {draftData?.visual_description && (
            <Card>
              <CardContent className="space-y-1 p-4">
                <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">Visual concept</p>
                <p className="text-sm text-gray-700">{draftData.visual_description}</p>
              </CardContent>
            </Card>
          )}
          {scriptSaveError && (
            <div className="flex items-start justify-between gap-3 rounded-xl border border-red-200 bg-red-50 p-4">
              <div className="flex items-start gap-3">
                <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-red-500" />
                <p className="text-xs text-red-700">{scriptSaveError}</p>
              </div>
              <button onClick={() => setScriptSaveError(null)} className="shrink-0 text-xs text-red-500 hover:text-red-700">✕</button>
            </div>
          )}
          <div className="space-y-2">
            {scenes.map((scene) => {
              const narrationText = editedNarration[scene.id] ?? sceneNarrationText(scene.narration_intent)
              const wordCount = narrationWordCount(narrationText)
              const maxWords = maxNarrationWords(scene.target_duration_ms)
              const overBudget = overBudgetSceneIds.has(scene.id)
              const nearBudget = !overBudget && wordCount >= maxWords * 0.85
              return (
                <Card key={scene.id} className={`border-gray-200 ${overBudget ? 'border-red-300' : ''}`}>
                  <CardContent className="space-y-2 p-4">
                    <div className="mb-1 flex items-center justify-between">
                      <p className="text-xs font-semibold text-gray-500">Scene {scene.scene_number}</p>
                      <p className="text-xs text-gray-400">{Math.round(scene.target_duration_ms / 1000)}s</p>
                    </div>
                    <p className="text-sm text-gray-800">{scene.visual_description}</p>
                    {scene.shot_notes && <p className="text-xs text-gray-400">{scene.shot_notes}</p>}
                    <div>
                      <div className="mb-1 flex items-center justify-between">
                        <label className="block text-xs font-medium text-gray-500">Narration</label>
                        <p
                          className={`text-xs ${
                            overBudget ? 'font-medium text-red-600' : nearBudget ? 'text-amber-600' : 'text-gray-400'
                          }`}
                        >
                          {wordCount}/{maxWords} words
                        </p>
                      </div>
                      <Textarea
                        value={narrationText}
                        onChange={(e) => setEditedNarration((prev) => ({ ...prev, [scene.id]: e.target.value }))}
                        rows={2}
                        disabled={!isEditable || savingScript}
                        className={`text-sm ${overBudget ? 'border-red-400 focus-visible:ring-red-400' : ''}`}
                      />
                      {overBudget && (
                        <p className="mt-1 text-xs text-red-600">
                          Too long for this scene&apos;s {Math.round(scene.target_duration_ms / 1000)}s — trim to {maxWords} words or fewer.
                        </p>
                      )}
                    </div>
                  </CardContent>
                </Card>
              )
            })}
          </div>
          {isEditable && (
            <div className="flex items-center gap-3">
              <Button
                variant="outline"
                size="sm"
                onClick={handleSaveScript}
                disabled={savingScript || dirtySceneIds.length === 0 || overBudgetSceneIds.size > 0}
              >
                {savingScript ? (
                  <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Save className="mr-2 h-3.5 w-3.5" />
                )}
                Save script
              </Button>
              <p className="text-xs text-gray-400">
                Save your narration edits before approving — scenes lock once generation starts.
              </p>
            </div>
          )}
        </>
      ) : (
        <>
          {/* Shared "Production" section — no language selector, same for
             every viewer regardless of how many languages were requested
             (ARCHITECTURE.MD §12.1). */}
          <Card className="border-gray-200 bg-gray-50">
            <CardContent className="flex items-center justify-between p-4">
              <div>
                <p className="text-sm font-semibold text-gray-900">Shared production</p>
                <p className="mt-0.5 text-xs text-gray-500">
                  {pipeline.current_step ? pipeline.current_step.replace(/_/g, ' ') : pipeline.status}
                  {pipeline.scenes_total != null &&
                    ` · ${pipeline.scenes_visuals_ready_count}/${pipeline.scenes_total} scenes ready`}
                </p>
                {pipeline.status === 'failed' && pipeline.last_error && (
                  <p className="mt-1 text-xs text-red-600">{pipeline.last_error}</p>
                )}
              </div>
              <div className="flex items-center gap-2">
                <MiniStatusBadge status={pipeline.status} />
              </div>
            </CardContent>
          </Card>

          {/* One card per requested language track — same shape for
             EN-only/FR-only (one card) and BOTH (two cards), per §11. */}
          <div className="space-y-2">
            {tracks.map((track) => (
              <VideoTrackCard key={track.id} jobId={job.id} track={track} />
            ))}
          </div>
        </>
      )}

      {disabled && !isPreApproval && (
        <p className="text-xs text-gray-400">
          This page updates automatically as production progresses — no action needed here.
        </p>
      )}
    </div>
  )
}

// ─── ImageTabContent ──────────────────────────────────────────────────────────

function ImageTabContent({
  result,
  approveError,
  onClearApproveError,
}: {
  result: ImagePostResult
  approveError: string | null
  onClearApproveError: () => void
}) {
  const imageUrl    = imgField(result, 'image_url')
  const caption     = imgField(result, 'caption')
  const altText     = imgField(result, 'alt_text')
  const headlineText = imgField(result, 'headline_text')
  const subtitleText = imgField(result, 'subtitle_text')
  const hashtags    = imgHashtags(result)

  return (
    <div className="space-y-4 pb-4">
      {approveError && (
        <div className="flex items-start justify-between gap-3 rounded-xl border border-red-200 bg-red-50 p-4">
          <div className="flex items-start gap-3">
            <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-red-500" />
            <div>
              <p className="text-sm font-semibold text-red-800">Error</p>
              <p className="mt-0.5 text-xs text-red-700">{approveError}</p>
            </div>
          </div>
          <button onClick={onClearApproveError} className="shrink-0 text-xs text-red-500 hover:text-red-700">✕</button>
        </div>
      )}

      {/* Generated image */}
      {imageUrl && (
        <div className="overflow-hidden rounded-2xl border border-gray-200 shadow-sm">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={imageUrl} alt={altText || 'Generated image'} className="w-full object-cover" />
        </div>
      )}

      {/* Headline / subtitle overlay text */}
      {(headlineText || subtitleText) && (
        <Card className="border-gray-200 bg-gray-50">
          <CardContent className="p-4 space-y-1">
            {headlineText && <p className="text-sm font-bold text-gray-900">{headlineText}</p>}
            {subtitleText && <p className="text-sm text-gray-600">{subtitleText}</p>}
          </CardContent>
        </Card>
      )}

      {/* Caption */}
      {caption && (
        <Card>
          <CardContent className="p-4">
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-400">Caption</p>
            <p className="text-sm leading-relaxed text-gray-800 whitespace-pre-wrap">{caption}</p>
          </CardContent>
        </Card>
      )}

      {/* Hashtags */}
      {hashtags.length > 0 && (
        <Card>
          <CardContent className="p-4">
            <div className="mb-2 flex items-center gap-1.5">
              <Hash className="h-3.5 w-3.5 text-gray-400" />
              <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">Hashtags</p>
            </div>
            <div className="flex flex-wrap gap-2">
              {hashtags.map((tag, i) => (
                <span key={i} className="rounded-full bg-blue-50 px-2.5 py-1 text-xs font-medium text-blue-700">
                  {tag.startsWith('#') ? tag : `#${tag}`}
                </span>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Alt text */}
      {altText && (
        <Card>
          <CardContent className="p-4">
            <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-400">Alt Text</p>
            <p className="text-sm text-gray-600 italic">{altText}</p>
          </CardContent>
        </Card>
      )}
    </div>
  )
}

// ─── BlogTabContent ───────────────────────────────────────────────────────────

function BlogTabContent({
  editState,
  onChange,
  approveError,
  onClearApproveError,
  rawData,
  imageStyle,
  isEditable,
  dirty,
  onSave,
  saving,
  saveError,
  onClearSaveError,
}: {
  editState: BlogEditState
  onChange: (updates: Partial<BlogEditState>) => void
  approveError: string | null
  onClearApproveError: () => void
  rawData?: Record<string, unknown>
  imageStyle?: 'photo' | 'infographic'
  isEditable: boolean
  dirty: boolean
  onSave: () => void
  saving: boolean
  saveError: string | null
  onClearSaveError: () => void
}) {
  // 'infographic' images are 4:5 portrait with headline text along the top
  // edge and a CTA bar along the bottom edge (see worker's compose.ts) — a
  // short, wide h-48 object-cover box would crop off exactly that text, so
  // infographic previews get a taller, aspect-locked box with object-contain
  // instead of a hard crop. 'photo' stays on the original 1:1 crop box.
  const imagePreviewClassName =
    imageStyle === 'infographic' ? 'aspect-[4/5] w-full object-contain bg-gray-50' : 'h-48 w-full object-cover'
  const inlineSectionPreviewClassName =
    imageStyle === 'infographic' ? 'aspect-[4/5] w-full object-contain bg-gray-50' : 'h-40 w-full object-cover'
  const [showSEO, setShowSEO]     = useState(false)
  const [showImages, setShowImages] = useState(false)
  const [showRaw, setShowRaw]     = useState(false)

  const allEmpty =
    editState.post_title === '' &&
    editState.intro === '' &&
    editState.conclusion === '' &&
    editState.sections.length === 0

  const updateSection = (i: number, patch: Partial<BlogSection>) => {
    const next = editState.sections.map((s, idx) => idx === i ? { ...s, ...patch } : s)
    onChange({ sections: next })
  }

  const updateSEO    = (patch: Partial<BlogSEO>)    => onChange({ seo:    { ...editState.seo,    ...patch } })
  const updateCTA    = (patch: Partial<BlogCTA>)    => onChange({ cta:    { ...editState.cta,    ...patch } })
  const updateImages = (side: 'hero' | 'inline', patch: Partial<{ url: string; alt: string }>) =>
    onChange({ images: { ...editState.images, [side]: { ...editState.images[side], ...patch } } })

  return (
    <div className="space-y-4 pb-28">
      {/* Error */}
      {approveError && (
        <div className="flex items-start justify-between gap-3 rounded-xl border border-red-200 bg-red-50 p-4">
          <div className="flex items-start gap-3">
            <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-red-500" />
            <div>
              <p className="text-sm font-semibold text-red-800">Approve failed</p>
              <p className="mt-0.5 text-xs text-red-700">{approveError}</p>
            </div>
          </div>
          <button onClick={onClearApproveError} className="shrink-0 text-xs text-red-500 hover:text-red-700">✕</button>
        </div>
      )}

      {saveError && (
        <div className="flex items-start justify-between gap-3 rounded-xl border border-red-200 bg-red-50 p-4">
          <div className="flex items-start gap-3">
            <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-red-500" />
            <p className="text-xs text-red-700">{saveError}</p>
          </div>
          <button onClick={onClearSaveError} className="shrink-0 text-xs text-red-500 hover:text-red-700">✕</button>
        </div>
      )}

      {/* Meta row */}
      <div className="flex flex-wrap items-center gap-3 text-xs text-gray-500">
        {editState.seo.estimated_read_time && (
          <span className="flex items-center gap-1"><Clock className="h-3 w-3" />{editState.seo.estimated_read_time}</span>
        )}
        {editState.seo.focus_keyword && (
          <span className="rounded-full bg-blue-50 px-2 py-0.5 text-blue-700 font-medium">{editState.seo.focus_keyword}</span>
        )}
        {editState.post_status && (
          <span className="rounded-full bg-gray-100 px-2 py-0.5 capitalize">{editState.post_status}</span>
        )}
      </div>

      {/* Images preview — hero + inline side by side */}
      {(editState.images.hero.url || editState.images.inline.url) && (
        <div className={`grid gap-3 ${editState.images.hero.url && editState.images.inline.url ? 'grid-cols-2' : 'grid-cols-1'}`}>
          {editState.images.hero.url && (
            <div>
              <p className="mb-1 text-xs text-gray-400">Hero image</p>
              <div className="overflow-hidden rounded-xl border border-gray-200">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={editState.images.hero.url} alt={editState.images.hero.alt} className={imagePreviewClassName} />
              </div>
            </div>
          )}
          {editState.images.inline.url && (
            <div>
              <p className="mb-1 text-xs text-gray-400">Inline image</p>
              <div className="overflow-hidden rounded-xl border border-gray-200">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={editState.images.inline.url} alt={editState.images.inline.alt} className={imagePreviewClassName} />
              </div>
            </div>
          )}
        </div>
      )}

      {/* Post Title */}
      <div className="rounded-xl border border-gray-200 bg-white p-5">
        <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-gray-400">Post Title</p>
        <input
          className="w-full text-xl font-bold text-gray-900 outline-none placeholder:text-gray-300"
          value={editState.post_title}
          onChange={(e) => onChange({ post_title: e.target.value })}
          placeholder="Blog post title…"
        />
        {editState.post_slug && (
          <p className="mt-1.5 text-xs text-gray-400">/{editState.post_slug}</p>
        )}
      </div>

      {/* Introduction */}
      <Card>
        <CardContent className="p-4">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-400">Introduction</p>
          <Textarea
            className="resize-none text-sm leading-relaxed text-gray-700"
            rows={4}
            value={editState.intro}
            onChange={(e) => onChange({ intro: e.target.value })}
            placeholder="Introduction paragraph…"
          />
        </CardContent>
      </Card>

      {/* Sections */}
      {editState.sections.length > 0 && (
        <div className="space-y-3">
          {editState.sections.map((sec, i) => (
            <Card key={i}>
              <CardContent className="p-4 space-y-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">Section {i + 1}</p>

                {/* H2 heading */}
                <input
                  className="w-full font-semibold text-gray-900 outline-none placeholder:text-gray-300"
                  value={sec.heading}
                  onChange={(e) => updateSection(i, { heading: e.target.value })}
                  placeholder="Section heading (H2)…"
                />

                {/* Inline image indicator */}
                {sec.has_inline_image && editState.images.inline.url && (
                  <div className="overflow-hidden rounded-lg border border-gray-100">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={editState.images.inline.url} alt={editState.images.inline.alt} className={inlineSectionPreviewClassName} />
                  </div>
                )}

                {/* H3s */}
                {sec.h3s.length > 0 && (
                  <div>
                    <p className="mb-1 text-xs text-gray-400">H3 sub-headings (one per line)</p>
                    <Textarea
                      className="resize-none text-sm text-gray-700"
                      rows={sec.h3s.length + 1}
                      value={sec.h3s.join('\n')}
                      onChange={(e) => updateSection(i, { h3s: e.target.value.split('\n') })}
                      placeholder="Sub-heading…"
                    />
                  </div>
                )}

                {/* Paragraphs */}
                {sec.paragraphs.map((para, pi) => (
                  <Textarea
                    key={pi}
                    className="resize-none text-sm leading-relaxed text-gray-700"
                    rows={3}
                    value={para}
                    onChange={(e) => {
                      const next = sec.paragraphs.map((p, idx) => idx === pi ? e.target.value : p)
                      updateSection(i, { paragraphs: next })
                    }}
                    placeholder={`Paragraph ${pi + 1}…`}
                  />
                ))}

                {/* List items */}
                {sec.list_items.length > 0 && (
                  <div>
                    <p className="mb-1 text-xs text-gray-400">List items (one per line)</p>
                    <Textarea
                      className="resize-none text-sm text-gray-700"
                      rows={sec.list_items.length + 1}
                      value={sec.list_items.join('\n')}
                      onChange={(e) => updateSection(i, { list_items: e.target.value.split('\n') })}
                      placeholder="List item…"
                    />
                  </div>
                )}

                {/* Blockquote */}
                {sec.blockquote && (
                  <div className="rounded-lg border-l-4 border-amber-400 bg-amber-50 p-3 space-y-1">
                    <p className="text-xs text-gray-400">Blockquote</p>
                    <Textarea
                      className="resize-none text-sm italic text-gray-700"
                      rows={2}
                      value={sec.blockquote.text}
                      onChange={(e) => updateSection(i, { blockquote: { ...sec.blockquote!, text: e.target.value } })}
                      placeholder="Quote text…"
                    />
                    <input
                      className="w-full text-xs text-gray-500 outline-none placeholder:text-gray-300 bg-transparent"
                      value={sec.blockquote.cite}
                      onChange={(e) => updateSection(i, { blockquote: { ...sec.blockquote!, cite: e.target.value } })}
                      placeholder="— Citation"
                    />
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* CTA */}
      <Card className="border-blue-200 bg-blue-50/40">
        <CardContent className="p-4 space-y-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-blue-600">Call to Action</p>
          <input
            className="w-full font-semibold text-gray-900 outline-none placeholder:text-gray-300 bg-transparent"
            value={editState.cta.heading}
            onChange={(e) => updateCTA({ heading: e.target.value })}
            placeholder="CTA heading…"
          />
          <Textarea
            className="resize-none text-sm text-gray-700"
            rows={2}
            value={editState.cta.text}
            onChange={(e) => updateCTA({ text: e.target.value })}
            placeholder="CTA body text…"
          />
          <div className="flex gap-2">
            <input
              className="flex-1 rounded-lg border border-blue-200 bg-white px-3 py-1.5 text-sm text-gray-700 outline-none"
              value={editState.cta.button_label}
              onChange={(e) => updateCTA({ button_label: e.target.value })}
              placeholder="Button label…"
            />
            <input
              className="flex-1 rounded-lg border border-blue-200 bg-white px-3 py-1.5 text-sm text-gray-500 outline-none"
              value={editState.cta.button_url}
              onChange={(e) => updateCTA({ button_url: e.target.value })}
              placeholder="https://…"
            />
          </div>
        </CardContent>
      </Card>

      {/* Conclusion */}
      <Card>
        <CardContent className="p-4">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-400">Conclusion</p>
          <Textarea
            className="resize-none text-sm leading-relaxed text-gray-700"
            rows={4}
            value={editState.conclusion}
            onChange={(e) => onChange({ conclusion: e.target.value })}
            placeholder="Closing paragraph…"
          />
        </CardContent>
      </Card>

      {/* SEO collapsible */}
      <Card>
        <CardContent className="p-4">
          <button
            className="flex w-full items-center justify-between text-left"
            onClick={() => setShowSEO((v) => !v)}
          >
            <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">SEO Fields</p>
            <span className="text-xs text-gray-400">{showSEO ? '▲ Hide' : '▼ Show'}</span>
          </button>
          {showSEO && (
            <div className="mt-3 space-y-3">
              <div>
                <p className="mb-1 text-xs text-gray-400">SEO Title ({editState.seo.title.length}/60)</p>
                <input className="w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-1.5 text-sm outline-none"
                  value={editState.seo.title}
                  onChange={(e) => updateSEO({ title: e.target.value })}
                  placeholder="SEO title…" />
              </div>
              <div>
                <p className="mb-1 text-xs text-gray-400">Meta Description ({editState.seo.meta_description.length}/160)</p>
                <Textarea className="resize-none text-sm" rows={2}
                  value={editState.seo.meta_description}
                  onChange={(e) => updateSEO({ meta_description: e.target.value })}
                  placeholder="Meta description…" />
              </div>
              <div className="flex gap-2">
                <div className="flex-1">
                  <p className="mb-1 text-xs text-gray-400">Focus Keyword</p>
                  <input className="w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-1.5 text-sm outline-none"
                    value={editState.seo.focus_keyword}
                    onChange={(e) => updateSEO({ focus_keyword: e.target.value })}
                    placeholder="focus keyword" />
                </div>
                <div className="flex-1">
                  <p className="mb-1 text-xs text-gray-400">Slug</p>
                  <input className="w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-1.5 text-sm outline-none"
                    value={editState.seo.slug}
                    onChange={(e) => updateSEO({ slug: e.target.value })}
                    placeholder="url-slug" />
                </div>
              </div>
              <div>
                <p className="mb-1 text-xs text-gray-400">Secondary Keywords (comma-separated)</p>
                <input className="w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-1.5 text-sm outline-none"
                  value={editState.seo.secondary_keywords.join(', ')}
                  onChange={(e) => updateSEO({ secondary_keywords: e.target.value.split(',').map((t) => t.trim()).filter(Boolean) })}
                  placeholder="keyword1, keyword2…" />
                {editState.seo.secondary_keywords.length > 0 && (
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {editState.seo.secondary_keywords.map((kw, i) => (
                      <span key={i} className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-600">{kw}</span>
                    ))}
                  </div>
                )}
              </div>
              <div>
                <p className="mb-1 text-xs text-gray-400">OG Title</p>
                <input className="w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-1.5 text-sm outline-none"
                  value={editState.seo.og_title}
                  onChange={(e) => updateSEO({ og_title: e.target.value })}
                  placeholder="Open Graph title…" />
              </div>
              <div>
                <p className="mb-1 text-xs text-gray-400">OG Description</p>
                <Textarea className="resize-none text-sm" rows={2}
                  value={editState.seo.og_description}
                  onChange={(e) => updateSEO({ og_description: e.target.value })}
                  placeholder="Open Graph description…" />
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Images collapsible */}
      <Card>
        <CardContent className="p-4">
          <button
            className="flex w-full items-center justify-between text-left"
            onClick={() => setShowImages((v) => !v)}
          >
            <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">Images</p>
            <span className="text-xs text-gray-400">{showImages ? '▲ Hide' : '▼ Show'}</span>
          </button>
          {showImages && (
            <div className="mt-3 space-y-3">
              <div>
                <p className="mb-1 text-xs text-gray-400">Hero Image URL</p>
                <input className="w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-1.5 text-sm outline-none"
                  value={editState.images.hero.url}
                  onChange={(e) => updateImages('hero', { url: e.target.value })}
                  placeholder="https://…" />
                <input className="mt-1 w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-1.5 text-sm outline-none"
                  value={editState.images.hero.alt}
                  onChange={(e) => updateImages('hero', { alt: e.target.value })}
                  placeholder="Alt text…" />
              </div>
              <div>
                <p className="mb-1 text-xs text-gray-400">Inline Image URL</p>
                <input className="w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-1.5 text-sm outline-none"
                  value={editState.images.inline.url}
                  onChange={(e) => updateImages('inline', { url: e.target.value })}
                  placeholder="https://…" />
                <input className="mt-1 w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-1.5 text-sm outline-none"
                  value={editState.images.inline.alt}
                  onChange={(e) => updateImages('inline', { alt: e.target.value })}
                  placeholder="Alt text…" />
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Raw JSON debug — auto-shows when all fields empty */}
      {rawData && (allEmpty || showRaw) && (
        <Card className="border-dashed border-amber-300 bg-amber-50">
          <CardContent className="p-4">
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-amber-700">
                {allEmpty ? '⚠ No fields mapped — raw draft data' : 'Raw draft data'}
              </p>
              {!allEmpty && (
                <button onClick={() => setShowRaw(false)} className="text-xs text-amber-600 hover:text-amber-800">Hide</button>
              )}
            </div>
            <pre className="overflow-x-auto rounded-lg bg-white p-3 text-xs text-gray-700 border border-amber-200 max-h-64">
              {JSON.stringify(rawData, null, 2)}
            </pre>
          </CardContent>
        </Card>
      )}

      {rawData && !allEmpty && !showRaw && (
        <div className="text-center">
          <button onClick={() => setShowRaw(true)} className="text-xs text-gray-400 hover:text-gray-600 underline">
            Show raw draft data
          </button>
        </div>
      )}

      {/* Save — decoupled from Approve below (this button/handler is the only
         thing that persists an edit before the user clicks Approve; see
         POST /api/jobs/[jobId]/blog/draft's own header). Only shown while
         the draft is still editable (not yet approved). Placed at the
         bottom, after every editable field, rather than above them. */}
      {isEditable && (
        <div className="flex items-center gap-3 border-t border-gray-200 pt-4">
          <Button variant="outline" size="sm" onClick={onSave} disabled={saving || !dirty}>
            {saving ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : <Save className="mr-2 h-3.5 w-3.5" />}
            Save
          </Button>
          <p className="text-xs text-gray-400">
            {dirty ? 'You have unsaved edits.' : 'Save your edits before approving — the draft locks once approved.'}
          </p>
        </div>
      )}
    </div>
  )
}

// ─── Chip ─────────────────────────────────────────────────────────────────────

function Chip({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-xs text-gray-400">{label}</span>
      <span className="text-xs font-semibold text-gray-700">{value}</span>
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function JobDetailPage() {
  const { job_id } = useParams<{ job_id: string }>()
  const router = useRouter()

  const { addJob, updateJob } = useContentJobStore()
  const { clearAfterApproval, clearOnCancel } = useNewContentStore()

  const [loading, setLoading]     = useState(true)
  const [job, setJob]             = useState<ContentJob | null>(null)
  const [pageError, setPageError] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<ContentType>('video')

  // Drafts — keyed by `${content_type}::${language}` so EN and FR can coexist
  const [allDrafts, setAllDrafts] = useState<Map<string, ContentDraft>>(new Map())
  const [selectedLanguage, setSelectedLanguage] = useState<Map<ContentType, string>>(new Map())

  const getEffectiveLanguage = useCallback((type: ContentType): string => {
    const chosen = selectedLanguage.get(type)
    if (chosen) return chosen
    const jobLang = job?.language ?? 'EN'
    return jobLang === 'BOTH' ? 'EN' : jobLang
  }, [selectedLanguage, job?.language])

  const getDraft = useCallback((type: ContentType): ContentDraft | undefined => {
    return allDrafts.get(draftKey(type, getEffectiveLanguage(type)))
  }, [allDrafts, getEffectiveLanguage])

  const getAvailableLanguages = useCallback((type: ContentType): string[] => {
    const langs: string[] = []
    for (const key of allDrafts.keys()) {
      const [t, l] = key.split('::')
      if (t === type) langs.push(l)
    }
    return langs
  }, [allDrafts])

  // Switching language doesn't call Supabase — it only changes which
  // already-loaded draft is displayed, and refreshes blogEdit to match it.
  // (Video has no per-language draft/toggle anymore — see VideoStatusResponse.)
  const handleLanguageSwitch = useCallback((type: ContentType, lang: string) => {
    setSelectedLanguage((prev) => {
      const next = new Map(prev)
      next.set(type, lang)
      return next
    })
    const draft = allDrafts.get(draftKey(type, lang))
    if (!draft) return
    if (type === 'blog') {
      setBlogEdit(blogEditFromDraft(draft.draft_data))
    }
  }, [allDrafts])

  // Approval
  const [approvedTypes, setApprovedTypes] = useState<Set<ContentType>>(new Set())
  const [approving, setApproving]         = useState<ContentType | null>(null)
  const [approveErrors, setApproveErrors] = useState<Map<ContentType, string>>(new Map())

  // Blog editable state (mirrors blog draft_data, editable by user)
  const [blogEdit, setBlogEdit] = useState<BlogEditState | null>(null)

  // Image post result — polled from generated_content (separate from allDrafts)
  const [imageResult, setImageResult]   = useState<ImagePostResult | null>(null)
  const [imagePolling, setImagePolling] = useState(false)

  // Video pipeline/track status — fetched from GET /video/status, kept
  // entirely separate from allDrafts (see VideoStatusResponse's doc comment).
  const [videoStatus, setVideoStatus] = useState<VideoStatusResponse | null>(null)

  const loadVideoStatus = useCallback(async () => {
    const res = await fetch(`/api/jobs/${job_id}/video/status`)
    if (res.status === 404) { setVideoStatus(null); return }
    if (!res.ok) return
    const data = (await res.json()) as VideoStatusResponse
    setVideoStatus(data)
  }, [job_id])

  const [videoCancelling, setVideoCancelling] = useState(false)
  const [videoCancelError, setVideoCancelError] = useState<string | null>(null)

  const handleVideoCancel = useCallback(async () => {
    if (!window.confirm('Stop generating this video? Progress so far is kept, but nothing further will be generated.')) {
      return
    }
    setVideoCancelling(true)
    setVideoCancelError(null)
    const res = await fetch(`/api/jobs/${job_id}/video/cancel`, { method: 'POST' })
    if (!res.ok) {
      const b = await res.json().catch(() => ({}))
      setVideoCancelError(b.error ?? 'Failed to stop generation')
      setVideoCancelling(false)
      return
    }
    await loadVideoStatus()
    setVideoCancelling(false)
    // Without this, the New Content page's pending-generation banner
    // (src/stores/newContentStore.ts) stayed stuck on "in progress" forever
    // — cancelling here never touched that page's session state, only this
    // job's own pipeline/track rows.
    clearOnCancel(job_id)
  }, [job_id, loadVideoStatus, clearOnCancel])

  // Blog/image_post have no equivalent of videoStatus today (see that
  // state's own doc comment) — this is the minimal slice of it (just the
  // pipeline's status/last_error) needed to know whether generation has
  // already stopped server-side, so the "Stop generation" button's result
  // survives a page refresh instead of spinning forever.
  const [blogPipelineStatus, setBlogPipelineStatus] = useState<{ status: string; last_error: string | null } | null>(null)
  const [imagePipelineStatus, setImagePipelineStatus] = useState<{ status: string; last_error: string | null } | null>(null)

  const loadBlogStatus = useCallback(async () => {
    const res = await fetch(`/api/jobs/${job_id}/blog/status`)
    if (!res.ok) { setBlogPipelineStatus(null); return }
    const data = await res.json()
    setBlogPipelineStatus({ status: data.pipeline.status, last_error: data.pipeline.last_error })
  }, [job_id])

  const loadImageStatus = useCallback(async () => {
    const res = await fetch(`/api/jobs/${job_id}/image/status`)
    if (!res.ok) { setImagePipelineStatus(null); return }
    const data = await res.json()
    setImagePipelineStatus({ status: data.pipeline.status, last_error: data.pipeline.last_error })
  }, [job_id])

  const [blogCancelling, setBlogCancelling] = useState(false)
  const [blogCancelError, setBlogCancelError] = useState<string | null>(null)

  const [blogSaving, setBlogSaving] = useState(false)
  const [blogSaveError, setBlogSaveError] = useState<string | null>(null)

  // Decoupled from Approve (POST /api/jobs/[jobId]/blog/draft) — an edit
  // made pre-approval now persists on its own instead of only living in
  // blogEdit's React state until Approve is clicked (that bundled path,
  // inside handleContentApprove below, is unchanged and still works).
  // Plain function, not useCallback — this component isn't memoized, so
  // there's no stability requirement, and the compiler's own inferred deps
  // for this closure disagreed with any manual array tried here, which just
  // skips optimizing the whole component instead (see reloadDrafts above
  // for the same class of pre-existing issue).
  const handleBlogSave = async () => {
    const draft = getDraft('blog')
    if (!draft || !blogEdit) return
    setBlogSaving(true)
    setBlogSaveError(null)
    try {
      const res = await fetch(`/api/jobs/${job_id}/blog/draft`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ language: getEffectiveLanguage('blog'), draft_data: blogEditToDraftData(blogEdit) }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? `Save failed (status ${res.status})`)
      }
      const { draft: updated } = await res.json()
      setAllDrafts((prev) => {
        const next = new Map(prev)
        next.set(draftKey('blog', updated.language), updated as ContentDraft)
        return next
      })
      // Re-derive blogEdit from what actually got persisted, not just leave
      // it as the pre-save value — blogEditToDraftData regenerates html_final
      // (and could touch other fields) on every save, so the stored
      // draft_data is never byte-identical to the edit state that produced
      // it. Without this, blogDirty's blogEditFromDraft(draft.draft_data)
      // vs. blogEdit comparison stays true forever after the very first
      // save, showing "You have unsaved edits" even immediately after a
      // successful one.
      setBlogEdit(blogEditFromDraft((updated as ContentDraft).draft_data))
    } catch (err) {
      setBlogSaveError(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setBlogSaving(false)
    }
  }

  const handleBlogCancel = useCallback(async () => {
    if (!window.confirm('Stop generating this blog post? Progress so far is kept, but nothing further will be generated.')) return
    setBlogCancelling(true)
    setBlogCancelError(null)
    const res = await fetch(`/api/jobs/${job_id}/blog/cancel`, { method: 'POST' })
    if (!res.ok) {
      const b = await res.json().catch(() => ({}))
      setBlogCancelError(b.error ?? 'Failed to stop generation')
      setBlogCancelling(false)
      return
    }
    await loadBlogStatus()
    setBlogCancelling(false)
    clearOnCancel(job_id)
  }, [job_id, loadBlogStatus, clearOnCancel])

  const [imageCancelling, setImageCancelling] = useState(false)
  const [imageCancelError, setImageCancelError] = useState<string | null>(null)

  const handleImageCancel = useCallback(async () => {
    if (!window.confirm('Stop generating this image post? Progress so far is kept, but nothing further will be generated.')) return
    setImageCancelling(true)
    setImageCancelError(null)
    const res = await fetch(`/api/jobs/${job_id}/image/cancel`, { method: 'POST' })
    if (!res.ok) {
      const b = await res.json().catch(() => ({}))
      setImageCancelError(b.error ?? 'Failed to stop generation')
      setImageCancelling(false)
      return
    }
    await loadImageStatus()
    setImageCancelling(false)
    clearOnCancel(job_id)
  }, [job_id, loadImageStatus, clearOnCancel])

  // Timeout for long-running generation
  const [timedOut, setTimedOut] = useState(false)

  // Blog wait start — persisted in sessionStorage so back-navigation restores progress
  const [blogWaitStart, setBlogWaitStart] = useState<number | null>(null)

  const needsPolling = useMemo(() => {
    if (job && (job.status === 'pending' || job.status === 'draft_ready')) {
      const types: ContentType[] = job.content_types ?? []
      // image_post is polled separately via generated_content — exclude here
      return types.filter((t) => t !== 'image_post').some((t) => !getDraft(t))
    }
    // Also poll when video is generating/approved — realtime can miss the completion event
    if (job && (job.status === 'generating' || job.status === 'approved')) {
      return true
    }
    return false
  }, [job, allDrafts, getDraft])

  // ── Reload drafts from DB ────────────────────────────────────────────────────
  // Called by realtime handler AND by the polling interval.

  const reloadDrafts = useCallback(async () => {
    const [{ data: draftRows }, { data: freshJob }] = await Promise.all([
      supabase
        .from('content_drafts')
        .select('*')
        .eq('job_id', job_id)
        .order('created_at', { ascending: true }),
      supabase
        .from('content_jobs')
        .select('*')
        .eq('id', job_id)
        .single(),
    ])

    if (freshJob) {
      setJob(freshJob as ContentJob)
    }

    if (!draftRows) return

    const draftMap = new Map<string, ContentDraft>()
    const approvedCounts = new Map<ContentType, { total: number; approved: number }>()
    for (const row of draftRows as ContentDraft[]) {
      const lang = row.language || 'EN'
      draftMap.set(draftKey(row.content_type, lang), row)
      const c = approvedCounts.get(row.content_type) ?? { total: 0, approved: 0 }
      c.total += 1
      if (row.is_approved) c.approved += 1
      approvedCounts.set(row.content_type, c)
    }
    setAllDrafts(draftMap)
    const approved = new Set<ContentType>()
    for (const [type, c] of approvedCounts) {
      if (c.total > 0 && c.approved === c.total) approved.add(type)
    }
    setApprovedTypes(approved)

    const defaultLang = job?.language === 'BOTH' ? 'EN' : (job?.language ?? 'EN')

    const bd = draftMap.get(draftKey('blog', selectedLanguage.get('blog') ?? defaultLang))
    if (bd) setBlogEdit((prev) => prev ?? blogEditFromDraft(bd.draft_data))
  }, [job_id, job?.language, selectedLanguage])

  // ── Initial load ──────────────────────────────────────────────────────────────

  const loadData = useCallback(async () => {
    setLoading(true)
    setPageError(null)

    const [{ data: jobRow, error: jobErr }, { data: draftRows, error: draftErr }, { data: imgRows }] =
      await Promise.all([
        supabase.from('content_jobs').select('*').eq('id', job_id).single(),
        supabase.from('content_drafts').select('*').eq('job_id', job_id).order('created_at', { ascending: true }),
        // No .maybeSingle() — a BOTH job produces one row per language now
        // (previously one concatenated row), and .maybeSingle() throws once
        // more than one row matches.
        supabase.from('generated_content').select('*').eq('job_id', job_id).eq('content_type', 'image_post').eq('status', 'completed'),
      ])

    if (jobErr) { setPageError(jobErr.message); setLoading(false); return }
    if (!jobRow) { setPageError('Job not found'); setLoading(false); return }

    const j = jobRow as ContentJob
    setJob(j)

    // Set initial tab to first content type in the job
    if (j.content_types?.length) setActiveTab(j.content_types[0])

    if ((j.content_types as ContentType[])?.includes('video')) {
      loadVideoStatus()
    }
    if ((j.content_types as ContentType[])?.includes('blog')) {
      loadBlogStatus()
    }
    if ((j.content_types as ContentType[])?.includes('image_post')) {
      loadImageStatus()
    }

    if (!draftErr && draftRows) {
      const draftMap = new Map<string, ContentDraft>()
      const approvedCounts = new Map<ContentType, { total: number; approved: number }>()

      for (const row of draftRows as ContentDraft[]) {
        const lang = row.language || 'EN'
        draftMap.set(draftKey(row.content_type, lang), row)
        const c = approvedCounts.get(row.content_type) ?? { total: 0, approved: 0 }
        c.total += 1
        if (row.is_approved) c.approved += 1
        approvedCounts.set(row.content_type, c)
      }

      setAllDrafts(draftMap)
      const approved = new Set<ContentType>()
      for (const [type, c] of approvedCounts) {
        if (c.total > 0 && c.approved === c.total) approved.add(type)
      }
      setApprovedTypes(approved)

      const defaultLang = j.language === 'BOTH' ? 'EN' : j.language

      const bd = draftMap.get(draftKey('blog', defaultLang))
      if (bd) setBlogEdit(blogEditFromDraft(bd.draft_data))
    }

    // For a BOTH job, only treat image_post as done once BOTH an EN and FR
    // row exist — same reasoning as video below: one language finishing
    // does not mean the whole step is complete. Picking a row to actually
    // display: imageResult is a single value (not language-aware like
    // allDrafts), so prefer whichever language the job defaults to.
    if (imgRows && imgRows.length > 0) {
      const langsDone = new Set(imgRows.map((r) => r.language))
      const allLanguagesDone = j.language === 'BOTH' ? langsDone.has('EN') && langsDone.has('FR') : true
      if (allLanguagesDone) {
        const preferredLang = j.language === 'BOTH' ? 'EN' : j.language
        const preferred = imgRows.find((r) => r.language === preferredLang) ?? imgRows[0]
        setImageResult(preferred as ImagePostResult)
      }
    }

    // Check if job is stuck at 'generating' but video is already done.
    // For a BOTH job, only treat it as stuck-but-done once BOTH an EN and FR
    // row exist — a single language finishing does not mean the whole video
    // step is complete, and must not redirect the user away early.
    if (j.status === 'generating' && (j.content_types as ContentType[]).includes('video')) {
      const { data: videoRows } = await supabase
        .from('generated_content')
        .select('id, file_url, language')
        .eq('job_id', job_id)
        .eq('content_type', 'video')
        .not('file_url', 'is', null)

      const langsDone = new Set((videoRows ?? []).map((r) => r.language))
      const videoContent = j.language === 'BOTH'
        ? (langsDone.has('EN') && langsDone.has('FR') ? videoRows?.[0] : null)
        : (videoRows && videoRows.length > 0 ? videoRows[0] : null)

      if (videoContent) {
        // Video is ready but status wasn't updated — fix it and navigate
        await supabase.from('content_jobs')
          .update({ status: 'ready', updated_at: new Date().toISOString() })
          .eq('id', job_id)
        setJob({ ...j, status: 'ready' })
        updateJob(job_id, { status: 'completed', progress: 100 })
        setLoading(false)
        router.push(`/dashboard/jobs/${job_id}/social`)
        return
      }
    }

    setLoading(false)
  }, [job_id, loadVideoStatus, loadBlogStatus, loadImageStatus]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { loadData() }, [loadData])

  // ── Polling: keep checking DB while drafts are pending OR video is generating ──
  // Nothing writes content_jobs.status to 'draft_ready'/'ready' for any content
  // type anymore now that blog/image_post/video all run on the worker/pipeline
  // architecture (their real status lives in content_pipelines/
  // content_language_tracks instead) — this poll's own generated_content check
  // below is what actually catches video completion, independent of job.status.

  useEffect(() => {
    if (!needsPolling || timedOut) return

    const isGeneratingState = job?.status === 'generating' || job?.status === 'approved'
    const startedAt = Date.now()
    // Allow longer timeout for video generation (10 min) vs draft generation (3 min)
    const timeoutMs = isGeneratingState ? 10 * 60 * 1000 : 3 * 60 * 1000
    // Poll less frequently during generation (every 8s) vs draft waiting (every 4s)
    const pollInterval = isGeneratingState ? 8000 : 4000
    let active = true

    const poll = async () => {
      if (!active) return
      if (Date.now() - startedAt > timeoutMs) {
        setTimedOut(true)
        return
      }

      // Always reload drafts from content_drafts table
      await reloadDrafts()

      // During generating/approved state, also check job status + generated_content
      if (isGeneratingState) {
        // Check if job status changed in DB (realtime might have missed it)
        const { data: freshJob } = await supabase
          .from('content_jobs')
          .select('status')
          .eq('id', job_id)
          .single()

        if (freshJob?.status === 'ready') {
          setJob((prev) => prev ? { ...prev, status: 'ready' } : prev)
          updateJob(job_id, { status: 'completed', progress: 100 })
          router.push(`/dashboard/jobs/${job_id}/social`)
          return
        }

        // Also check generated_content for video completion. For a BOTH job,
        // only treat video as complete once both EN and FR rows exist —
        // otherwise we'd redirect away the moment the first language
        // finishes, hiding the toggle before the second one can be approved.
        const { data: videoRowsPoll } = await supabase
          .from('generated_content')
          .select('id, file_url, language')
          .eq('job_id', job_id)
          .eq('content_type', 'video')
          .not('file_url', 'is', null)

        const langsDonePoll = new Set((videoRowsPoll ?? []).map((r) => r.language))
        const videoContent = job?.language === 'BOTH'
          ? (langsDonePoll.has('EN') && langsDonePoll.has('FR') ? videoRowsPoll?.[0] : null)
          : (videoRowsPoll && videoRowsPoll.length > 0 ? videoRowsPoll[0] : null)

        if (videoContent) {
          setJob((prev) => prev ? { ...prev, status: 'ready' } : prev)
          updateJob(job_id, { status: 'completed', progress: 100 })
          router.push(`/dashboard/jobs/${job_id}/social`)
        }
      }
    }

    const id = setInterval(poll, pollInterval)
    return () => { active = false; clearInterval(id) }
  }, [needsPolling, timedOut, reloadDrafts, job?.status, job_id]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Blog wait progress — persist start time across navigation ────────────────

  useEffect(() => {
    if (!job) return
    const hasBlog = (job.content_types as ContentType[]).includes('blog')
    const key = `blog-wait-${job_id}`
    if (hasBlog && !getDraft('blog')) {
      const stored = sessionStorage.getItem(key)
      if (stored) {
        setBlogWaitStart(parseInt(stored, 10))
      } else {
        const now = Date.now()
        sessionStorage.setItem(key, String(now))
        setBlogWaitStart(now)
      }
    } else if (getDraft('blog')) {
      sessionStorage.removeItem(key)
      setBlogWaitStart(null)
    }
  }, [job, allDrafts, job_id, getDraft])

  // ── Realtime: all drafts for this job ─────────────────────────────────────────

  useEffect(() => {
    const updateDraft = (row: ContentDraft) => {
      const lang = row.language || 'EN'
      setAllDrafts((prev) => {
        const next = new Map(prev)
        next.set(draftKey(row.content_type, lang), row)
        return next
      })
      const currentLang = getEffectiveLanguage(row.content_type)
      if (row.content_type === 'blog' && lang === currentLang) {
        setBlogEdit(blogEditFromDraft(row.draft_data))
      }
      // Bump job status to draft_ready on first draft
      if (row.status === 'draft_ready') {
        setJob((prev) => prev ? { ...prev, status: 'draft_ready' } : prev)
      }
    }

    const channel = supabase
      .channel(`drafts-watch-${job_id}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'content_drafts', filter: `job_id=eq.${job_id}` },
        (payload) => updateDraft(payload.new as ContentDraft),
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'content_drafts', filter: `job_id=eq.${job_id}` },
        (payload) => updateDraft(payload.new as ContentDraft),
      )
      .subscribe()

    return () => { supabase.removeChannel(channel) }
  }, [job_id, getEffectiveLanguage])

  // ── Image post polling — polls generated_content every 10s ────────────────────
  // The worker (worker/src/steps/finalizeImageContent.ts) writes the result to
  // generated_content once the shared photo and this track's caption are both
  // ready (typically a couple of minutes). We poll until a row appears.

  useEffect(() => {
    if (!job) return
    const hasImagePost = (job.content_types as ContentType[]).includes('image_post')
    if (!hasImagePost || imageResult) return

    setImagePolling(true)
    let active = true
    let attempts = 0
    const MAX = 30 // 30 × 10s = 5 min

    const poll = async () => {
      if (!active || attempts >= MAX) {
        setImagePolling(false)
        return
      }
      attempts++
      // No .maybeSingle() — a BOTH job produces one row per language now,
      // and .maybeSingle() throws once more than one row matches, which
      // previously made this poll silently error out forever for BOTH jobs
      // (looking exactly like "images never generated") once both languages
      // completed, or redirect away the instant just one language finished.
      const { data, error } = await supabase
        .from('generated_content')
        .select('*')
        .eq('job_id', job_id)
        .eq('content_type', 'image_post')
        .eq('status', 'completed')

      if (error) {
        console.error('[ImagePost] poll error:', error.message)
        return
      }

      if (data && data.length > 0) {
        const langsDone = new Set(data.map((r) => r.language))
        const allLanguagesDone = job?.language === 'BOTH' ? langsDone.has('EN') && langsDone.has('FR') : true
        if (!allLanguagesDone) return // still waiting on the other language

        const preferredLang = job?.language === 'BOTH' ? 'EN' : job?.language
        const preferred = data.find((r) => r.language === preferredLang) ?? data[0]
        setImageResult(preferred as ImagePostResult)
        setImagePolling(false)
        // image_post has no manual "Approve" click to route through (unlike
        // blog/video's handleContentApprove/handleVideoApprove, the only
        // other callers of clearAfterApproval) — this auto-redirect IS its
        // approval-equivalent moment. Without this call, the "New Content"
        // page's pending-generation banner (src/stores/newContentStore.ts)
        // stayed stuck forever for any image_post-only job, since nothing
        // else ever clears it once the user is bounced straight to the
        // library instead of landing on an approve screen.
        clearAfterApproval(job_id)
        // Auto-redirect to Library images section, highlighted
        router.push(`/dashboard/library?section=images&highlight=${job_id}`)
      }
    }

    const id = setInterval(poll, 10000)
    poll() // immediate first check
    return () => { active = false; clearInterval(id) }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.id, imageResult])

  // ── Video status polling — worker/src/index.ts's own tick, not realtime ──────
  // Video's pipeline/tracks are written by the worker process directly, with
  // no realtime subscription wired for them — the job-status realtime handler
  // below watches content_jobs.status, which nothing writes for video anymore.
  // Polls GET /video/status until every requested track (and the shared
  // pipeline) reaches a terminal state.

  useEffect(() => {
    if (!job) return
    const hasVideo = (job.content_types as ContentType[]).includes('video')
    if (!hasVideo) return

    const isTerminal = (status: string) => status === 'ready' || status === 'failed'
    const allTracksReady = videoStatus && videoStatus.tracks.length > 0 && videoStatus.tracks.every((t) => t.status === 'ready')

    if (allTracksReady && job.status !== 'ready') {
      supabase.from('content_jobs').update({ status: 'ready', updated_at: new Date().toISOString() }).eq('id', job_id).then(() => {})
      setJob((prev) => (prev ? { ...prev, status: 'ready' } : prev))
      updateJob(job_id, { status: 'completed', progress: 100 })
      router.push(`/dashboard/jobs/${job_id}/social`)
      return
    }
    if (videoStatus && isTerminal(videoStatus.pipeline.status) && videoStatus.tracks.every((t) => isTerminal(t.status)) && videoStatus.tracks.length > 0) {
      return // nothing left to poll for (includes a failed outcome)
    }

    let active = true
    const poll = async () => {
      if (!active) return
      await loadVideoStatus()
    }
    const id = setInterval(poll, 6000)
    return () => { active = false; clearInterval(id) }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.id, job?.status, videoStatus?.pipeline.status, videoStatus?.tracks.map((t) => t.status).join(',')])

  // ── Realtime: job status ─────────────────────────────────────────────────────
  // Nothing writes content_jobs.status to 'draft_ready'/'ready' anymore for any
  // content type (blog/image_post/video all moved onto the worker/pipeline
  // architecture — see ActiveGenerationBanner.tsx), so this subscription is
  // effectively dormant today; kept as a harmless no-op rather than removed
  // outright, since content_jobs.status is still a real column other code
  // reads (e.g. the 'failed' transition worker/src/db.ts writes).

  useEffect(() => {
    const channel = supabase
      .channel(`job-status-${job_id}`)
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'content_jobs', filter: `id=eq.${job_id}` },
        (payload) => {
          const updated = payload.new as ContentJob
          setJob(updated)

          if (updated.status === 'draft_ready') reloadDrafts()

          if (updated.status === 'ready') {
            updateJob(job_id, { status: 'completed', progress: 100 })
            router.push(`/dashboard/jobs/${job_id}/social`)
          }
        },
      )
      .subscribe()

    return () => { supabase.removeChannel(channel) }
  }, [job_id, router, reloadDrafts])

  // ── Video approve handler ────────────────────────────────────────────────────
  // Locks the master script and creates one content_language_tracks row per
  // requested language, all in a single call to the new backend
  // (ARCHITECTURE.MD §9) — requestedLanguages: ["EN","FR"] IS what "BOTH"
  // means; there is no separate video_approve_both path to maintain.

  const handleVideoApprove = async () => {
    if (!job) return
    setApproving('video')
    setApproveErrors((prev) => { const m = new Map(prev); m.delete('video'); return m })

    const requestedLanguages = job.language === 'BOTH' ? ['EN', 'FR'] : [job.language]

    const res = await fetch(`/api/jobs/${job_id}/video/approve`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ requestedLanguages }),
    })
    if (!res.ok) {
      const b = await res.json().catch(() => ({}))
      setApproveErrors((prev) => { const m = new Map(prev); m.set('video', b.error ?? 'Failed to approve'); return m })
      setApproving(null)
      return
    }

    await loadVideoStatus()
    await supabase.from('content_jobs')
      .update({ status: 'generating' })
      .eq('id', job_id)

    const newApprovedVideo = new Set([...approvedTypes, 'video' as ContentType])
    setApprovedTypes(newApprovedVideo)
    setJob((prev) => prev ? { ...prev, status: 'generating' } : prev)
    setApproving(null)
    addJob({ jobId: job_id, topic: job.topic, type: 'video', status: 'generating', progress: 0 })
    clearAfterApproval(job_id)
    const allTypesVideo = (job.content_types as ContentType[])
    if (allTypesVideo.length > 1 && allTypesVideo.every((t) => newApprovedVideo.has(t))) {
      router.push(`/dashboard/library?track=${job_id}`)
    }
  }

  // ── Image / Blog approve handler ──────────────────────────────────────────────

  const handleContentApprove = async (type: 'image_post' | 'blog') => {
    if (!job) return

    setApproving(type)
    setApproveErrors((prev) => { const m = new Map(prev); m.delete(type); return m })

    // image_post: result already in generated_content — flip each language's
    // track to 'ready' (mirrors blog's per-language approve), then mark the
    // job approved and redirect. Generation for a BOTH job isn't considered
    // ready until both languages exist (see the polling fix above), so both
    // are safe to approve here.
    if (type === 'image_post') {
      const imageLanguages = job.language === 'BOTH' ? ['EN', 'FR'] : [job.language]
      for (const lang of imageLanguages) {
        const approveRes = await fetch(`/api/jobs/${job_id}/image/tracks/${lang}/approve`, { method: 'POST' })
        if (!approveRes.ok) {
          const b = await approveRes.json().catch(() => ({}))
          setApproveErrors((prev) => { const m = new Map(prev); m.set(type, `[${lang}] ${b.error ?? 'Failed to approve'}`); return m })
          setApproving(null)
          return
        }
      }

      await supabase.from('content_jobs')
        .update({ status: 'approved', updated_at: new Date().toISOString() })
        .eq('id', job_id)
      const newApproved = new Set([...approvedTypes, 'image_post' as ContentType])
      setApprovedTypes(newApproved)
      setJob((prev) => prev ? { ...prev, status: 'approved' } : prev)
      setApproving(null)
      addJob({ jobId: job_id, topic: job.topic, type: 'image_post', status: 'completed', progress: 100 })
      clearAfterApproval(job_id)
      const allTypes = (job.content_types as ContentType[])
      if (allTypes.length > 1) {
        if (allTypes.every((t) => newApproved.has(t))) {
          router.push(`/dashboard/library?track=${job_id}`)
        }
      } else {
        router.push(`/dashboard/library?section=images&highlight=${job_id}`)
      }
      return
    }

    const draft = getDraft(type)
    if (!draft) { setApproving(null); return }
    const draftLang = getEffectiveLanguage(type)

    // For blog: save edited content to DB first
    let finalDraftData = draft.draft_data
    if (type === 'blog' && blogEdit) {
      finalDraftData = blogEditToDraftData(blogEdit)
      const saveRes = await fetch(`/api/jobs/${job_id}/draft`, {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ draft_data: finalDraftData, content_type: 'blog', language: draftLang }),
      })
      if (!saveRes.ok) {
        const b = await saveRes.json().catch(() => ({}))
        setApproveErrors((prev) => { const m = new Map(prev); m.set(type, b.error ?? 'Failed to save edits'); return m })
        setApproving(null)
        return
      }
    }

    // Backend now owns the whole blog approve transaction — writes
    // generated_content, flips content_drafts.is_approved/status, AND the
    // content_language_tracks status (draft_ready/stale -> ready). Fixes the
    // old client-side write here duplicating what the callback route did for
    // every other content type (ARCHITECTURE.MD §11).
    //
    // For a BOTH job, one click approves every language that has a real
    // draft — mirrors handleVideoApprove. Without this, only the currently
    // active language tab (defaulting to EN) ever gets published to
    // generated_content, and the other language silently never appears in
    // the Library even though the worker generated it correctly.
    const languagesToApprove = job.language === 'BOTH' ? getAvailableLanguages('blog') : [draftLang]

    for (const lang of languagesToApprove) {
      const approveRes = await fetch(`/api/jobs/${job_id}/blog/tracks/${lang}/approve`, {
        method: 'POST',
      })
      if (!approveRes.ok) {
        const b = await approveRes.json().catch(() => ({}))
        setApproveErrors((prev) => { const m = new Map(prev); m.set(type, `[${lang}] ${b.error ?? 'Failed to approve'}`); return m })
        setApproving(null)
        return
      }
    }

    const newApprovedFinal = new Set([...approvedTypes, type])
    setApprovedTypes(newApprovedFinal)
    setAllDrafts((prev) => {
      const next = new Map(prev)
      const key = draftKey(type, draftLang)
      const existing = next.get(key)
      if (existing) next.set(key, { ...existing, is_approved: true, status: 'approved' })
      return next
    })
    if (type === 'blog') {
      const blogTopic = (blogEdit ?? blogEditFromDraft(getDraft('blog')?.draft_data ?? {})).post_title || job.topic
      addJob({ jobId: job_id, topic: blogTopic, type: 'blog', status: 'completed', progress: 100 })
    }
    setApproving(null)
    clearAfterApproval(job_id)
    // Multi-type: redirect to tracker when all content types are approved
    const allTypesFinal = (job.content_types as ContentType[])
    if (allTypesFinal.length > 1 && allTypesFinal.every((t) => newApprovedFinal.has(t))) {
      router.push(`/dashboard/library?track=${job_id}`)
    }
  }

  // ── Render helpers ─────────────────────────────────────────────────────────────

  const renderTabContent = (type: ContentType) => {
    const draft = getDraft(type)

    // ── image_post: uses generated_content, not content_drafts ──────────────
    if (type === 'image_post') {
      if (!imageResult) {
        return (
          <WaitingCard
            type="image_post"
            topic={job?.topic ?? ''}
            timedOut={false}
            onRefresh={() => loadData()}
            terminalError={imagePipelineStatus?.status === 'failed' ? imagePipelineStatus.last_error : null}
            onCancel={handleImageCancel}
            cancelling={imageCancelling}
            cancelError={imageCancelError}
          />
        )
      }
      return (
        <ImageTabContent
          result={imageResult}
          approveError={approveErrors.get('image_post') ?? null}
          onClearApproveError={() =>
            setApproveErrors((prev) => { const m = new Map(prev); m.delete('image_post'); return m })
          }
        />
      )
    }

    // ── video: driven by videoStatus (GET /video/status), not content_drafts —
    // see VideoStatusResponse's doc comment for why it's kept separate ────────
    if (type === 'video') {
      const isPending = !videoStatus || videoStatus.pipeline.status === 'created' || videoStatus.pipeline.status === 'drafting'
      if (isPending) {
        return (
          <WaitingCard
            type="video"
            topic={job?.topic ?? ''}
            timedOut={timedOut}
            onRefresh={() => { setTimedOut(false); loadVideoStatus() }}
          />
        )
      }
      return (
        <VideoTabContent
          job={job!}
          videoStatus={videoStatus}
          disabled={approvedTypes.has('video') || approving === 'video'}
          approveError={approveErrors.get('video') ?? null}
          onClearApproveError={() =>
            setApproveErrors((prev) => { const m = new Map(prev); m.delete('video'); return m })
          }
          onCancel={handleVideoCancel}
          cancelling={videoCancelling}
          cancelError={videoCancelError}
          onScriptSaved={loadVideoStatus}
        />
      )
    }

    // ── blog: wait until content_drafts row exists and is not pending ────────
    const isPendingStatus = draft?.status === 'pending' && job?.status === 'pending'
    if (!draft || isPendingStatus) {
      return (
        <WaitingCard
          type={type}
          topic={job?.topic ?? ''}
          timedOut={timedOut}
          onRefresh={() => {
            setTimedOut(false)
            loadData()
          }}
          startedAt={type === 'blog' ? blogWaitStart : null}
          terminalError={blogPipelineStatus?.status === 'failed' ? blogPipelineStatus.last_error : null}
          onCancel={handleBlogCancel}
          cancelling={blogCancelling}
          cancelError={blogCancelError}
        />
      )
    }

    // Dirty-check via blogEditFromDraft on both sides (not a raw draft_data
    // diff) — blogEditToDraftData/blogEditFromDraft round-trip isn't
    // byte-identical to the stored shape (html_final is regenerated, some
    // legacy fields are dropped), so comparing raw JSON would show "dirty"
    // even with zero real edits.
    const currentBlogEdit = blogEdit ?? blogEditFromDraft(draft.draft_data)
    const blogDirty = JSON.stringify(currentBlogEdit) !== JSON.stringify(blogEditFromDraft(draft.draft_data))

    return (
      <BlogTabContent
        editState={currentBlogEdit}
        onChange={(updates) => setBlogEdit((prev) => ({ ...(prev ?? blogEditFromDraft(draft.draft_data)), ...updates }))}
        approveError={approveErrors.get('blog') ?? null}
        onClearApproveError={() =>
          setApproveErrors((prev) => { const m = new Map(prev); m.delete('blog'); return m })
        }
        rawData={draft.draft_data}
        imageStyle={job?.image_style}
        isEditable={!draft.is_approved}
        dirty={blogDirty}
        onSave={handleBlogSave}
        saving={blogSaving}
        saveError={blogSaveError}
        onClearSaveError={() => setBlogSaveError(null)}
      />
    )
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Loading
  // ─────────────────────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="h-14 w-full animate-pulse rounded-xl bg-gray-100" />
        <div className="h-8 w-48 animate-pulse rounded-lg bg-gray-100" />
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-48 w-full animate-pulse rounded-xl bg-gray-100" />
        ))}
      </div>
    )
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Error / Not found
  // ─────────────────────────────────────────────────────────────────────────────

  if (pageError || !job) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-center">
        <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-red-50">
          <AlertCircle className="h-8 w-8 text-red-400" />
        </div>
        <h3 className="text-base font-semibold text-gray-700">
          {pageError ?? 'Job not found'}
        </h3>
        <div className="mt-6 flex gap-3">
          <Button variant="outline" onClick={() => router.push('/dashboard')}>
            Back to Dashboard
          </Button>
          <Button onClick={loadData}>
            <RefreshCw className="mr-2 h-4 w-4" />
            Retry
          </Button>
        </div>
      </div>
    )
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Ready — content generated
  // ─────────────────────────────────────────────────────────────────────────────

  if (job.status === 'ready') {
    return (
      <div className="space-y-6">
        <TopBar
          title={job.topic}
          breadcrumbs={[
            { label: 'Dashboard', href: '/dashboard' },
            { label: job.topic.length > 32 ? job.topic.slice(0, 32) + '…' : job.topic },
          ]}
          actions={<StatusBadge status={job.status} />}
        />
        <Card className="border-green-200 bg-green-50">
          <CardContent className="flex flex-col items-center gap-4 py-10 text-center">
            <div className="flex h-16 w-16 items-center justify-center rounded-full bg-green-100">
              <CheckCircle2 className="h-8 w-8 text-green-600" />
            </div>
            <div>
              <p className="text-lg font-semibold text-green-900">Content is Ready!</p>
              <p className="mt-1 text-sm text-green-700">
                Your content has been generated. Review and schedule your social posts.
              </p>
            </div>
            <Button
              className="bg-green-600 hover:bg-green-700"
              onClick={() => router.push(`/dashboard/jobs/${job_id}/social`)}
            >
              <Sparkles className="mr-2 h-4 w-4" />
              Review &amp; Post to Social
            </Button>
          </CardContent>
        </Card>
      </div>
    )
  }

  const contentTypes = job.content_types as ContentType[]
  const isGenerating = job.status === 'generating' || job.status === 'approved'

  // Derive action bar state for the currently active tab
  const activeDraft    = getDraft(activeTab)
  const tabApproved    = approvedTypes.has(activeTab)
  const videoGenerating = activeTab === 'video' && !!videoStatus && videoStatus.pipeline.status !== 'created' && videoStatus.pipeline.status !== 'drafting' && videoStatus.pipeline.status !== 'draft_ready'
  const activeTabReady  =
    activeTab === 'image_post' ? !!imageResult :
    activeTab === 'video' ? videoStatus?.pipeline.status === 'draft_ready' :
    (!!activeDraft && (activeDraft.status !== 'pending' || job?.status === 'draft_ready'))
  const showActionBar  =
    activeTabReady &&
    !videoGenerating &&
    approving !== activeTab

  // ─────────────────────────────────────────────────────────────────────────────
  // Main editor
  // ─────────────────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-6 pb-28">

      <TopBar
        title={job.topic}
        breadcrumbs={[
          { label: 'Dashboard', href: '/dashboard' },
          { label: job.topic.length > 32 ? job.topic.slice(0, 32) + '…' : job.topic },
        ]}
        actions={<StatusBadge status={job.status} />}
      />

      {/* Video generating banner — only when video is actually one of the content types */}
      {isGenerating && (job.content_types as ContentType[]).includes('video') && (
        <div className="flex items-start gap-3 rounded-xl border border-blue-200 bg-blue-50 p-4">
          <Loader2 className="mt-0.5 h-5 w-5 shrink-0 animate-spin text-blue-500" />
          <div>
            <p className="text-sm font-semibold text-blue-800">Generating video…</p>
            <p className="mt-0.5 text-xs text-blue-600">
              This page updates automatically as production progresses.
            </p>
          </div>
        </div>
      )}

      {/* Tabs (multi-type) or direct content (single type) */}
      {contentTypes.length > 1 ? (
        <Tabs
          value={activeTab}
          onValueChange={(v) => setActiveTab(v as ContentType)}
        >
          <TabsList
            className="grid w-full"
            style={{ gridTemplateColumns: `repeat(${contentTypes.length}, 1fr)` }}
          >
            {contentTypes.map((type) => {
              const d = getDraft(type)
              const imgReady = type === 'image_post' && !!imageResult
              const isPending =
                type === 'image_post' ? imagePolling :
                type === 'video' ? (!videoStatus || videoStatus.pipeline.status === 'created' || videoStatus.pipeline.status === 'drafting') :
                (d?.status === 'pending' && job?.status === 'pending')
              const isDraftReady =
                type === 'image_post' ? imgReady :
                type === 'video' ? videoStatus?.pipeline.status === 'draft_ready' :
                (d?.status === 'draft_ready' || (d?.status === 'pending' && job?.status === 'draft_ready'))
              return (
                <TabsTrigger key={type} value={type} className="gap-1.5">
                  {TYPE_ICONS[type]}
                  {TYPE_LABELS[type]}
                  {isPending ? (
                    <Loader2 className="ml-1 h-3 w-3 animate-spin text-blue-400" />
                  ) : approvedTypes.has(type) ? (
                    <CheckCircle2 className="ml-1 h-3 w-3 text-green-500" />
                  ) : isDraftReady ? (
                    <span className="ml-1 inline-block h-1.5 w-1.5 rounded-full bg-amber-400" />
                  ) : null}
                </TabsTrigger>
              )
            })}
          </TabsList>

          {contentTypes.map((type) => (
            <TabsContent key={type} value={type} className="mt-4">
              {/* Video has no per-language toggle here — the master script is
                 reviewed once, language-neutral; per-language results show
                 up as separate track cards inside VideoTabContent instead
                 (ARCHITECTURE.MD §12.1). */}
              {type !== 'video' && (
                <LanguageToggle
                  languages={getAvailableLanguages(type)}
                  selected={getEffectiveLanguage(type)}
                  onSelect={(lang) => handleLanguageSwitch(type, lang)}
                  disabled={approving === type}
                />
              )}
              {renderTabContent(type)}
            </TabsContent>
          ))}
        </Tabs>
      ) : (
        <>
          {contentTypes[0] !== 'video' && (
            <LanguageToggle
              languages={getAvailableLanguages(contentTypes[0])}
              selected={getEffectiveLanguage(contentTypes[0])}
              onSelect={(lang) => handleLanguageSwitch(contentTypes[0], lang)}
              disabled={approving === contentTypes[0]}
            />
          )}
          {renderTabContent(contentTypes[0])}
        </>
      )}

      {/* ── Sticky action bar ────────────────────────────────────────────── */}
      {showActionBar && (
        <div className="fixed bottom-0 left-0 right-0 z-20 border-t border-gray-200 bg-white/95 px-4 py-3 shadow-[0_-4px_16px_rgba(0,0,0,0.06)] backdrop-blur-sm md:left-64">
          <div className="mx-auto flex max-w-4xl items-center justify-between gap-3">
            <div className="text-xs text-gray-400">
              {activeTab === 'video' && videoStatus && (() => {
                const d = videoStatus.draft?.draft_data
                return d?.duration_seconds
                  ? `${videoStatus.scenes.length} scenes · ${d.duration_seconds}s`
                  : 'Script ready for approval'
              })()}
              {activeTab === 'image_post' && 'Image brief ready for approval'}
              {activeTab === 'blog' && (() => {
                const wc = (activeDraft?.draft_data as Record<string, unknown>)?.word_count
                return wc ? `${Number(wc).toLocaleString()} words · ready for approval` : 'Blog post ready for approval'
              })()}
            </div>

            <div className="flex items-center gap-2">
              <Button
                onClick={() =>
                  activeTab === 'video'
                    ? handleVideoApprove()
                    : handleContentApprove(activeTab as 'image_post' | 'blog')
                }
                disabled={approving === activeTab}
                className="bg-gray-900 hover:bg-gray-800"
              >
                {approving === activeTab ? (
                  <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Approving…</>
                ) : activeTab === 'video' ? (
                  <><Zap className="mr-2 h-4 w-4" />{TYPE_APPROVE_LABEL.video}</>
                ) : (
                  <><CheckCircle2 className="mr-2 h-4 w-4" />{TYPE_APPROVE_LABEL[activeTab]}</>
                )}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Approved state bar — shown after approval for non-generating types */}
      {tabApproved && (
        <div className="fixed bottom-0 left-0 right-0 z-20 border-t border-green-200 bg-green-50/95 px-4 py-3 backdrop-blur-sm md:left-64 mb-16 shadow-[0_-4px_16px_rgba(0,0,0,0.06)]">
          <div className="mx-auto flex max-w-4xl items-center justify-center gap-2 text-sm text-green-700">
            <CheckCircle2 className="h-4 w-4 text-green-500" />
            <span className="font-medium">{TYPE_LABELS[activeTab]} approved</span>
            <span className="text-green-600">· Edits will be saved automatically</span>
          </div>
        </div>
      )}

    </div>
  )
}