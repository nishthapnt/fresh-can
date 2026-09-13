'use client'

import { useEffect, useState, useCallback, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import KPICard from '@/components/KPICard'
import TopBar from '@/components/layout/TopBar'
import { KPIRowSkeleton } from '@/components/skeletons/Skeleton'
import ActiveGenerationBanner from '@/components/ActiveGenerationBanner'
import {
  getKPIData,
  getVideoLibrary,
  getImageLibrary,
  getBlogLibrary,
} from '@/services/contentService'
import type {
  KPIData,
  VideoLibraryItem,
  ImageLibraryItem,
  BlogLibraryItem,
} from '@/types/content'
import { formatDateTime } from '@/lib/dateUtils'
import {
  AlertCircle,
  BookOpen,
  Briefcase,
  CheckCircle,
  Clock,
  Download,
  ExternalLink,
  FileText,
  FileVideo,
  Image as ImageIcon,
  Inbox,
  Play,
  PlusCircle,
  RefreshCw,
  Share2,
  Tag,
} from 'lucide-react'

// ─── Blog HTML styles ─────────────────────────────────────────────────────────

const BLOG_CSS = `
.db-blog{max-width:760px;margin:0 auto;padding:1.25rem 1.5rem 2rem;font-family:Georgia,serif;line-height:1.8;color:#1a1a1a}
.db-blog h1{display:none}.db-blog .hero-image,.db-blog figure.hero-image{display:none}
.db-blog h2{font-size:1.25rem;font-weight:600;margin:1.75rem 0 .6rem;border-bottom:1px solid #f0f0f0;padding-bottom:.35rem}
.db-blog h3{font-size:1rem;font-weight:600;margin:1.25rem 0 .4rem}
.db-blog p{margin:0 0 1.1rem}
.db-blog ul,.db-blog ol{margin:.75rem 0 1.25rem 1.5rem;padding:0}
.db-blog li{margin-bottom:.4rem}
.db-blog blockquote{border-left:4px solid #2d7a3e;margin:1.5rem 0;padding:.875rem 1.25rem;background:#f0f7f1;border-radius:0 6px 6px 0}
.db-blog blockquote p{margin:0 0 .4rem;font-style:italic}
.db-blog blockquote cite{font-size:.8rem;color:#666}
.db-blog .cta-button,.db-blog a.cta-button{display:inline-block;background:#2d7a3e;color:#fff;padding:.75rem 1.5rem;border-radius:6px;text-decoration:none;font-weight:600;margin-top:.75rem}
.db-blog .cta-section{background:#f0f7f1;border-radius:10px;padding:1.5rem;margin-top:2rem}
.db-blog a{color:#2d7a3e;text-decoration:underline}
.db-blog .inline-image,.db-blog figure.inline-image{margin:1.5rem auto;max-width:100%;display:block}
.db-blog .inline-image img,.db-blog figure.inline-image img{width:100%;height:auto;border-radius:6px}
.db-blog figcaption{text-align:center;font-size:.78rem;color:#777;margin-top:.4rem;font-style:italic}
`

// ─── Mini skeletons ───────────────────────────────────────────────────────────

function MiniGridSkeleton({ type }: { type: 'video' | 'image' | 'blog' }) {
  return (
    <div className={`grid gap-2 sm:gap-3 ${type === 'blog' ? 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-4' : 'grid-cols-2 lg:grid-cols-4'}`}>
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="overflow-hidden rounded-xl border bg-white">
          <div
            className={`animate-pulse bg-gray-100 ${
              // Video/image cards are always square now, regardless of the
              // underlying clip's own aspect ratio — the preview crops to
              // fit (object-cover) rather than the card stretching to match.
              type === 'video' || type === 'image' ? 'aspect-square' : 'h-24'
            }`}
          />
          <div className="space-y-1.5 p-3">
            <div className="h-3 w-4/5 animate-pulse rounded bg-gray-100" />
            <div className="h-2.5 w-1/2 animate-pulse rounded bg-gray-100" />
          </div>
        </div>
      ))}
    </div>
  )
}

// ─── Section header ───────────────────────────────────────────────────────────

function SectionHeader({
  icon: Icon,
  title,
  count,
  color,
  onViewAll,
}: {
  icon: React.ElementType
  title: string
  count: number
  color: string
  onViewAll: () => void
}) {
  return (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-2">
        <div className={`flex h-7 w-7 items-center justify-center rounded-lg ${color}`}>
          <Icon className="h-3.5 w-3.5" />
        </div>
        <h2 className="text-sm font-semibold text-gray-900">{title}</h2>
        {count > 0 && (
          <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[11px] text-gray-500">
            {count}
          </span>
        )}
      </div>
      {count > 0 && (
        <button
          onClick={onViewAll}
          className="text-xs text-gray-400 transition-colors hover:text-gray-700"
        >
          View all →
        </button>
      )}
    </div>
  )
}

// ─── Section empty (compact inline) ──────────────────────────────────────────

function SectionEmpty({
  message,
  onAction,
}: {
  message: string
  onAction: () => void
}) {
  return (
    <div className="flex items-center justify-between rounded-xl border border-dashed border-gray-200 bg-gray-50 px-5 py-4">
      <p className="text-sm text-gray-400">{message}</p>
      <Button size="sm" variant="outline" className="text-xs" onClick={onAction}>
        <PlusCircle className="mr-1.5 h-3.5 w-3.5" />Create
      </Button>
    </div>
  )
}

// ─── MiniVideoCard ────────────────────────────────────────────────────────────
// `variants` holds this job's EN and/or FR final video (a BOTH-language job
// has both). The collapsed card only ever shows one preview — no doubled
// card, no extra grid space — and a language toggle appears inside the
// modal opened on click, only when both languages actually exist.

function MiniVideoCard({ variants }: { variants: Partial<Record<'EN' | 'FR', VideoLibraryItem>> }) {
  const [open, setOpen] = useState(false)
  const available = (['EN', 'FR'] as const).filter((l) => variants[l])
  const [selected, setSelected] = useState<'EN' | 'FR'>(available[0] ?? 'EN')
  const item = variants[selected] ?? variants[available[0]]
  if (!item) return null

  const rawDuration = item.output_data?.duration_sec
  const duration = rawDuration ? Math.round(rawDuration * 10) / 10 : rawDuration
  const filename = `${item.topic.slice(0, 40).replace(/\s+/g, '-').toLowerCase()}-${item.language}.mp4`

  return (
    <>
      <Card
        className="group cursor-pointer overflow-hidden border bg-white shadow-sm transition-all hover:shadow-md"
        onClick={() => setOpen(true)}
      >
        <div className="relative aspect-square overflow-hidden bg-black">
          <video
            src={item.video_url}
            className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
            preload="metadata"
            playsInline
          />
          <div className="absolute inset-0 flex items-center justify-center bg-black/30 opacity-0 transition-opacity group-hover:opacity-100">
            <div className="flex h-9 w-9 items-center justify-center rounded-full bg-white/90 shadow-md">
              <Play className="ml-0.5 h-4 w-4 text-gray-900" />
            </div>
          </div>
          {available.length > 1 && (
            <span className="absolute left-1.5 top-1.5 rounded bg-black/60 px-1 py-0.5 text-[10px] font-medium text-white">
              EN/FR
            </span>
          )}
          {duration && (
            <span className="absolute bottom-1.5 right-1.5 rounded bg-black/60 px-1 py-0.5 text-[10px] font-medium text-white">
              {duration}s
            </span>
          )}
        </div>
        <div className="p-3">
          <p className="line-clamp-2 text-xs font-semibold leading-snug text-gray-900">
            {item.topic}
          </p>
          <p className="mt-1 flex items-center gap-1 text-[10px] text-gray-400">
            <Clock className="h-2.5 w-2.5" />{formatDateTime(item.completed_at)}
          </p>
        </div>
      </Card>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="w-[95vw] gap-0 overflow-hidden p-0 sm:max-w-3xl">
          <div className="bg-black">
            <video
              key={item.id}
              src={item.video_url}
              controls
              autoPlay
              playsInline
              className="max-h-[55vh] w-full sm:max-h-[65vh]"
            />
          </div>
          <div className="flex items-start justify-between gap-3 p-4">
            <div className="min-w-0 flex-1">
              <h3 className="text-sm font-semibold text-gray-900 sm:text-base">{item.topic}</h3>
              {available.length > 1 && (
                <div className="mt-1.5 inline-flex rounded-lg border border-gray-200 bg-gray-50 p-0.5">
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
              )}
              <p className="mt-1.5 text-xs text-gray-500 sm:text-sm">
                {item.category} · {item.language}{duration ? ` · ${duration}s` : ''}
              </p>
            </div>
            <a href={item.video_url} download={filename}>
              <Button size="sm" variant="outline">
                <Download className="mr-1.5 h-3.5 w-3.5" />Download
              </Button>
            </a>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}

// ─── MiniImageCard ────────────────────────────────────────────────────────────

function MiniImageCard({ item }: { item: ImageLibraryItem }) {
  const [open, setOpen] = useState(false)
  const filename = `${item.topic.slice(0, 40).replace(/\s+/g, '-').toLowerCase()}.jpg`

  return (
    <>
      <Card
        className="group cursor-pointer overflow-hidden border bg-white shadow-sm transition-all hover:shadow-md"
        onClick={() => setOpen(true)}
      >
        <div className="relative aspect-square overflow-hidden bg-gray-100">
          <img
            src={item.image_url}
            alt={item.topic}
            className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
            loading="lazy"
          />
        </div>
        <div className="p-3">
          <p className="line-clamp-2 text-xs font-semibold leading-snug text-gray-900">
            {item.topic}
          </p>
          <p className="mt-1 flex items-center gap-1 text-[10px] text-gray-400">
            <Clock className="h-2.5 w-2.5" />{formatDateTime(item.completed_at)}
          </p>
        </div>
      </Card>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="w-[95vw] gap-0 overflow-hidden p-0 sm:max-w-2xl">
          <div className="flex max-h-[60vh] items-center justify-center overflow-hidden bg-gray-100">
            <img
              src={item.image_url}
              alt={item.topic}
              className="max-h-[60vh] max-w-full object-contain"
            />
          </div>
          <div className="flex items-start justify-between gap-3 p-4">
            <div className="min-w-0 flex-1">
              <h3 className="text-sm font-semibold text-gray-900 sm:text-base">{item.topic}</h3>
              <p className="mt-0.5 text-xs text-gray-500 sm:text-sm">{item.category} · {item.language}</p>
            </div>
            <a href={item.image_url} download={filename}>
              <Button size="sm" variant="outline">
                <Download className="mr-1.5 h-3.5 w-3.5" />Download
              </Button>
            </a>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}

// ─── MiniBlogCard ─────────────────────────────────────────────────────────────

function MiniBlogCard({ item }: { item: BlogLibraryItem }) {
  const [open, setOpen] = useState(false)

  const od      = item.output_data
  const title   = od?.post_title   ?? od?.title   ?? item.topic
  const excerpt = od?.post_excerpt ?? od?.excerpt  ?? od?.content?.slice(0, 130) ?? null
  const tags    = od?.tags ?? []
  const heroUrl = od?.hero_image_url ?? od?.images?.hero?.url ?? null
  const readTime = od?.seo?.estimated_read_time ?? null

  // Prefer rendered HTML, then plain text fallback
  const htmlFinal  = od?.html_final    ?? od?.post_content ?? null
  const textFallback = od?.content ?? null
  const hasContent = !!(htmlFinal || textFallback || item.file_url)

  return (
    <>
      <Card
        className={`border bg-white shadow-sm transition-all hover:shadow-md${hasContent ? ' cursor-pointer' : ''}`}
        onClick={() => { if (hasContent) setOpen(true) }}
      >
        <CardContent className="space-y-2 p-3">
          <div className="flex items-start gap-2">
            <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-amber-100 bg-amber-50">
              <BookOpen className="h-3.5 w-3.5 text-amber-600" />
            </div>
            <div className="min-w-0">
              <p className="line-clamp-2 text-xs font-semibold leading-snug text-gray-900">{title}</p>
            </div>
          </div>
          {excerpt && (
            <p className="line-clamp-2 text-[11px] leading-relaxed text-gray-500">{excerpt}</p>
          )}
          {tags.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {tags.slice(0, 2).map((tag) => (
                <span key={tag} className="inline-flex items-center gap-0.5 rounded-full bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-500">
                  <Tag className="h-2 w-2" />{tag}
                </span>
              ))}
            </div>
          )}
          <p className="flex items-center gap-1 text-[10px] text-gray-400">
            <Clock className="h-2.5 w-2.5" />{formatDateTime(item.completed_at)}
          </p>
        </CardContent>
      </Card>

      {hasContent && (
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent className="flex max-h-[92vh] w-[95vw] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl">
            <style dangerouslySetInnerHTML={{ __html: BLOG_CSS }} />

            {/* Header */}
            <div className="shrink-0 border-b p-4 sm:p-5">
              {heroUrl && (
                <img
                  src={heroUrl}
                  alt={title}
                  className="mb-3 h-40 w-full rounded-lg object-cover"
                />
              )}
              <h2 className="text-base font-bold leading-snug text-gray-900 sm:text-lg">{title}</h2>
              <p className="mt-1 text-xs text-gray-500 sm:text-sm">
                {item.category} · {item.language}{readTime ? ` · ${readTime} read` : ''}
              </p>
            </div>

            {/* Body */}
            <div className="min-h-0 flex-1 overflow-y-auto">
              {htmlFinal ? (
                <div
                  className="db-blog"
                  dangerouslySetInnerHTML={{ __html: htmlFinal }}
                />
              ) : textFallback ? (
                <div className="p-4 sm:p-5">
                  <p className="whitespace-pre-wrap text-sm leading-7 text-gray-800">{textFallback}</p>
                </div>
              ) : null}
            </div>

            {/* Footer */}
            {item.file_url && (
              <div className="flex shrink-0 justify-end border-t p-4">
                <a href={item.file_url} target="_blank" rel="noopener noreferrer">
                  <Button size="sm" variant="outline">
                    <ExternalLink className="mr-1.5 h-3.5 w-3.5" />Open Post
                  </Button>
                </a>
              </div>
            )}
          </DialogContent>
        </Dialog>
      )}
    </>
  )
}

// ─── Dashboard Page ───────────────────────────────────────────────────────────

export default function DashboardPage() {
  const router = useRouter()

  const [kpi, setKpi]       = useState<KPIData | null>(null)
  const [videos, setVideos] = useState<VideoLibraryItem[]>([])
  const [images, setImages] = useState<ImageLibraryItem[]>([])
  const [blogs, setBlogs]   = useState<BlogLibraryItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [kpiData, vids, imgs, blgs] = await Promise.all([
        getKPIData(),
        getVideoLibrary(),
        getImageLibrary(),
        getBlogLibrary(),
      ])
      setKpi(kpiData)
      // Grouped by job_id below (videoGroups) so a BOTH-language job renders
      // as one card with a toggle instead of two — sliced to the newest 4
      // there, not here, since slicing raw EN/FR rows to 4 first could grab
      // both rows of 2 jobs and leave less than 4 cards to show.
      setVideos(vids)
      setImages(imgs.slice(0, 4))
      setBlogs(blgs.slice(0, 4))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load data')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  // Groups videos by job_id, so a BOTH-language job's EN and FR rows become
  // one card (MiniVideoCardGroup) instead of two separate ones — same
  // convention as dashboard/library/LibraryContent.tsx's VideoCardGroup.
  // Sliced to the newest 4 GROUPS here (not raw rows) — see the load()
  // comment above for why the order matters.
  const videoGroups = useMemo(() => {
    const map = new Map<string, Partial<Record<'EN' | 'FR', VideoLibraryItem>>>()
    const order: string[] = []
    for (const item of videos) {
      if (!map.has(item.job_id)) {
        map.set(item.job_id, {})
        order.push(item.job_id)
      }
      const langKey = item.language === 'FR' ? 'FR' : 'EN'
      map.get(item.job_id)![langKey] = item
    }
    return order.slice(0, 4).map((jobId) => ({ jobId, variants: map.get(jobId)! }))
  }, [videos])

  const hasAnyContent = videoGroups.length > 0 || images.length > 0 || blogs.length > 0

  return (
    <div className="space-y-6 sm:space-y-8">
      <TopBar
        title="Dashboard"
        breadcrumbs={[{ label: 'Fresh-CAN Studio' }, { label: 'Dashboard' }]}
        actions={
          <Button
            onClick={() => router.push('/dashboard/new')}
            className="w-full bg-green-600 hover:bg-green-700 sm:w-auto"
            size="sm"
          >
            <PlusCircle className="mr-2 h-4 w-4" />
            Create New Content
          </Button>
        }
      />

      {/* Active generation banner */}
      <ActiveGenerationBanner />

      {/* KPI Cards */}
      {loading ? (
        <KPIRowSkeleton />
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
          <KPICard
            title="Total Jobs"
            value={kpi?.total_jobs ?? 0}
            icon={Briefcase}
            iconBg="bg-blue-50"
            iconColor="text-blue-600"
            trendLabel="all time"
          />
          <KPICard
            title="Drafts Pending"
            value={kpi?.drafts_pending ?? 0}
            icon={FileText}
            iconBg="bg-amber-50"
            iconColor="text-amber-600"
            trendLabel="awaiting review"
          />
          <KPICard
            title="Ready to Post"
            value={kpi?.ready_to_post ?? 0}
            icon={CheckCircle}
            iconBg="bg-green-50"
            iconColor="text-green-600"
            trendLabel="generated, not yet posted"
          />
          <KPICard
            title="Posted Today"
            value={kpi?.posted_today ?? 0}
            icon={Share2}
            iconBg="bg-purple-50"
            iconColor="text-purple-600"
            trendLabel="social posts sent today"
          />
        </div>
      )}

      {/* Error */}
      {error && !loading && (
        <div className="flex items-start gap-3 rounded-xl border border-red-200 bg-red-50 p-4">
          <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-red-500" />
          <div className="flex-1">
            <p className="text-sm font-medium text-red-700">Failed to load data</p>
            <p className="mt-0.5 text-xs text-red-600">{error}</p>
          </div>
          <Button size="sm" variant="outline" className="border-red-200 text-red-600 hover:bg-red-100" onClick={load}>
            <RefreshCw className="mr-1.5 h-3.5 w-3.5" />Retry
          </Button>
        </div>
      )}

      {/* ── Recent Content ──────────────────────────────────────────────────── */}
      <div className="space-y-6 sm:space-y-7">

        {/* ── Videos ── */}
        <div className="space-y-3">
          <SectionHeader
            icon={FileVideo}
            title="Recent Videos"
            count={videoGroups.length}
            color="bg-blue-50 text-blue-600"
            onViewAll={() => router.push('/dashboard/library')}
          />
          {loading ? (
            <MiniGridSkeleton type="video" />
          ) : videoGroups.length === 0 ? (
            <SectionEmpty
              message="No videos yet — approve a script to get started"
              onAction={() => router.push('/dashboard/new')}
            />
          ) : (
            <div className="grid grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-4">
              {videoGroups.map((g) => <MiniVideoCard key={g.jobId} variants={g.variants} />)}
            </div>
          )}
        </div>

        {/* ── Images ── */}
        <div className="space-y-3">
          <SectionHeader
            icon={ImageIcon}
            title="Recent Images"
            count={images.length}
            color="bg-pink-50 text-pink-600"
            onViewAll={() => router.push('/dashboard/library')}
          />
          {loading ? (
            <MiniGridSkeleton type="image" />
          ) : images.length === 0 ? (
            <SectionEmpty
              message="No images yet — create an image post request"
              onAction={() => router.push('/dashboard/new')}
            />
          ) : (
            <div className="grid grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-4">
              {images.map((v) => <MiniImageCard key={v.id} item={v} />)}
            </div>
          )}
        </div>

        {/* ── Blogs ── */}
        <div className="space-y-3">
          <SectionHeader
            icon={BookOpen}
            title="Recent Blog Posts"
            count={blogs.length}
            color="bg-amber-50 text-amber-600"
            onViewAll={() => router.push('/dashboard/library')}
          />
          {loading ? (
            <MiniGridSkeleton type="blog" />
          ) : blogs.length === 0 ? (
            <SectionEmpty
              message="No blog posts yet — create a blog post request"
              onAction={() => router.push('/dashboard/new')}
            />
          ) : (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 sm:gap-3 lg:grid-cols-4">
              {blogs.map((v) => <MiniBlogCard key={v.id} item={v} />)}
            </div>
          )}
        </div>

        {/* ── First-time empty state (all 3 empty) ── */}
        {!loading && !hasAnyContent && !error && (
          <div className="flex flex-col items-center justify-center rounded-2xl border-2 border-dashed border-gray-200 bg-gray-50 py-16 text-center">
            <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-white shadow-sm">
              <Inbox className="h-8 w-8 text-gray-300" />
            </div>
            <h3 className="text-base font-semibold text-gray-700">No content generated yet</h3>
            <p className="mt-1.5 max-w-xs text-sm text-gray-500">
              Submit your first topic and Fresh-CAN will generate videos, images, and blog posts simultaneously.
            </p>
            <Button
              className="mt-6 bg-green-600 hover:bg-green-700"
              onClick={() => router.push('/dashboard/new')}
            >
              <PlusCircle className="mr-2 h-4 w-4" />
              Create your first content
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}
