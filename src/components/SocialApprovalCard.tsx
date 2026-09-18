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
            Approve & Post
          </Button>
        )}

        {isPosted && (
          <div className="rounded-lg bg-purple-50 px-4 py-3 text-sm text-purple-700">
            Successfully posted to {platforms.join(', ')}.
          </div>
        )}
      </CardContent>
    </Card>
  )
}
