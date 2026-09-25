'use client'

import { useEffect, useState, useCallback } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Button } from '@/components/ui/button'
import SocialApprovalCard from '@/components/SocialApprovalCard'
import StatusBadge from '@/components/StatusBadge'
import LanguageToggle from '@/components/LanguageToggle'
import TopBar from '@/components/layout/TopBar'
import { SocialPageSkeleton } from '@/components/skeletons/Skeleton'
import { supabase } from '@/lib/supabase'
import {
  getContentJob,
  getGeneratedContent,
  getSocialPostsForJob,
  upsertSocialPost,
  getPlatformLogsForPost,
  getSocialConnectionStatus,
} from '@/services/contentService'
import type {
  ContentJob,
  ContentType,
  GeneratedContent,
  SocialPost,
  SocialPlatformLog,
  PlatformType,
  PlatformConnectionMap,
} from '@/types/content'
import {
  AlertCircle,
  FileVideo,
  Image,
  FileText,
  RefreshCw,
} from 'lucide-react'

const CONTENT_TYPE_LABELS: Record<ContentType, string> = {
  image_post: 'Image Post',
  video: 'Video',
  blog: 'Blog Post',
}

const typeIcons: Record<ContentType, React.ReactNode> = {
  video: <FileVideo className="h-3.5 w-3.5" />,
  image_post: <Image className="h-3.5 w-3.5" />,
  blog: <FileText className="h-3.5 w-3.5" />,
}

function ContentPreview({
  contentType,
  generated,
}: {
  contentType: ContentType
  generated: GeneratedContent | null
}) {
  if (!generated?.file_url) {
    return (
      <div className="flex h-48 flex-col items-center justify-center rounded-xl border-2 border-dashed border-gray-200 bg-gray-50 text-center">
        <div className="text-2xl mb-2">🎬</div>
        <p className="text-sm text-gray-400">Content not yet generated</p>
      </div>
    )
  }

  if (contentType === 'video') {
    return (
      <video
        src={generated.file_url}
        controls
        poster={generated.thumbnail_url ?? undefined}
        className="w-full rounded-xl shadow-sm"
      />
    )
  }

  if (contentType === 'image_post') {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={generated.file_url}
        alt="Generated image"
        className="w-full rounded-xl object-cover shadow-sm"
      />
    )
  }

  return (
    <a
      href={generated.file_url}
      target="_blank"
      rel="noopener noreferrer"
      className="flex items-center gap-2.5 rounded-xl border border-blue-200 bg-blue-50 p-4 text-sm font-medium text-blue-600 transition-colors hover:bg-blue-100"
    >
      <FileText className="h-4 w-4" />
      Open Blog Post →
    </a>
  )
}

export default function SocialPage() {
  const { job_id } = useParams<{ job_id: string }>()
  const router = useRouter()
  const [job, setJob] = useState<ContentJob | null>(null)
  const [generated, setGenerated] = useState<GeneratedContent[]>([])
  const [socialPosts, setSocialPosts] = useState<SocialPost[]>([])
  const [platformLogs, setPlatformLogs] = useState<Record<string, SocialPlatformLog[]>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // Which language's post is shown per content type — mirrors src/app/dashboard/jobs/
  // [job_id]/page.tsx's own selectedLanguage/getEffectiveLanguage (draft editing),
  // now that social_posts has the same one-row-per-language shape as generated_content.
  const [selectedLanguage, setSelectedLanguage] = useState<Map<ContentType, string>>(new Map())
  const [connectionStatus, setConnectionStatus] = useState<PlatformConnectionMap | null>(null)

  const load = useCallback(async () => {
    try {
      const [jobData, gen, posts, connection] = await Promise.all([
        getContentJob(job_id),
        getGeneratedContent(job_id),
        getSocialPostsForJob(job_id),
        getSocialConnectionStatus(),
      ])
      if (!jobData) throw new Error('Job not found')
      if (jobData.status !== 'ready') {
        router.push(`/dashboard/jobs/${job_id}`)
        return
      }
      setJob(jobData)
      setGenerated(gen)
      setSocialPosts(posts)
      setConnectionStatus(connection.platforms)
      const logs: Record<string, SocialPlatformLog[]> = {}
      await Promise.all(
        posts.map(async (post) => {
          logs[post.id] = await getPlatformLogsForPost(post.id)
        }),
      )
      setPlatformLogs(logs)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [job_id, router])

  useEffect(() => { load() }, [load])

  // Without this, the page only ever reflected whatever state existed the
  // instant handleApprovePost's own load() ran — before the worker's
  // tickSocial() (worker/src/steps/social/publishPost.ts) had done anything
  // at all, since submission/polling now happen asynchronously in the
  // worker instead of within the original request. A viewer would never
  // see 'posting' → 'posted'/'failed' or a platform's error_message appear
  // without manually refreshing the browser tab. Mirrors the same
  // postgres_changes pattern src/app/dashboard/jobs/[job_id]/page.tsx
  // already uses for content_drafts/content_jobs.
  useEffect(() => {
    const channel = supabase
      .channel(`social-watch-${job_id}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'social_posts', filter: `job_id=eq.${job_id}` },
        (payload) => {
          if (payload.eventType === 'DELETE') return
          const row = payload.new as SocialPost
          setSocialPosts((prev) => {
            const idx = prev.findIndex((p) => p.id === row.id)
            if (idx === -1) return [...prev, row]
            const next = [...prev]
            next[idx] = row
            return next
          })
        },
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'social_platform_logs', filter: `job_id=eq.${job_id}` },
        (payload) => {
          if (payload.eventType === 'DELETE') return
          const row = payload.new as SocialPlatformLog
          setPlatformLogs((prev) => {
            const existing = prev[row.social_post_id] ?? []
            const idx = existing.findIndex((l) => l.id === row.id)
            const updated = idx === -1 ? [...existing, row] : existing.map((l, i) => (i === idx ? row : l))
            return { ...prev, [row.social_post_id]: updated }
          })
        },
      )
      .subscribe()

    return () => { supabase.removeChannel(channel) }
  }, [job_id])

  // Languages that actually have generated content for this content type —
  // mirrors page.tsx's getAvailableLanguages (there: scanning drafts; here:
  // scanning generated_content, since that's what's postable). A row's
  // language can be null only for legacy pre-language-column data (see
  // types/content.ts's GeneratedContent) — never usable as a selectable tab.
  const getAvailableLanguages = (type: ContentType): string[] => {
    const langs = new Set<string>()
    for (const g of generated) {
      if (g.content_type === type && g.language) langs.add(g.language)
    }
    return [...langs]
  }

  const getEffectiveLanguage = (type: ContentType): string => {
    const chosen = selectedLanguage.get(type)
    if (chosen) return chosen
    const jobLang = job?.language ?? 'EN'
    return jobLang === 'BOTH' ? 'EN' : jobLang
  }

  const getSocialPostForType = (type: ContentType, language: string): SocialPost | null =>
    socialPosts.find((p) => p.content_type === type && p.language === language) ?? null

  const getGeneratedForType = (type: ContentType, language: string): GeneratedContent | null =>
    generated.find((g) => g.content_type === type && g.language === language) ?? null

  const handleApprovePost = async (
    contentType: ContentType,
    language: 'EN' | 'FR',
    caption: string,
    hashtags: string[],
    platforms: PlatformType[],
  ) => {
    // upsertSocialPost writes status='approved' — that IS the trigger now.
    // worker/src/steps/social/publishPost.ts's tickSocial() picks up any
    // approved social_posts row with no social_platform_logs yet on its
    // next poll tick and calls upload-post.com directly (replaces the old
    // n8n webhook + eager client-side 'posting' write, ARCHITECTURE.MD
    // §2.5). Setting 'posting' here before any real work had started was
    // itself a contributor to the confirmed-live stuck-forever bug
    // (TASKS.md/PROGRESS.md) — a post could land at 'posting' with zero
    // matching social_platform_logs rows if the webhook call below then
    // failed or hung, with no way back. The worker is the only thing that
    // writes 'posting' now, and only once it actually has a provider job
    // ref to poll.
    await upsertSocialPost(job_id, contentType, language, caption, hashtags, platforms)
    await load()
  }

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="h-14 w-full animate-pulse rounded-xl bg-gray-100" />
        <div className="h-10 w-64 animate-pulse rounded-lg bg-gray-100" />
        <SocialPageSkeleton />
      </div>
    )
  }

  if (error || !job) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-center">
        <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-red-50">
          <AlertCircle className="h-8 w-8 text-red-400" />
        </div>
        <h3 className="text-base font-semibold text-gray-700">{error ?? 'Job not found'}</h3>
        <div className="mt-6 flex gap-3">
          <Button variant="outline" onClick={() => router.push('/dashboard')}>
            Back to Dashboard
          </Button>
          <Button onClick={() => { setLoading(true); setError(null); load() }}>
            <RefreshCw className="mr-2 h-4 w-4" />
            Retry
          </Button>
        </div>
      </div>
    )
  }

  const contentTypes = job.content_types as ContentType[]

  return (
    <div className="space-y-6">
      <TopBar
        title="Social Approval"
        breadcrumbs={[
          { label: 'Dashboard', href: '/dashboard' },
          { label: 'Jobs', href: `/dashboard/jobs/${job_id}` },
          { label: job.topic.length > 28 ? job.topic.slice(0, 28) + '…' : job.topic },
          { label: 'Social' },
        ]}
        actions={<StatusBadge status={job.status} />}
      />

      <Tabs defaultValue={contentTypes[0]}>
        <TabsList
          className="grid w-full"
          style={{ gridTemplateColumns: `repeat(${contentTypes.length}, 1fr)` }}
        >
          {contentTypes.map((type) => {
            const post = getSocialPostForType(type, getEffectiveLanguage(type))
            return (
              <TabsTrigger key={type} value={type} className="gap-1.5">
                {typeIcons[type]}
                {CONTENT_TYPE_LABELS[type]}
                {post && <StatusBadge status={post.status} className="text-[10px]" />}
              </TabsTrigger>
            )
          })}
        </TabsList>

        {contentTypes.map((type) => {
          const languages = getAvailableLanguages(type)
          const language = getEffectiveLanguage(type)
          // Fix #10 — cache lookup once per tab instead of calling getSocialPostForType 3×
          const socialPost = getSocialPostForType(type, language)
          return (
          <TabsContent key={type} value={type} className="mt-4">
            <LanguageToggle
              languages={languages}
              selected={language}
              onSelect={(lang) => setSelectedLanguage((prev) => new Map(prev).set(type, lang))}
            />
            <div className="grid gap-6 lg:grid-cols-2">
              {/* Preview */}
              <div className="space-y-3">
                <h3 className="text-sm font-semibold text-gray-700">
                  Generated Content Preview
                </h3>
                <ContentPreview
                  contentType={type}
                  generated={getGeneratedForType(type, language)}
                />
              </div>

              {/* Social approval + logs */}
              <div className="space-y-4">
                <SocialApprovalCard
                  socialPost={socialPost}
                  contentType={type}
                  onApprove={(caption, hashtags, platforms) =>
                    handleApprovePost(type, language as 'EN' | 'FR', caption, hashtags, platforms)
                  }
                  connectionStatus={connectionStatus}
                />

                {/* Platform posting logs */}
                {socialPost && (
                  <div>
                    <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
                      Platform Status
                    </h4>
                    <div className="space-y-2">
                      {(platformLogs[socialPost.id] ?? []).length === 0 ? (
                        <p className="text-xs text-gray-400">
                          {socialPost.status === 'approved'
                            ? 'Approved — waiting for the next posting cycle (usually a few seconds).'
                            : 'No platform activity yet.'}
                        </p>
                      ) : (
                        (platformLogs[socialPost.id] ?? []).map((log) => (
                          <div
                            key={log.id}
                            className="rounded-lg border bg-white px-3 py-2.5 text-xs shadow-sm"
                          >
                            <div className="flex items-center justify-between">
                              <span className="font-medium capitalize text-gray-700">
                                {log.platform}
                              </span>
                              <div className="flex items-center gap-2">
                                <StatusBadge
                                  status={log.status as Parameters<typeof StatusBadge>[0]['status']}
                                />
                                {log.post_url && (
                                  <a
                                    href={log.post_url}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-blue-500 underline hover:text-blue-700"
                                  >
                                    View post
                                  </a>
                                )}
                              </div>
                            </div>
                            {log.status === 'failed' && log.error_message && (
                              <p className="mt-1.5 text-[11px] leading-snug text-red-600">
                                {log.error_message}
                              </p>
                            )}
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </TabsContent>
          )
        })}
      </Tabs>
    </div>
  )
}
