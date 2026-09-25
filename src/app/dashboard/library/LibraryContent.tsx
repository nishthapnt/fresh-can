'use client'

import { useEffect, useState, useCallback, useMemo, useRef } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import TopBar from '@/components/layout/TopBar'
import { supabase } from '@/lib/supabase'
import {
  getVideoLibrary,
  getImageLibrary,
  getBlogLibrary,
  getPostedContent,
  getSocialConnectionStatus,
} from '@/services/contentService'
import type {
  VideoLibraryItem,
  ImageLibraryItem,
  BlogLibraryItem,
  PlatformConnectionMap,
  ContentType,
  PlatformType,
} from '@/types/content'
import { formatDateTime } from '@/lib/dateUtils'
import {
  AlertCircle,
  ArrowUpDown,
  BookOpen,
  CheckCircle2,
  Clock,
  Download,
  ExternalLink,
  FileText,
  FileVideo,
  Image as ImageIcon,
  Loader2,
  Play,
  RefreshCw,
  Search,
  Send,
  Share2,
  Sparkles,
  Tag,
  Trash2,
} from 'lucide-react'
async function getPostedJobIds(contentType: string): Promise<Set<string>> {
  const { data } = await supabase
    .from('social_posts')
    .select('job_id')
    .eq('status', 'posted')
    .eq('content_type', contentType)
  return new Set((data ?? []).map((p: { job_id: string }) => p.job_id))
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

const PLATFORM_OPTIONS: { id: PlatformType; label: string }[] = [
  { id: 'instagram', label: 'Instagram' },
  { id: 'facebook',  label: 'Facebook'  },
  { id: 'x',         label: 'X / Twitter' },
]

// ─── PostModal ────────────────────────────────────────────────────────────────

interface PostTarget {
  job_id: string
  topic: string
  content_type: ContentType
  language: 'EN' | 'FR'
  media_url: string | null
  media_type: 'video' | 'image' | 'blog'
  prefill_caption?: string
  prefill_hashtags?: string
}

// Library items' own `.language` (VideoLibraryItem/ImageLibraryItem/
// BlogLibraryItem) can be '' or 'BOTH' for legacy rows that predate — or,
// for blog, still fall back to — content_jobs.language rather than their
// own generated_content.language (see contentService.ts's getBlogLibrary).
// social_posts.language is EN/FR only (never BOTH — same restriction
// content_language_tracks already uses), so normalize the same way the
// dashboard's own language toggles default a BOTH job: FR only if it's
// exactly FR, EN otherwise.
function toPostLanguage(language: string): 'EN' | 'FR' {
  return language === 'FR' ? 'FR' : 'EN'
}

function PostModal({
  target,
  open,
  onClose,
}: {
  target: PostTarget
  open: boolean
  onClose: () => void
}) {
  const [platforms, setPlatforms] = useState<PlatformType[]>(['instagram'])
  const [caption, setCaption]     = useState('')
  const [hashtags, setHashtags]   = useState('')
  const [phase, setPhase]         = useState<'idle' | 'posting' | 'success' | 'error'>('idle')
  const [errorMsg, setErrorMsg]   = useState('')
  // Fetched on open rather than threaded down from LibraryContent's root —
  // PostModal is instantiated once per card across three separate
  // component trees (Video/Image/BlogSection), and only one is ever open
  // at a time, so a fetch-on-open here is one lightweight GET per modal
  // open instead of prop-drilling through six components for a shared value.
  const [connectionStatus, setConnectionStatus] = useState<PlatformConnectionMap | null>(null)

  useEffect(() => {
    if (open) {
      setCaption(target.prefill_caption ?? `✨ ${target.topic}\n\nBrought to you by Fresh-CAN 🌿`)
      setHashtags(target.prefill_hashtags ?? '#FreshCAN #FoodDesert #FreshProduce #Community')
      setPlatforms(['instagram'])
      setPhase('idle')
      setErrorMsg('')
      getSocialConnectionStatus().then((res) => setConnectionStatus(res.platforms))
    }
  }, [open, target.topic, target.prefill_caption, target.prefill_hashtags])

  const togglePlatform = (id: PlatformType) => {
    setPlatforms((prev) =>
      prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id],
    )
  }

  const handlePost = async () => {
    if (!platforms.length) return
    setPhase('posting')
    setErrorMsg('')
    try {
      const res = await fetch('/api/social/post', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          job_id: target.job_id,
          content_type: target.content_type,
          language: target.language,
          caption,
          hashtags: hashtags.split(/[\s,]+/).filter((h) => h.startsWith('#')),
          platforms,
        }),
      })
      if (!res.ok) {
        const b = await res.json().catch(() => ({}))
        throw new Error((b as { error?: string }).error ?? `HTTP ${res.status}`)
      }
      setPhase('success')
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : 'Unknown error')
      setPhase('error')
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose() }}>
      <DialogContent className="sm:max-w-md">
        {phase === 'success' ? (
          <div className="flex flex-col items-center gap-3 py-8 text-center">
            <div className="flex h-16 w-16 items-center justify-center rounded-full bg-green-100">
              <CheckCircle2 className="h-8 w-8 text-green-600" />
            </div>
            <div>
              <p className="text-base font-semibold text-gray-900">Post queued!</p>
              <p className="mt-1 text-sm text-gray-500">
                Posting to{' '}
                {platforms
                  .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
                  .join(', ')}
              </p>
            </div>
            <Button className="mt-2 bg-gray-900 hover:bg-gray-800" onClick={onClose}>
              Done
            </Button>
          </div>
        ) : (
          <div className="space-y-4">
            {/* Title */}
            <div>
              <h2 className="text-base font-semibold text-gray-900">Post to Social Media</h2>
              <p className="mt-0.5 line-clamp-1 text-xs text-gray-500">{target.topic}</p>
            </div>

            {/* Compact preview */}
            {target.media_url && target.media_type === 'image' && (
              <div className="overflow-hidden rounded-lg">
                <img
                  src={target.media_url}
                  alt={target.topic}
                  className="h-36 w-full object-cover"
                />
              </div>
            )}
            {target.media_url && target.media_type === 'video' && (
              <div className="overflow-hidden rounded-lg bg-black">
                <video
                  src={target.media_url}
                  className="h-28 w-full object-cover"
                  preload="metadata"
                />
              </div>
            )}
            {target.media_type === 'blog' && (
              <div className="flex items-center gap-3 rounded-lg border border-amber-100 bg-amber-50 p-3">
                <BookOpen className="h-8 w-8 shrink-0 text-amber-500" />
                <div className="min-w-0">
                  <p className="line-clamp-2 text-sm font-medium text-gray-800">{target.topic}</p>
                  <p className="text-xs text-gray-500">Blog Post</p>
                </div>
              </div>
            )}

            {/* Platforms */}
            <div>
              <p className="mb-2 text-xs font-medium text-gray-700">Platforms</p>
              <div className="flex flex-wrap gap-2">
                {PLATFORM_OPTIONS.map((p) => {
                  const selected = platforms.includes(p.id)
                  const status = connectionStatus?.[p.id]
                  // Not connected at all is a guaranteed failure — disable
                  // it, same reasoning as PlatformSelector.tsx's own guard.
                  // A live-but-stale token (reauthRequired) is only a warning.
                  const notConnected = status !== undefined && !status.connected
                  return (
                    <button
                      key={p.id}
                      onClick={() => togglePlatform(p.id)}
                      disabled={notConnected}
                      title={
                        notConnected
                          ? 'Not connected on upload-post.com'
                          : status?.connected && status.reauthRequired
                            ? 'This account may need reconnecting on upload-post.com'
                            : undefined
                      }
                      className={`rounded-lg border px-3 py-2 text-xs font-medium transition-all ${
                        notConnected
                          ? 'cursor-not-allowed border-gray-100 bg-gray-50 text-gray-300'
                          : selected
                            ? 'border-gray-900 bg-gray-900 text-white'
                            : 'border-gray-200 bg-white text-gray-600 hover:border-gray-400 hover:bg-gray-50'
                      }`}
                    >
                      {p.label}
                      {notConnected && <span className="ml-1 text-red-400">·</span>}
                      {status?.connected && status.reauthRequired && <span className="ml-1 text-amber-500">⚠</span>}
                    </button>
                  )
                })}
              </div>
            </div>

            {/* Caption */}
            <div>
              <p className="mb-1.5 text-xs font-medium text-gray-700">Caption</p>
              <Textarea
                value={caption}
                onChange={(e) => setCaption(e.target.value)}
                rows={4}
                placeholder="Write your caption…"
                className="resize-none text-sm"
              />
            </div>

            {/* Hashtags */}
            <div>
              <p className="mb-1.5 text-xs font-medium text-gray-700">Hashtags</p>
              <Input
                value={hashtags}
                onChange={(e) => setHashtags(e.target.value)}
                placeholder="#FreshCAN #FoodDesert"
                className="text-sm"
              />
            </div>

            {/* Error */}
            {phase === 'error' && (
              <div className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 p-3">
                <AlertCircle className="h-4 w-4 shrink-0 text-red-500" />
                <p className="text-xs text-red-700">{errorMsg}</p>
              </div>
            )}

            {/* Actions */}
            <div className="flex gap-2 pt-1">
              <Button
                variant="outline"
                className="flex-1"
                onClick={onClose}
                disabled={phase === 'posting'}
              >
                Cancel
              </Button>
              <Button
                className="flex-1 bg-gray-900 hover:bg-gray-800"
                disabled={platforms.length === 0 || phase === 'posting'}
                onClick={handlePost}
              >
                {phase === 'posting' ? (
                  <><RefreshCw className="mr-2 h-4 w-4 animate-spin" />Posting…</>
                ) : (
                  <><Send className="mr-2 h-4 w-4" />Post Now</>
                )}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

// ─── DeleteConfirmModal ─────────────────────────────────────────────────────

function DeleteConfirmModal({
  open,
  topic,
  onCancel,
  onConfirm,
  deleting,
  error,
}: {
  open: boolean
  topic: string
  onCancel: () => void
  onConfirm: () => void
  deleting: boolean
  error: string | null
}) {
  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v && !deleting) onCancel() }}>
      <DialogContent className="sm:max-w-sm">
        <div className="space-y-4">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-red-100">
              <Trash2 className="h-5 w-5 text-red-600" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-gray-900">Delete this content?</h2>
              <p className="mt-1 line-clamp-2 text-sm text-gray-500">{topic}</p>
              <p className="mt-1.5 text-xs text-gray-400">This can&apos;t be undone.</p>
            </div>
          </div>

          {error && (
            <div className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 p-3">
              <AlertCircle className="h-4 w-4 shrink-0 text-red-500" />
              <p className="text-xs text-red-700">{error}</p>
            </div>
          )}

          <div className="flex gap-2">
            <Button variant="outline" className="flex-1" onClick={onCancel} disabled={deleting}>
              Cancel
            </Button>
            <Button
              className="flex-1 bg-red-600 hover:bg-red-700 text-white"
              onClick={onConfirm}
              disabled={deleting}
            >
              {deleting ? (
                <><RefreshCw className="mr-2 h-4 w-4 animate-spin" />Deleting…</>
              ) : (
                <><Trash2 className="mr-2 h-4 w-4" />Delete</>
              )}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

// ─── Shared small components ──────────────────────────────────────────────────

function ErrorBanner({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="mt-4 flex items-center gap-3 rounded-xl border border-red-200 bg-red-50 p-4">
      <AlertCircle className="h-5 w-5 shrink-0 text-red-500" />
      <p className="flex-1 text-sm text-red-700">{message}</p>
      <Button size="sm" variant="outline" onClick={onRetry}>
        <RefreshCw className="mr-1.5 h-3.5 w-3.5" />Retry
      </Button>
    </div>
  )
}

function NoFilterResults({ onClear }: { onClear: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-gray-200 bg-gray-50 py-16 text-center">
      <Search className="mb-3 h-8 w-8 text-gray-300" />
      <p className="text-sm font-semibold text-gray-600">No items match your filters</p>
      <button onClick={onClear} className="mt-3 text-sm text-blue-500 hover:underline">
        Clear all filters
      </button>
    </div>
  )
}

function EmptyState({
  icon: Icon,
  message,
  onAction,
  actionLabel,
}: {
  icon: React.ElementType
  message: string
  onAction: () => void
  actionLabel: string
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-2xl border-2 border-dashed border-gray-200 bg-gray-50 py-20 text-center">
      <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-white shadow-sm">
        <Icon className="h-8 w-8 text-gray-300" />
      </div>
      <h3 className="text-base font-semibold text-gray-700">No content yet</h3>
      <p className="mt-1.5 max-w-xs text-sm text-gray-400">{message}</p>
      <Button className="mt-6 bg-gray-900 hover:bg-gray-800" onClick={onAction}>
        <Sparkles className="mr-2 h-4 w-4" />{actionLabel}
      </Button>
    </div>
  )
}

function LoadingSkeleton({ type }: { type: 'video' | 'image' | 'blog' }) {
  const count  = type === 'blog' ? 6 : 8
  // Video/image cards are always square now, regardless of the underlying
  // clip's own aspect ratio — the preview crops to fit (object-cover)
  // rather than the card stretching to match.
  const aspect = type === 'video' || type === 'image' ? 'aspect-square' : 'h-28'
  const cols   = type === 'blog'
    ? 'sm:grid-cols-2 lg:grid-cols-3'
    : 'sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4'
  return (
    <div className={`mt-4 grid grid-cols-1 gap-4 ${cols}`}>
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="overflow-hidden rounded-xl border bg-white shadow-sm">
          <div className={`animate-pulse bg-gray-100 ${aspect}`} />
          <div className="space-y-2 p-4">
            <div className="h-4 w-3/4 animate-pulse rounded bg-gray-100" />
            <div className="h-3 w-1/2 animate-pulse rounded bg-gray-100" />
            <div className="h-8 w-full animate-pulse rounded bg-gray-100" />
          </div>
        </div>
      ))}
    </div>
  )
}

// ─── FilterBar ────────────────────────────────────────────────────────────────

interface FilterBarProps {
  search: string; setSearch: (v: string) => void
  category: string; setCategory: (v: string) => void
  lang: string; setLang: (v: string) => void
  sort: 'desc' | 'asc'; setSort: (v: 'desc' | 'asc') => void
}

function FilterBar({ search, setSearch, category, setCategory, lang, setLang, sort, setSort }: FilterBarProps) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <div className="relative w-60">
        <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-400" />
        <Input
          placeholder="Search by topic…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="pl-9 text-sm"
        />
      </div>
      <Select value={category} onValueChange={(v) => setCategory(v ?? 'all')}>
        <SelectTrigger className="w-52 text-sm">
          <SelectValue placeholder="All Categories" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All Categories</SelectItem>
          {CATEGORIES.map((c) => (
            <SelectItem key={c} value={c}>{c}</SelectItem>
          ))}
        </SelectContent>
      </Select>
      <div className="flex overflow-hidden rounded-lg border border-gray-200">
        {(['all', 'EN', 'FR'] as const).map((l) => (
          <button
            key={l}
            onClick={() => setLang(l)}
            className={`px-3 py-1.5 text-sm transition-colors ${
              lang === l ? 'bg-gray-900 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'
            }`}
          >
            {l === 'all' ? 'All' : l}
          </button>
        ))}
      </div>
      <Button
        variant="outline"
        size="sm"
        className="ml-auto"
        onClick={() => setSort(sort === 'desc' ? 'asc' : 'desc')}
      >
        <ArrowUpDown className="mr-1.5 h-3.5 w-3.5" />
        {sort === 'desc' ? 'Newest First' : 'Oldest First'}
      </Button>
    </div>
  )
}

// ─── Badges ───────────────────────────────────────────────────────────────────

function Badges({ isLatest, isNew }: { isLatest: boolean; isNew: boolean }) {
  return (
    <div className="absolute left-2 top-2 flex gap-1.5">
      {isLatest && (
        <span className="rounded-full bg-green-500 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white shadow">
          Latest
        </span>
      )}
      {isNew && !isLatest && (
        <span className="rounded-full bg-blue-500 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white shadow">
          New
        </span>
      )}
    </div>
  )
}

// ─── VideoCard ────────────────────────────────────────────────────────────────
// `variants` holds this job's EN and/or FR final video — a BOTH-language job
// has both, and a language toggle (below the title, both in the card body
// and the view modal) switches which one this card/modal displays. Actions
// (Watch/Post/Save/Delete) always act on whichever language is currently
// selected. If only one language exists, no toggle is shown at all.

function VideoCard({
  variants,
  isLatest,
  isNew,
  onDeleted,
}: {
  variants: Partial<Record<'EN' | 'FR', VideoLibraryItem>>
  isLatest: boolean
  isNew: boolean
  onDeleted: (id: string) => void
}) {
  const available = (['EN', 'FR'] as const).filter((l) => variants[l])
  const [selected, setSelected] = useState<'EN' | 'FR'>(available[0] ?? 'EN')
  const item = variants[selected] ?? variants[available[0]]

  const [viewOpen, setViewOpen] = useState(false)
  const [postOpen, setPostOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  if (!item) return null

  const rawDuration = item.output_data?.duration_sec
  const duration = rawDuration ? Math.round(rawDuration * 10) / 10 : rawDuration
  const filename = `${item.topic.slice(0, 40).replace(/\s+/g, '-').toLowerCase()}-${item.language}.mp4`

  const LanguagePicker = ({ className = '' }: { className?: string }) =>
    available.length > 1 ? (
      <div className={`inline-flex rounded-lg border border-gray-200 bg-gray-50 p-0.5 ${className}`}>
        {available.map((l) => (
          <button
            key={l}
            onClick={() => setSelected(l)}
            className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
              selected === l ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            {l === 'EN' ? 'English' : 'Français'}
          </button>
        ))}
      </div>
    ) : null

  const handleDelete = async () => {
    setDeleting(true)
    setDeleteError(null)
    try {
      const res = await fetch(`/api/content/${item.id}`, { method: 'DELETE' })
      if (!res.ok) {
        const b = await res.json().catch(() => ({}))
        throw new Error((b as { error?: string }).error ?? `HTTP ${res.status}`)
      }
      setDeleteOpen(false)
      onDeleted(item.id)
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : 'Failed to delete')
    } finally {
      setDeleting(false)
    }
  }

  return (
    <>
      <Card className="overflow-hidden border bg-white shadow-sm transition-all hover:shadow-md">
        <div
          className="group relative aspect-square cursor-pointer overflow-hidden bg-black"
          onClick={() => setViewOpen(true)}
        >
          <video
            src={item.video_url}
            className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
            preload="metadata"
            playsInline
          />
          <div className="absolute inset-0 flex items-center justify-center bg-black/20 opacity-0 transition-opacity group-hover:opacity-100">
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-white/95 shadow-xl">
              <Play className="ml-1 h-6 w-6 text-gray-900" />
            </div>
          </div>
          <Badges isLatest={isLatest} isNew={isNew} />
          {duration && (
            <div className="absolute bottom-2 right-2 rounded bg-black/60 px-1.5 py-0.5 text-[11px] font-medium text-white">
              {duration}s
            </div>
          )}
        </div>

        <CardContent className="space-y-3 p-4">
          <div>
            <h3 className="line-clamp-2 text-sm font-semibold leading-snug text-gray-900">{item.topic}</h3>
            <LanguagePicker className="mt-1.5" />
            <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-gray-500">
              <span>{item.category}</span>
              <span className="text-gray-300">·</span>
              <span>{item.language}</span>
              {duration && <><span className="text-gray-300">·</span><span>{duration}s</span></>}
            </div>
          </div>
          <div className="flex items-center gap-1.5 text-xs text-gray-400">
            <Clock className="h-3 w-3 shrink-0" />
            <span>{formatDateTime(item.completed_at)}</span>
          </div>

          {/* Actions */}
          <div className="grid grid-cols-2 gap-1.5 pt-0.5">
            <Button size="sm" variant="outline" className="text-xs" onClick={() => setViewOpen(true)}>
              <Play className="mr-1 h-3 w-3" />Watch
            </Button>
            <Button
              size="sm"
              className="bg-gray-900 text-xs hover:bg-gray-800 text-white"
              onClick={() => setPostOpen(true)}
            >
              <Share2 className="mr-1 h-3 w-3" />Post
            </Button>
            <a href={item.video_url} download={filename}>
              <Button size="sm" variant="outline" className="w-full text-xs">
                <Download className="mr-1 h-3 w-3" />Save
              </Button>
            </a>
            <Button
              size="sm"
              variant="outline"
              className="text-xs text-red-600 border-red-200 hover:bg-red-50 hover:text-red-700"
              onClick={() => setDeleteOpen(true)}
            >
              <Trash2 className="mr-1 h-3 w-3" />Delete
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* View modal */}
      <Dialog open={viewOpen} onOpenChange={(v) => setViewOpen(v)}>
        <DialogContent className="sm:max-w-4xl gap-0 p-0 overflow-hidden">
          <div className="bg-black">
            <video key={item.id} src={item.video_url} controls autoPlay playsInline className="w-full max-h-[72vh]" />
          </div>
          <div className="flex items-start justify-between gap-4 p-4">
            <div className="min-w-0 flex-1">
              <h3 className="font-semibold leading-snug text-gray-900">{item.topic}</h3>
              <LanguagePicker className="mt-1.5" />
              <p className="mt-1 text-sm text-gray-500">
                {item.category} · {item.language}{duration ? ` · ${duration}s` : ''}
              </p>
              <p className="mt-0.5 text-xs text-gray-400">{formatDateTime(item.completed_at)}</p>
            </div>
            <div className="flex gap-2">
              <Button size="sm" onClick={() => { setViewOpen(false); setPostOpen(true) }}>
                <Share2 className="mr-1.5 h-3.5 w-3.5" />Post
              </Button>
              <a href={item.video_url} download={filename}>
                <Button size="sm" variant="outline"><Download className="mr-1.5 h-3.5 w-3.5" />Download</Button>
              </a>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Post modal */}
      <PostModal
        target={{ job_id: item.job_id, topic: item.topic, content_type: 'video', language: toPostLanguage(item.language), media_url: item.video_url, media_type: 'video' }}
        open={postOpen}
        onClose={() => setPostOpen(false)}
      />

      {/* Delete confirm modal */}
      <DeleteConfirmModal
        open={deleteOpen}
        topic={item.topic}
        onCancel={() => { setDeleteOpen(false); setDeleteError(null) }}
        onConfirm={handleDelete}
        deleting={deleting}
        error={deleteError}
      />
    </>
  )
}

// ─── ImageCard ────────────────────────────────────────────────────────────────
// `variants` holds this job's EN and/or FR generated image — a BOTH-language
// job has both, and a language toggle (in the card body and the view modal)
// switches which one this card/modal displays. Actions (View/Post/Save/
// Delete) always act on whichever language is currently selected. Same
// pattern as VideoCard.

function ImageCard({
  variants,
  isLatest,
  isNew,
  isHighlighted,
  onDeleted,
}: {
  variants: Partial<Record<'EN' | 'FR', ImageLibraryItem>>
  isLatest: boolean
  isNew: boolean
  isHighlighted?: boolean
  onDeleted: (id: string) => void
}) {
  const available = (['EN', 'FR'] as const).filter((l) => variants[l])
  const [selected, setSelected] = useState<'EN' | 'FR'>(available[0] ?? 'EN')
  const item = variants[selected] ?? variants[available[0]]

  const [viewOpen, setViewOpen] = useState(false)
  const [postOpen, setPostOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  if (!item) return null

  const filename = `${item.topic.slice(0, 40).replace(/\s+/g, '-').toLowerCase()}-${item.language}.jpg`

  const LanguagePicker = ({ className = '' }: { className?: string }) =>
    available.length > 1 ? (
      <div className={`inline-flex rounded-lg border border-gray-200 bg-gray-50 p-0.5 ${className}`}>
        {available.map((l) => (
          <button
            key={l}
            onClick={() => setSelected(l)}
            className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
              selected === l ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            {l === 'EN' ? 'English' : 'Français'}
          </button>
        ))}
      </div>
    ) : null

  const handleDelete = async () => {
    setDeleting(true)
    setDeleteError(null)
    try {
      const res = await fetch(`/api/content/${item.id}`, { method: 'DELETE' })
      if (!res.ok) {
        const b = await res.json().catch(() => ({}))
        throw new Error((b as { error?: string }).error ?? `HTTP ${res.status}`)
      }
      setDeleteOpen(false)
      onDeleted(item.id)
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : 'Failed to delete')
    } finally {
      setDeleting(false)
    }
  }

  return (
    <>
      <Card className={`overflow-hidden border bg-white shadow-sm transition-all hover:shadow-md${isHighlighted ? ' ring-2 ring-green-500 ring-offset-2' : ''}`}>
        <div
          className="group relative aspect-square cursor-pointer overflow-hidden bg-gray-100"
          onClick={() => setViewOpen(true)}
        >
          <img
            src={item.image_url}
            alt={item.topic}
            className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
            loading="lazy"
          />
          <Badges isLatest={isLatest} isNew={isNew} />
        </div>

        <CardContent className="space-y-3 p-4">
          <div>
            <h3 className="line-clamp-2 text-sm font-semibold leading-snug text-gray-900">{item.topic}</h3>
            <LanguagePicker className="mt-1.5" />
            <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-gray-500">
              <span>{item.category}</span>
              {item.language && <><span className="text-gray-300">·</span><span>{item.language}</span></>}
            </div>
          </div>

          {item.caption && (
            <p className="line-clamp-2 text-xs leading-relaxed text-gray-500">{item.caption}</p>
          )}

          {item.hashtags.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {item.hashtags.slice(0, 5).map((tag, i) => (
                <span key={i} className="rounded-full bg-blue-50 px-2 py-0.5 text-[11px] font-medium text-blue-600">
                  {tag.startsWith('#') ? tag : `#${tag}`}
                </span>
              ))}
            </div>
          )}

          <div className="flex items-center gap-1.5 text-xs text-gray-400">
            <Clock className="h-3 w-3 shrink-0" />
            <span>{formatDateTime(item.completed_at)}</span>
          </div>

          {/* Actions */}
          <div className="grid grid-cols-2 gap-1.5 pt-0.5">
            <Button size="sm" variant="outline" className="text-xs" onClick={() => setViewOpen(true)}>
              <ImageIcon className="mr-1 h-3 w-3" />View
            </Button>
            <Button
              size="sm"
              className="bg-gray-900 text-xs hover:bg-gray-800 text-white"
              onClick={() => setPostOpen(true)}
            >
              <Share2 className="mr-1 h-3 w-3" />Post
            </Button>
            <a href={item.image_url} download={filename}>
              <Button size="sm" variant="outline" className="w-full text-xs">
                <Download className="mr-1 h-3 w-3" />Save
              </Button>
            </a>
            <Button
              size="sm"
              variant="outline"
              className="text-xs text-red-600 border-red-200 hover:bg-red-50 hover:text-red-700"
              onClick={() => setDeleteOpen(true)}
            >
              <Trash2 className="mr-1 h-3 w-3" />Delete
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* View modal */}
      <Dialog open={viewOpen} onOpenChange={(v) => setViewOpen(v)}>
        <DialogContent className="sm:max-w-3xl gap-0 p-0 flex flex-col max-h-[92vh] overflow-hidden">
          {/* Image — shrinks if tall, never overflows */}
          <div className="flex shrink-0 items-center justify-center overflow-hidden bg-gray-100" style={{ maxHeight: '60vh' }}>
            <img key={item.id} src={item.image_url} alt={item.topic} className="max-h-[60vh] max-w-full object-contain" />
          </div>
          {/* Scrollable info section */}
          <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="flex items-start justify-between gap-4 p-4">
              <div className="min-w-0 flex-1">
                <h3 className="font-semibold leading-snug text-gray-900">{item.topic}</h3>
                <LanguagePicker className="mt-1.5" />
                <p className="mt-1 text-sm text-gray-500">{item.category}{item.language ? ` · ${item.language}` : ''}</p>
                {item.caption && <p className="mt-1.5 text-sm leading-relaxed text-gray-700">{item.caption}</p>}
                {item.hashtags.length > 0 && (
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {item.hashtags.map((tag, i) => (
                      <span key={i} className="rounded-full bg-blue-50 px-2 py-0.5 text-[11px] text-blue-600">
                        {tag.startsWith('#') ? tag : `#${tag}`}
                      </span>
                    ))}
                  </div>
                )}
                <p className="mt-1.5 text-xs text-gray-400">{formatDateTime(item.completed_at)}</p>
              </div>
              <div className="flex shrink-0 gap-2">
                <Button size="sm" onClick={() => { setViewOpen(false); setPostOpen(true) }}>
                  <Share2 className="mr-1.5 h-3.5 w-3.5" />Post
                </Button>
                <a href={item.image_url} download={filename}>
                  <Button size="sm" variant="outline"><Download className="mr-1.5 h-3.5 w-3.5" />Download</Button>
                </a>
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Post modal */}
      <PostModal
        target={{
          job_id: item.job_id, topic: item.topic, content_type: 'image_post',
          language: toPostLanguage(item.language),
          media_url: item.image_url, media_type: 'image',
          prefill_caption: item.caption || undefined,
          prefill_hashtags: item.hashtags.length > 0 ? item.hashtags.join(' ') : undefined,
        }}
        open={postOpen}
        onClose={() => setPostOpen(false)}
      />

      {/* Delete confirm modal */}
      <DeleteConfirmModal
        open={deleteOpen}
        topic={item.topic}
        onCancel={() => { setDeleteOpen(false); setDeleteError(null) }}
        onConfirm={handleDelete}
        deleting={deleting}
        error={deleteError}
      />
    </>
  )
}

// ─── Blog HTML styles ─────────────────────────────────────────────────────────

const BLOG_CSS = `
.blog-render{max-width:860px;margin:0 auto;padding:1.5rem 2rem 2.5rem;font-family:Georgia,serif;line-height:1.85;color:#1a1a1a}
.blog-render h1{display:none}
.blog-render .hero-image,.blog-render figure.hero-image{display:none}
.blog-render .inline-image,.blog-render figure.inline-image{margin:2rem auto;max-width:800px;display:block}
.blog-render .inline-image img,.blog-render figure.inline-image img{width:100%;height:auto;display:block;border-radius:6px;box-shadow:0 4px 16px rgba(0,0,0,0.12)}
.blog-render figcaption{text-align:center;font-size:0.8rem;color:#777;margin-top:.5rem;font-style:italic}
.blog-render h2{font-size:1.375rem;font-weight:600;margin:2rem 0 .75rem;line-height:1.3;border-bottom:1px solid #f0f0f0;padding-bottom:.4rem}
.blog-render h3{font-size:1.1rem;font-weight:600;margin:1.5rem 0 .5rem}
.blog-render p{margin:0 0 1.25rem}
.blog-render ul,.blog-render ol{margin:1rem 0 1.5rem 1.5rem;padding:0}
.blog-render li{margin-bottom:.5rem}
.blog-render blockquote{border-left:4px solid #2d7a3e;margin:2rem 0;padding:1rem 1.5rem;background:#f0f7f1;border-radius:0 6px 6px 0}
.blog-render blockquote p{margin:0 0 .5rem;font-style:italic}
.blog-render blockquote cite{font-size:.85rem;color:#666}
.blog-render .cta-button,.blog-render a.cta-button{display:inline-block;background:#2d7a3e;color:#fff;padding:.875rem 2rem;border-radius:6px;text-decoration:none;font-weight:600;margin-top:1rem}
.blog-render .cta-section{background:#f0f7f1;border-radius:12px;padding:2rem;margin-top:2.5rem}
.blog-render a{color:#2d7a3e;text-decoration:underline}
.blog-render article.freshcan-blog-post{padding:0}
`

// ─── Blog reconstruction helpers ─────────────────────────────────────────────

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function reconstructBlogHtml(d: Record<string, unknown>): string {
  const content    = (d.content as Record<string, unknown>) ?? {}
  const intro      = typeof content.introduction === 'string' ? content.introduction : ''
  const conclusion = typeof content.conclusion   === 'string' ? content.conclusion   : ''
  const sections   = Array.isArray(content.sections) ? (content.sections as Record<string, unknown>[]) : []
  const ctaRaw     = (content.cta as Record<string, unknown>) ?? {}
  const imgs       = (d.images   as Record<string, unknown>) ?? {}
  const inlineImg  = (imgs.inline as Record<string, unknown>) ?? {}

  if (!intro && sections.length === 0) return ''

  let html = '<article class="freshcan-blog-post">'

  if (intro) html += `<p>${esc(intro)}</p>`

  sections.forEach((s, i) => {
    const heading   = typeof s.heading === 'string' ? s.heading : ''
    const paras     = Array.isArray(s.paragraphs)  ? (s.paragraphs  as string[]).filter(Boolean) : []
    const h3s       = Array.isArray(s.h3s)         ? (s.h3s         as string[]).filter(Boolean) : []
    const listItems = Array.isArray(s.list_items)  ? (s.list_items  as string[]).filter(Boolean) : []
    const bq        = (s.blockquote as Record<string, unknown> | null) ?? null

    if (heading) html += `<h2>${esc(heading)}</h2>`
    h3s.forEach(h => { html += `<h3>${esc(h)}</h3>` })
    paras.forEach(p => { html += `<p>${esc(p)}</p>` })
    if (listItems.length) html += '<ul>' + listItems.map(li => `<li>${esc(li)}</li>`).join('') + '</ul>'
    if (bq && typeof bq.text === 'string') {
      html += `<blockquote><p>${esc(bq.text)}</p>${bq.cite ? `<cite>${esc(String(bq.cite))}</cite>` : ''}</blockquote>`
    }
    if (i === 0 && typeof inlineImg.url === 'string' && (inlineImg.url as string).startsWith('http')) {
      html += `<figure class="inline-image"><img src="${inlineImg.url as string}" alt="${esc(String(inlineImg.alt ?? ''))}" /></figure>`
    }
  })

  if (conclusion) html += `<p>${esc(conclusion)}</p>`

  if (ctaRaw.heading || ctaRaw.text) {
    html += '<div class="cta-section">'
    if (typeof ctaRaw.heading === 'string') html += `<h2>${esc(ctaRaw.heading)}</h2>`
    if (typeof ctaRaw.text    === 'string') html += `<p>${esc(ctaRaw.text)}</p>`
    if (typeof ctaRaw.button_label === 'string' && typeof ctaRaw.button_url === 'string') {
      html += `<a href="${esc(ctaRaw.button_url)}" class="cta-button">${esc(ctaRaw.button_label)}</a>`
    }
    html += '</div>'
  }

  html += '</article>'
  return html
}

// ─── BlogCard ─────────────────────────────────────────────────────────────────

// `variants` holds this job's EN and/or FR generated post — a BOTH-language
// job has both, and a language toggle (below the title, both in the card
// body and the read modal) switches which one this card/modal displays.
// Actions (Read/Post/Link/Delete) always act on whichever language is
// currently selected. Same pattern as VideoCard/ImageCard.

function BlogCard({
  variants,
  isLatest,
  isNew,
  onDeleted,
}: {
  variants: Partial<Record<'EN' | 'FR', BlogLibraryItem>>
  isLatest: boolean
  isNew: boolean
  onDeleted: (id: string) => void
}) {
  const available = (['EN', 'FR'] as const).filter((l) => variants[l])
  const [selected, setSelected] = useState<'EN' | 'FR'>(available[0] ?? 'EN')
  const item = variants[selected] ?? variants[available[0]]

  const [readOpen, setReadOpen] = useState(false)
  const [postOpen, setPostOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [heroLoaded, setHeroLoaded] = useState(false)
  const [heroError, setHeroError] = useState(false)

  // Fallback: fetch html_final from content_drafts if not in generated_content
  const [draftHtml, setDraftHtml]         = useState<string | null>(null)
  const [draftInline, setDraftInline]     = useState<{ url: string; alt: string } | null>(null)
  const [draftFetching, setDraftFetching] = useState(false)
  // Tracks which language's draft is currently loaded (or being loaded),
  // not just a boolean — a language toggle switches `item.language` while
  // the modal stays open, and the old boolean-ref version would never
  // re-fetch for the newly selected language, silently showing the first
  // language's content (or none) after a toggle.
  const fetchedForLang = useRef<string | null>(null)

  if (!item) return null

  const od = item.output_data

  // Support both the legacy plain-text format and the current blog worker
  // format (worker/src/prompts/core/composeText.ts's composeCopySystemPrompt schema)
  const title      = od?.post_title    ?? od?.title    ?? item.topic
  const excerpt    = od?.post_excerpt  ?? od?.excerpt  ?? (typeof od?.content === 'string' ? od.content.slice(0, 180) : null)
  const htmlFinal  = od?.html_final    ?? od?.post_content ?? draftHtml ?? null
  const heroUrl    = od?.images?.hero?.url ?? od?.hero_image_url ?? item.file_url ?? null
  const heroAlt    = od?.images?.hero?.alt ?? title
  const inlineUrl  = od?.images?.inline?.url ?? od?.inline_image_url ?? draftInline?.url ?? null
  const inlineAlt  = od?.images?.inline?.alt ?? draftInline?.alt ?? 'Inline image'
  const readTime   = od?.seo?.estimated_read_time ?? null
  const keyword    = od?.focus_keyword ?? null
  const wordCount  = od?.word_count    ?? null
  const tags       = od?.tags          ?? []

  const validHero   = typeof heroUrl   === 'string' && heroUrl.startsWith('http')   ? heroUrl   : null
  const validInline = typeof inlineUrl === 'string' && inlineUrl.startsWith('http') ? inlineUrl : null
  const canRead     = true // always allow read — we can always show something

  const handleDelete = async () => {
    setDeleting(true)
    setDeleteError(null)
    try {
      const res = await fetch(`/api/content/${item.id}`, { method: 'DELETE' })
      if (!res.ok) {
        const b = await res.json().catch(() => ({}))
        throw new Error((b as { error?: string }).error ?? `HTTP ${res.status}`)
      }
      setDeleteOpen(false)
      onDeleted(item.id)
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : 'Failed to delete')
    } finally {
      setDeleting(false)
    }
  }

  // When modal opens and html_final missing in generated_content → fetch from
  // content_drafts once per language. Re-fetches when the toggle switches to
  // a language that hasn't been fetched yet (fetchedForLang tracks WHICH
  // language, not just whether any fetch happened — a plain boolean would
  // silently keep showing the first language's draft forever after a toggle).
  useEffect(() => {
    if (!readOpen || od?.html_final || od?.post_content) return
    if (fetchedForLang.current === item.language) return
    fetchedForLang.current = item.language
    setDraftHtml(null)
    setDraftInline(null)
    setDraftFetching(true)
    supabase
      .from('content_drafts')
      .select('draft_data')
      .eq('job_id', item.job_id)
      .eq('content_type', 'blog')
      .eq('language', item.language)
      .maybeSingle()
      .then(({ data }) => {
        if (data?.draft_data) {
          const dd = data.draft_data as Record<string, unknown>
          // Use html_final if present, otherwise reconstruct from structured content
          const html = typeof dd.html_final === 'string' && dd.html_final
            ? dd.html_final
            : reconstructBlogHtml(dd)
          if (html) setDraftHtml(html)
          // Extract inline image for the preview row
          const imgs = dd.images as Record<string, unknown> | undefined
          const inl  = imgs?.inline as Record<string, unknown> | undefined
          if (typeof inl?.url === 'string' && (inl.url as string).startsWith('http')) {
            setDraftInline({ url: inl.url as string, alt: (inl.alt as string) ?? 'Inline image' })
          }
        }
        setDraftFetching(false)
      })
  }, [readOpen, item.job_id, item.language, od?.html_final, od?.post_content])

  useEffect(() => { setHeroLoaded(false); setHeroError(false) }, [validHero])

  const LanguagePicker = ({ className = '' }: { className?: string }) =>
    available.length > 1 ? (
      <div className={`inline-flex rounded-lg border border-gray-200 bg-gray-50 p-0.5 ${className}`}>
        {available.map((l) => (
          <button
            key={l}
            onClick={() => setSelected(l)}
            className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
              selected === l ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            {l === 'EN' ? 'English' : 'Français'}
          </button>
        ))}
      </div>
    ) : null

  return (
    <>
      <Card className="overflow-hidden border bg-white shadow-sm transition-all hover:shadow-md">
        {/* Hero thumbnail */}
        {validHero && !heroError ? (
          <div
            className="relative aspect-video cursor-pointer overflow-hidden bg-gray-100"
            onClick={() => canRead && setReadOpen(true)}
          >
            <img
              src={validHero}
              alt={heroAlt}
              className={`h-full w-full object-cover transition-all duration-300 hover:scale-105 ${heroLoaded ? 'opacity-100' : 'opacity-0'}`}
              loading="lazy"
              onLoad={() => setHeroLoaded(true)}
              onError={() => setHeroError(true)}
            />
            <Badges isLatest={isLatest} isNew={isNew} />
          </div>
        ) : (
          <div className="flex h-28 items-center justify-center border-b border-amber-100 bg-amber-50">
            <BookOpen className="h-9 w-9 text-amber-400" />
          </div>
        )}

        <CardContent className="space-y-3 p-4">
          <div>
            <h3 className="line-clamp-2 text-sm font-semibold leading-snug text-gray-900">{title}</h3>
            <LanguagePicker className="mt-1.5" />
            <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-gray-500">
              <span>{item.category}</span>
              <span className="text-gray-300">·</span>
              <span>{item.language}</span>
              {readTime && <><span className="text-gray-300">·</span><span>{readTime}</span></>}
              {wordCount && <><span className="text-gray-300">·</span><span>{wordCount.toLocaleString()} words</span></>}
            </div>
          </div>

          {keyword && (
            <span className="inline-block rounded-full border border-green-200 bg-green-50 px-2 py-0.5 text-[11px] font-medium text-green-700">
              {keyword}
            </span>
          )}

          {!keyword && tags.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {tags.slice(0, 3).map((tag) => (
                <span key={tag} className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2 py-0.5 text-[11px] text-gray-600">
                  <Tag className="h-2.5 w-2.5" />{tag}
                </span>
              ))}
            </div>
          )}

          {excerpt && (
            <p className="line-clamp-2 text-xs leading-relaxed text-gray-500">{excerpt}</p>
          )}

          <div className="flex items-center gap-1.5 text-xs text-gray-400">
            <Clock className="h-3 w-3 shrink-0" />
            <span>{formatDateTime(item.completed_at)}</span>
          </div>

          {/* Actions */}
          <div className="grid grid-cols-2 gap-1.5 pt-0.5">
            {canRead ? (
              <Button size="sm" variant="outline" className="text-xs" onClick={() => setReadOpen(true)}>
                <BookOpen className="mr-1 h-3 w-3" />Read
              </Button>
            ) : <div />}
            <Button size="sm" className="bg-gray-900 text-xs hover:bg-gray-800 text-white" onClick={() => setPostOpen(true)}>
              <Share2 className="mr-1 h-3 w-3" />Post
            </Button>
            {item.file_url ? (
              <a href={item.file_url} target="_blank" rel="noopener noreferrer">
                <Button size="sm" variant="outline" className="w-full text-xs">
                  <ExternalLink className="mr-1 h-3 w-3" />Link
                </Button>
              </a>
            ) : <div />}
            <Button
              size="sm"
              variant="outline"
              className="text-xs text-red-600 border-red-200 hover:bg-red-50 hover:text-red-700"
              onClick={() => setDeleteOpen(true)}
            >
              <Trash2 className="mr-1 h-3 w-3" />Delete
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Read modal */}
      {canRead && (
        <Dialog open={readOpen} onOpenChange={(v) => setReadOpen(v)}>
          <DialogContent className="sm:max-w-4xl gap-0 p-0 overflow-hidden max-h-[92vh] flex flex-col">
            {/* Header */}
            <div className="shrink-0 border-b px-6 py-4">
              <h2 className="text-xl font-bold leading-snug text-gray-900 mb-1.5">{title}</h2>
              <LanguagePicker className="mb-1.5" />
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-500">
                <span className="font-medium text-gray-700">{item.category}</span>
                <span className="text-gray-300">·</span>
                <span>{item.language}</span>
                {readTime && <><span className="text-gray-300">·</span><span>{readTime} read</span></>}
                {keyword && <><span className="text-gray-300">·</span><span className="font-medium text-green-700">{keyword}</span></>}
                <span className="text-gray-300">·</span>
                <span>{formatDateTime(item.completed_at)}</span>
              </div>
            </div>

            {/* Body */}
            <div className="min-h-0 flex-1 overflow-y-auto">
              {/* Images preview — hero + inline side by side */}
              {(validHero || validInline) && (
                <div key={item.id} className={`grid gap-3 px-6 pt-5 pb-0 ${validHero && validInline ? 'grid-cols-2' : 'grid-cols-1'}`}>
                  {validHero && (
                    <div>
                      <p className="mb-1 text-xs text-gray-400">Hero image</p>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={validHero} alt={heroAlt} className="h-44 w-full rounded-lg object-cover" />
                    </div>
                  )}
                  {validInline && (
                    <div>
                      <p className="mb-1 text-xs text-gray-400">Inline image</p>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={validInline} alt={inlineAlt} className="h-44 w-full rounded-lg object-cover" />
                    </div>
                  )}
                </div>
              )}

              {/* Blog content */}
              {draftFetching ? (
                <div className="flex items-center justify-center gap-2 py-16 text-sm text-gray-400">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Loading full blog…
                </div>
              ) : htmlFinal ? (
                <>
                  <style>{BLOG_CSS}</style>
                  <div key={item.id} className="blog-render" dangerouslySetInnerHTML={{ __html: htmlFinal }} />
                </>
              ) : excerpt ? (
                <div className="px-6 py-5">
                  <p className="text-sm leading-relaxed text-gray-600">{excerpt}</p>
                </div>
              ) : null}
            </div>

            {/* Footer */}
            <div className="flex shrink-0 items-center justify-between border-t bg-gray-50 px-5 py-3">
              <Button size="sm" onClick={() => { setReadOpen(false); setPostOpen(true) }}>
                <Share2 className="mr-1.5 h-3.5 w-3.5" />Post This
              </Button>
              {item.file_url && (
                <a href={item.file_url} target="_blank" rel="noopener noreferrer">
                  <Button size="sm" variant="outline">
                    <ExternalLink className="mr-1.5 h-3.5 w-3.5" />Open Published Post
                  </Button>
                </a>
              )}
            </div>
          </DialogContent>
        </Dialog>
      )}

      {/* Post modal */}
      <PostModal
        target={{ job_id: item.job_id, topic: title, content_type: 'blog', language: toPostLanguage(item.language), media_url: validHero ?? item.file_url ?? null, media_type: 'blog' }}
        open={postOpen}
        onClose={() => setPostOpen(false)}
      />

      {/* Delete confirm modal */}
      <DeleteConfirmModal
        open={deleteOpen}
        topic={title}
        onCancel={() => { setDeleteOpen(false); setDeleteError(null) }}
        onConfirm={handleDelete}
        deleting={deleting}
        error={deleteError}
      />
    </>
  )
}

// ─── VideoSection ─────────────────────────────────────────────────────────────
// ─── PostedSection ────────────────────────────────────────────────────────────

export function PostedSection() {
  const [items, setItems] = useState<Awaited<ReturnType<typeof getPostedContent>>>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    getPostedContent().then(setItems).finally(() => setLoading(false))
  }, [])

  if (loading) return <LoadingSkeleton type="video" />
  if (items.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center rounded-2xl border-2 border-dashed border-gray-200 bg-gray-50 py-20 text-center">
        <Share2 className="mb-3 h-8 w-8 text-gray-300" />
        <h3 className="text-base font-semibold text-gray-700">Nothing posted yet</h3>
        <p className="mt-1.5 text-sm text-gray-400">Post something from the other tabs to see it here.</p>
      </div>
    )
  }

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 pt-4">
      {items.map((item) => (
        <Card key={item.id} className="p-4 space-y-2">
          {item.media_url && (
            <div className="aspect-video overflow-hidden rounded-lg bg-black">
              {item.content_type === 'video' ? (
                <video src={item.media_url} className="h-full w-full object-cover" controls />
              ) : (
                <img src={item.media_url} alt={item.caption} className="h-full w-full object-cover" />
              )}
            </div>
          )}
          <p className="text-sm font-semibold line-clamp-2">{item.caption}</p>
          <div className="flex flex-wrap gap-1.5 text-xs text-gray-500">
            <span className="rounded-full bg-purple-100 px-2 py-0.5 text-purple-700 font-medium">Posted</span>
            <span>{item.content_type}</span>
          </div>
          {item.platform_logs?.map((log: { platform: string; post_url: string }, i: number) => (
            <a key={i} href={log.post_url} target="_blank" rel="noopener noreferrer" className="block text-xs text-blue-600 hover:underline">
              View on {log.platform} →
            </a>
          ))}
        </Card>
      ))}
    </div>
  )
}
function VideoSection() {
  const router = useRouter()
  const [items, setItems]       = useState<VideoLibraryItem[]>([])
  const [loading, setLoading]   = useState(true)
  const [error, setError]       = useState<string | null>(null)
  const [newIds, setNewIds]     = useState<Set<string>>(new Set())
  const [search, setSearch]     = useState('')
  const [category, setCategory] = useState('all')
  const [lang, setLang]         = useState('all')
  const [sort, setSort]         = useState<'desc' | 'asc'>('desc')

    const load = useCallback(async () => {
    setError(null)
    try {
      const all = await getVideoLibrary()
      const postedIds = await getPostedJobIds('video')
      setItems(all.filter((v) => !postedIds.has(v.job_id)))
    }
    catch (e) { setError(e instanceof Error ? e.message : 'Failed to load') }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    const ch = supabase
      .channel('lib-video')
      .on('postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'generated_content', filter: 'content_type=eq.video' },
        (p) => {
          const r = p.new as { id: string; file_url: string | null }
          if (!r.file_url) return
          setNewIds((prev) => new Set(prev).add(r.id))
          load()
        })
      .subscribe()
    return () => { supabase.removeChannel(ch) }
  }, [load])

  const filtered = useMemo(() => {
    let list = items
    if (search.trim()) list = list.filter((v) => v.topic.toLowerCase().includes(search.toLowerCase()))
    if (category !== 'all') list = list.filter((v) => v.category === category)
    if (lang !== 'all') list = list.filter((v) => v.language === lang)
    if (sort === 'asc') list = [...list].reverse()
    return list
  }, [items, search, category, lang, sort])
    // Group filtered items by job_id, so a "Both" job's EN and FR videos
  // become one card with a toggle, instead of two separate cards.
  const grouped = useMemo(() => {
    const map = new Map<string, Partial<Record<'EN' | 'FR', VideoLibraryItem>>>()
    const order: string[] = []
    for (const item of filtered) {
      if (!map.has(item.job_id)) {
        map.set(item.job_id, {})
        order.push(item.job_id)
      }
      const langKey = item.language === 'FR' ? 'FR' : 'EN'
      map.get(item.job_id)![langKey] = item
    }
    return order.map((jobId) => ({ jobId, variants: map.get(jobId)! }))
  }, [filtered])

  const handleDeleted = useCallback((id: string) => {
    setItems((prev) => prev.filter((v) => v.id !== id))
  }, [])

  if (loading) return <LoadingSkeleton type="video" />
  if (error) return <ErrorBanner message={error} onRetry={load} />

  return (
    <div className="space-y-4 pt-4">
      {items.length > 0 && (
        <FilterBar search={search} setSearch={setSearch} category={category} setCategory={setCategory} lang={lang} setLang={setLang} sort={sort} setSort={setSort} />
      )}
      {items.length === 0 ? (
        <EmptyState icon={FileVideo} message="Approve a video script to generate your first video" onAction={() => router.push('/dashboard')} actionLabel="Go to Content Jobs →" />
            ) : grouped.length === 0 ? (
        <NoFilterResults onClear={() => { setSearch(''); setCategory('all'); setLang('all') }} />
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {grouped.map((g, i) => (
            <VideoCard
              key={g.jobId}
              variants={g.variants}
              isLatest={i === 0 && sort === 'desc'}
              isNew={Object.values(g.variants).some((v) => v && newIds.has(v.id))}
              onDeleted={handleDeleted}
            />
          ))}
        </div>
      )}
    </div>
  )
}

// ─── ImageSection ─────────────────────────────────────────────────────────────

function ImageSection({ highlightJobId }: { highlightJobId?: string }) {
  const router = useRouter()
  const [items, setItems]       = useState<ImageLibraryItem[]>([])
  const [loading, setLoading]   = useState(true)
  const [error, setError]       = useState<string | null>(null)
  const [newIds, setNewIds]     = useState<Set<string>>(new Set())
  const [search, setSearch]     = useState('')
  const [category, setCategory] = useState('all')
  const [lang, setLang]         = useState('all')
  const [sort, setSort]         = useState<'desc' | 'asc'>('desc')
  const highlightRef            = useRef<HTMLDivElement>(null)

    const load = useCallback(async () => {
    setError(null)
    try {
      const all = await getImageLibrary()
      const postedIds = await getPostedJobIds('image_post')
      setItems(all.filter((v) => !postedIds.has(v.job_id)))
    }
    catch (e) { setError(e instanceof Error ? e.message : 'Failed to load') }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    if (!loading && highlightJobId && highlightRef.current) {
      highlightRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }
  }, [loading, highlightJobId])

  useEffect(() => {
    const ch = supabase
      .channel('lib-image')
      .on('postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'generated_content' },
        (p) => {
          const r = p.new as Record<string, unknown>
          const ct = String(r.content_type ?? '')
          if (ct !== 'image_post') return
          setNewIds((prev) => new Set(prev).add(r.id as string))
          load()
        })
      .subscribe()
    return () => { supabase.removeChannel(ch) }
  }, [load])

  const filtered = useMemo(() => {
    let list = items
    if (search.trim()) list = list.filter((v) => v.topic.toLowerCase().includes(search.toLowerCase()))
    if (category !== 'all') list = list.filter((v) => v.category === category)
    if (lang !== 'all') list = list.filter((v) => v.language === lang)
    if (sort === 'asc') list = [...list].reverse()
    return list
  }, [items, search, category, lang, sort])

  // Group filtered items by job_id, so a "Both" job's EN and FR images
  // become one card with a toggle, instead of two separate cards — same
  // convention as VideoSection's own `grouped` above.
  const grouped = useMemo(() => {
    const map = new Map<string, Partial<Record<'EN' | 'FR', ImageLibraryItem>>>()
    const order: string[] = []
    for (const item of filtered) {
      if (!map.has(item.job_id)) {
        map.set(item.job_id, {})
        order.push(item.job_id)
      }
      const langKey = item.language === 'FR' ? 'FR' : 'EN'
      map.get(item.job_id)![langKey] = item
    }
    return order.map((jobId) => ({ jobId, variants: map.get(jobId)! }))
  }, [filtered])

  const handleDeleted = useCallback((id: string) => {
    setItems((prev) => prev.filter((v) => v.id !== id))
  }, [])

  if (loading) return <LoadingSkeleton type="image" />
  if (error) return <ErrorBanner message={error} onRetry={load} />

  return (
    <div className="space-y-4 pt-4">
      {items.length > 0 && (
        <FilterBar search={search} setSearch={setSearch} category={category} setCategory={setCategory} lang={lang} setLang={setLang} sort={sort} setSort={setSort} />
      )}
      {items.length === 0 ? (
        <EmptyState icon={ImageIcon} message="Submit an image post request to generate your first image" onAction={() => router.push('/dashboard/new')} actionLabel="Create New Content →" />
      ) : grouped.length === 0 ? (
        <NoFilterResults onClear={() => { setSearch(''); setCategory('all'); setLang('all') }} />
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {grouped.map((g, i) => {
            const isHighlighted = !!highlightJobId && g.jobId === highlightJobId
            return (
              <div key={g.jobId} ref={isHighlighted ? highlightRef : undefined}>
                <ImageCard
                  variants={g.variants}
                  isLatest={i === 0 && sort === 'desc'}
                  isNew={Object.values(g.variants).some((v) => v && newIds.has(v.id))}
                  isHighlighted={isHighlighted}
                  onDeleted={handleDeleted}
                />
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ─── BlogSection ──────────────────────────────────────────────────────────────

function BlogSection() {
  const router = useRouter()
  const [items, setItems]       = useState<BlogLibraryItem[]>([])
  const [loading, setLoading]   = useState(true)
  const [error, setError]       = useState<string | null>(null)
  const [newIds, setNewIds]     = useState<Set<string>>(new Set())
  const [search, setSearch]     = useState('')
  const [category, setCategory] = useState('all')
  const [lang, setLang]         = useState('all')
  const [sort, setSort]         = useState<'desc' | 'asc'>('desc')

  const load = useCallback(async () => {
    setError(null)
    try {
      const all = await getBlogLibrary()
      const postedIds = await getPostedJobIds('blog')
      setItems(all.filter((v) => !postedIds.has(v.job_id)))
    }
    catch (e) { setError(e instanceof Error ? e.message : 'Failed to load') }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    const ch = supabase
      .channel('lib-blog')
      .on('postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'generated_content', filter: 'content_type=eq.blog' },
        (p) => {
          const r = p.new as { id: string }
          setNewIds((prev) => new Set(prev).add(r.id))
          load()
        })
      .subscribe()
    return () => { supabase.removeChannel(ch) }
  }, [load])

  const filtered = useMemo(() => {
    let list = items
    if (search.trim()) list = list.filter((v) => v.topic.toLowerCase().includes(search.toLowerCase()))
    if (category !== 'all') list = list.filter((v) => v.category === category)
    if (lang !== 'all') list = list.filter((v) => v.language === lang)
    if (sort === 'asc') list = [...list].reverse()
    return list
  }, [items, search, category, lang, sort])

  // Group filtered items by job_id, so a "Both" job's EN and FR posts
  // become one card with a toggle, instead of two separate cards — same
  // convention as VideoSection's own `grouped` above.
  const grouped = useMemo(() => {
    const map = new Map<string, Partial<Record<'EN' | 'FR', BlogLibraryItem>>>()
    const order: string[] = []
    for (const item of filtered) {
      if (!map.has(item.job_id)) {
        map.set(item.job_id, {})
        order.push(item.job_id)
      }
      const langKey = item.language === 'FR' ? 'FR' : 'EN'
      map.get(item.job_id)![langKey] = item
    }
    return order.map((jobId) => ({ jobId, variants: map.get(jobId)! }))
  }, [filtered])

  const handleDeleted = useCallback((id: string) => {
    setItems((prev) => prev.filter((v) => v.id !== id))
  }, [])

  if (loading) return <LoadingSkeleton type="blog" />
  if (error) return <ErrorBanner message={error} onRetry={load} />

  return (
    <div className="space-y-4 pt-4">
      {items.length > 0 && (
        <FilterBar search={search} setSearch={setSearch} category={category} setCategory={setCategory} lang={lang} setLang={setLang} sort={sort} setSort={setSort} />
      )}
      {items.length === 0 ? (
        <EmptyState icon={FileText} message="Submit a blog post request to generate your first article" onAction={() => router.push('/dashboard/new')} actionLabel="Create New Content →" />
      ) : grouped.length === 0 ? (
        <NoFilterResults onClear={() => { setSearch(''); setCategory('all'); setLang('all') }} />
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {grouped.map((g, i) => (
            <BlogCard
              key={g.jobId}
              variants={g.variants}
              isLatest={i === 0 && sort === 'desc'}
              isNew={Object.values(g.variants).some((v) => v && newIds.has(v.id))}
              onDeleted={handleDeleted}
            />
          ))}
        </div>
      )}
    </div>
  )
}

// ─── GenerationTracker ────────────────────────────────────────────────────────

const TRACKER_CFG: Record<string, { label: string; viewLabel: string; section: string }> = {
  video:      { label: 'Video',      viewLabel: 'View Videos',     section: 'videos' },
  image_post: { label: 'Image Post', viewLabel: 'View Images',     section: 'images' },
  blog:       { label: 'Blog Post',  viewLabel: 'View Blog Posts', section: 'blogs'  },
}

function GenerationTracker({
  jobId,
  onDismiss,
  onNavigate,
}: {
  jobId: string
  onDismiss: () => void
  onNavigate: (section: string) => void
}) {
  const [topic, setTopic]         = useState('')
  const [types, setTypes]         = useState<string[]>([])
  const [done, setDone]           = useState<Record<string, boolean>>({})
  const [initLoading, setInit]    = useState(true)

  const refresh = useCallback(async (typeList: string[]) => {
    const checks = await Promise.all(typeList.map(async (t) => {
      let found = false
      if (t === 'image_post') {
        const { data } = await supabase.from('generated_content').select('id')
          .eq('job_id', jobId).eq('content_type', 'image_post').eq('status', 'completed').maybeSingle()
        found = !!data
      } else if (t === 'video') {
        const { data } = await supabase.from('generated_content').select('id')
          .eq('job_id', jobId).eq('content_type', 'video').not('file_url', 'is', null).maybeSingle()
        found = !!data
      } else if (t === 'blog') {
        const { data } = await supabase.from('generated_content').select('id')
          .eq('job_id', jobId).eq('content_type', 'blog').maybeSingle()
        found = !!data
      }
      return [t, found] as [string, boolean]
    }))
    setDone(Object.fromEntries(checks))
  }, [jobId])

  useEffect(() => {
    const init = async () => {
      const { data: job } = await supabase.from('content_jobs')
        .select('topic, content_types').eq('id', jobId).maybeSingle()
      if (!job) { setInit(false); return }
      const t = (job as { topic: string }).topic
      const tl = ((job as { content_types: string[] }).content_types ?? [])
      setTopic(t)
      setTypes(tl)
      await refresh(tl)
      setInit(false)
    }
    init()
  }, [jobId, refresh])

  // Poll incomplete types every 8 s
  useEffect(() => {
    if (initLoading || types.length === 0) return
    const hasPending = types.some((t) => !done[t])
    if (!hasPending) return
    const id = setInterval(() => refresh(types), 8000)
    return () => clearInterval(id)
  }, [initLoading, types, done, refresh])

  if (initLoading) return null

  const doneCount = types.filter((t) => done[t]).length
  const allDone   = types.length > 0 && doneCount === types.length

  return (
    <div className={`rounded-xl border p-4 ${allDone ? 'border-green-200 bg-green-50' : 'border-blue-200 bg-blue-50/60'}`}>
      {/* Header row */}
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          {allDone
            ? <CheckCircle2 className="h-4 w-4 text-green-600" />
            : <Loader2 className="h-4 w-4 animate-spin text-blue-500" />}
          <span className="text-sm font-semibold text-gray-900">
            {allDone
              ? `✅ All content ready · "${topic}"`
              : `Generating "${topic}" · ${doneCount} / ${types.length} complete`}
          </span>
        </div>
        <button onClick={onDismiss} className="text-xs text-gray-400 hover:text-gray-600">
          ✕ Dismiss
        </button>
      </div>

      {/* Per-type rows */}
      <div className="space-y-1.5">
        {types.map((t) => {
          const cfg    = TRACKER_CFG[t]
          const isDone = done[t] ?? false
          return (
            <div key={t} className="flex items-center justify-between rounded-lg bg-white/80 px-3 py-2">
              <div className="flex items-center gap-2.5">
                {isDone
                  ? <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />
                  : <Loader2      className="h-3.5 w-3.5 animate-spin text-blue-400" />}
                <span className="text-sm font-medium text-gray-800">{cfg?.label ?? t}</span>
                <span className={`text-xs ${isDone ? 'text-green-600 font-medium' : 'text-blue-500'}`}>
                  {isDone ? 'Ready' : 'Generating…'}
                </span>
              </div>
              {isDone && cfg && (
                <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => onNavigate(cfg.section)}>
                  {cfg.viewLabel} →
                </Button>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ─── Page content ─────────────────────────────────────────────────────────────

export default function LibraryContent() {
  const router       = useRouter()
  const searchParams = useSearchParams()
  const section   = searchParams.get('section') ?? 'videos'
  const highlight = searchParams.get('highlight') ?? undefined
  const trackParam = searchParams.get('track') ?? undefined

  const initialTab =
    section === 'images' ? 'images' :
    section === 'blogs'  ? 'blogs'  : 'videos'

  const [activeTab,    setActiveTab]    = useState(initialTab)
  const [trackJobId,   setTrackJobId]   = useState<string | undefined>(trackParam)

  const handleTabChange = (value: string) => {
    setActiveTab(value)
    const params = trackJobId ? `?section=${value}&track=${trackJobId}` : `?section=${value}`
    router.replace(`/dashboard/library${params}`, { scroll: false })
  }

  const handleDismissTracker = () => {
    setTrackJobId(undefined)
    router.replace(`/dashboard/library?section=${activeTab}`, { scroll: false })
  }

  return (
    <div className="space-y-6">
      <TopBar
        title="Content Library"
        breadcrumbs={[
          { label: 'Dashboard', href: '/dashboard' },
          { label: 'Library' },
        ]}
      />

      {trackJobId && (
        <GenerationTracker
          jobId={trackJobId}
          onDismiss={handleDismissTracker}
          onNavigate={(sec) => handleTabChange(sec)}
        />
      )}

      <Tabs value={activeTab} onValueChange={handleTabChange}>
        <TabsList>
          <TabsTrigger value="videos">
            <FileVideo className="mr-1.5 h-4 w-4" />Videos
          </TabsTrigger>
          <TabsTrigger value="images">
            <ImageIcon className="mr-1.5 h-4 w-4" />Images
          </TabsTrigger>
                   <TabsTrigger value="blogs">
            <BookOpen className="mr-1.5 h-4 w-4" />Blog Posts
          </TabsTrigger>
                  </TabsList>

        <TabsContent value="videos"><VideoSection /></TabsContent>
        <TabsContent value="images"><ImageSection highlightJobId={highlight} /></TabsContent>
               <TabsContent value="blogs"><BlogSection /></TabsContent>
      </Tabs>

      
    </div>
  )
}