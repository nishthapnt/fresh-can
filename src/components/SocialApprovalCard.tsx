'use client'

import { useState, useEffect } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Input } from '@/components/ui/input'
import PlatformSelector from './PlatformSelector'
import StatusBadge from './StatusBadge'
import type { SocialPost, PlatformType } from '@/types/content'
import { Loader2, Send, X } from 'lucide-react'

interface SocialApprovalCardProps {
  socialPost: SocialPost | null
  contentType: string
  onApprove: (
    caption: string,
    hashtags: string[],
    platforms: PlatformType[],
  ) => Promise<void>
}

export default function SocialApprovalCard({
  socialPost,
  contentType,
  onApprove,
}: SocialApprovalCardProps) {
  const [caption, setCaption] = useState(socialPost?.caption ?? '')
  const [hashtagInput, setHashtagInput] = useState('')
  const [hashtags, setHashtags] = useState<string[]>(
    socialPost?.hashtags ?? [],
  )
  const [platforms, setPlatforms] = useState<PlatformType[]>(
    (socialPost?.platforms as PlatformType[]) ?? [],
  )
  const [posting, setPosting] = useState(false)

  // Fix #8 — re-sync form state when socialPost prop changes identity
  // (e.g. null → real post once the parent page's realtime subscription
  // picks up the row the worker just wrote — src/app/dashboard/jobs/
  // [job_id]/social/page.tsx, not n8n)
  useEffect(() => {
    setCaption(socialPost?.caption ?? '')
    setHashtags(socialPost?.hashtags ?? [])
    setPlatforms((socialPost?.platforms as PlatformType[]) ?? [])
  }, [socialPost?.id])

  const addHashtag = () => {
    const tag = hashtagInput.trim().replace(/^#/, '')
    if (tag && !hashtags.includes(tag)) {
      setHashtags((prev) => [...prev, tag])
    }
    setHashtagInput('')
  }

  const removeHashtag = (tag: string) => {
    setHashtags((prev) => prev.filter((h) => h !== tag))
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault()
      addHashtag()
    }
  }

  const handleApprove = async () => {
    if (!caption || platforms.length === 0) return
    setPosting(true)
    try {
      await onApprove(caption, hashtags, platforms)
    } finally {
      setPosting(false)
    }
  }

  const isPosted = socialPost?.status === 'posted'
  const isRetry = socialPost?.status === 'failed'
  // upload-post.com's publish() only ever takes a real image/video file URL
  // (video → /api/upload, everything else → /api/upload_photos with
  // photos[]) — blog content has neither; it's never produced a
  // generated_content row at all (no image, no video), so this has always
  // been a guaranteed "nothing to post" failure deep in the pipeline
  // (submitOnePost/publishPost.ts), not a "not generated yet" wait. Guarding
  // it here rather than building out real blog support (attaching the blog's
  // hero image, or a link-only post where the platform allows one) — that's
  // a genuinely bigger feature decision, not a bug fix.
  const isUnsupportedBlog = contentType === 'blog'

  return (
    <Card className="border bg-white">
      <CardHeader className="border-b">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base capitalize">
            {contentType.replaceAll('_', ' ')} — Social Post
          </CardTitle>
          {socialPost && <StatusBadge status={socialPost.status} />}
        </div>
      </CardHeader>
      <CardContent className="space-y-4 p-5">
        {isUnsupportedBlog ? (
          <div className="rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-700">
            Blog posts can&apos;t be posted directly to social yet — there&apos;s no image or video file to
            attach. Share the blog link manually instead.
          </div>
        ) : (
          <>
            <div>
              <label className="mb-1.5 block text-xs font-medium text-gray-700">
                Caption
              </label>
              <Textarea
                value={caption}
                onChange={(e) => setCaption(e.target.value)}
                placeholder="Write your caption here..."
                rows={4}
                disabled={isPosted}
              />
            </div>

            <div>
              <label className="mb-1.5 block text-xs font-medium text-gray-700">
                Hashtags
              </label>
              <div className="mb-2 flex flex-wrap gap-1.5">
                {hashtags.map((tag) => (
                  <span
                    key={tag}
                    className="flex items-center gap-1 rounded-full bg-blue-50 px-2.5 py-0.5 text-xs text-blue-700"
                  >
                    #{tag}
                    {!isPosted && (
                      <button
                        onClick={() => removeHashtag(tag)}
                        className="ml-0.5 text-blue-400 hover:text-blue-600"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    )}
                  </span>
                ))}
              </div>
              {!isPosted && (
                <div className="flex gap-2">
                  <Input
                    value={hashtagInput}
                    onChange={(e) => setHashtagInput(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder="Add hashtag (press Enter)"
                    className="flex-1"
                  />
                  <Button variant="outline" size="sm" onClick={addHashtag}>
                    Add
                  </Button>
                </div>
              )}
            </div>

            <div>
              <label className="mb-2 block text-xs font-medium text-gray-700">
                Platforms
              </label>
              <PlatformSelector
                selected={platforms}
                onChange={setPlatforms}
                disabled={isPosted}
              />
            </div>

            {isRetry && (
              <div className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">
                The last attempt failed on every selected platform — see the platform status below for
                details. Posting again will retry all of them.
              </div>
            )}

            {!isPosted && (
              <Button
                className="w-full bg-green-600 hover:bg-green-700"
                onClick={handleApprove}
                disabled={posting || !caption || platforms.length === 0}
              >
                {posting ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Send className="mr-2 h-4 w-4" />
                )}
                {isRetry ? 'Retry Post' : 'Approve & Post'}
              </Button>
            )}

            {isPosted && (
              <div className="rounded-lg bg-purple-50 px-4 py-3 text-sm text-purple-700">
                Successfully posted to {platforms.join(', ')}.
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  )
}
