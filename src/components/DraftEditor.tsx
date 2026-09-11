'use client'

import { useState, useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Input } from '@/components/ui/input'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import StatusBadge from './StatusBadge'
import type { ContentDraft, ContentType } from '@/types/content'
import { Loader2, Save, CheckCircle } from 'lucide-react'

interface DraftEditorProps {
  contentType: ContentType
  draft: ContentDraft | null
  onSave: (draftId: string, data: Record<string, unknown>) => Promise<void>
  // Fix #7: onApprove now receives localData so the page can send the
  // current editor state to the webhook rather than the stale server copy.
  onApprove: (draftId: string, localData: Record<string, unknown>) => Promise<void>
}

const contentTypeLabels: Record<ContentType, string> = {
  image_post: 'Image Post',
  video: 'Video',
  blog: 'Blog Post',
}

export default function DraftEditor({
  contentType,
  draft,
  onSave,
  onApprove,
}: DraftEditorProps) {
  const [saving, setSaving] = useState(false)
  const [approving, setApproving] = useState(false)
  const [localData, setLocalData] = useState<Record<string, unknown>>(
    (draft?.draft_data as Record<string, unknown>) ?? {},
  )

  // Fix #9 — re-sync localData when a new draft arrives (draft.id changes,
  // e.g. null → real ID via realtime). Preserves user edits if the same
  // draft is just re-fetched with the same ID.
  useEffect(() => {
    setLocalData((draft?.draft_data as Record<string, unknown>) ?? {})
  }, [draft?.id])

  const handleSave = async () => {
    if (!draft) return
    setSaving(true)
    try {
      await onSave(draft.id, localData)
    } finally {
      setSaving(false)
    }
  }

  const handleApprove = async () => {
    if (!draft) return
    setApproving(true)
    try {
      // Fix #7: pass current localData so the page sends it to the webhook
      await onApprove(draft.id, localData)
    } finally {
      setApproving(false)
    }
  }

  const updateField = (key: string, value: string) => {
    setLocalData((prev) => ({ ...prev, [key]: value }))
  }

  if (!draft) {
    return (
      <Card className="border bg-white">
        <CardContent className="flex h-48 items-center justify-center">
          <div className="text-center">
            <div className="mb-2 text-2xl">⏳</div>
            <p className="text-sm text-gray-500">
              Waiting for the {contentTypeLabels[contentType]} draft to generate...
            </p>
          </div>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card className="border bg-white">
      <CardHeader className="border-b">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base">
            {contentTypeLabels[contentType]} Draft
          </CardTitle>
          <StatusBadge status={draft.status} />
        </div>
      </CardHeader>
      <CardContent className="space-y-4 p-5">
        {contentType === 'blog' && (
          <>
            <div>
              <label className="mb-1.5 block text-xs font-medium text-gray-700">
                Title
              </label>
              <Input
                value={String(localData.title ?? '')}
                onChange={(e) => updateField('title', e.target.value)}
                placeholder="Blog title..."
                disabled={draft.is_approved}
              />
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-medium text-gray-700">
                Introduction
              </label>
              <Textarea
                value={String(localData.introduction ?? '')}
                onChange={(e) => updateField('introduction', e.target.value)}
                placeholder="Introduction paragraph..."
                rows={3}
                disabled={draft.is_approved}
              />
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-medium text-gray-700">
                Body
              </label>
              <Textarea
                value={String(localData.body ?? '')}
                onChange={(e) => updateField('body', e.target.value)}
                placeholder="Main content..."
                rows={8}
                disabled={draft.is_approved}
              />
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-medium text-gray-700">
                Conclusion
              </label>
              <Textarea
                value={String(localData.conclusion ?? '')}
                onChange={(e) => updateField('conclusion', e.target.value)}
                placeholder="Conclusion..."
                rows={3}
                disabled={draft.is_approved}
              />
            </div>
          </>
        )}

        {contentType === 'image_post' && (
          <>
            <div>
              <label className="mb-1.5 block text-xs font-medium text-gray-700">
                Caption
              </label>
              <Textarea
                value={String(localData.caption ?? '')}
                onChange={(e) => updateField('caption', e.target.value)}
                placeholder="Image post caption..."
                rows={4}
                disabled={draft.is_approved}
              />
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-medium text-gray-700">
                Image Prompt (for KIE AI)
              </label>
              <Textarea
                value={String(localData.image_prompt ?? '')}
                onChange={(e) => updateField('image_prompt', e.target.value)}
                placeholder="Describe the image to generate..."
                rows={3}
                disabled={draft.is_approved}
              />
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-medium text-gray-700">
                Alt Text
              </label>
              <Input
                value={String(localData.alt_text ?? '')}
                onChange={(e) => updateField('alt_text', e.target.value)}
                placeholder="Image alt text..."
                disabled={draft.is_approved}
              />
            </div>
          </>
        )}

        {contentType === 'video' && (
          <>
            <div>
              <label className="mb-1.5 block text-xs font-medium text-gray-700">
                Script / Voiceover
              </label>
              <Textarea
                value={String(localData.script ?? '')}
                onChange={(e) => updateField('script', e.target.value)}
                placeholder="Video script and voiceover text..."
                rows={6}
                disabled={draft.is_approved}
              />
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-medium text-gray-700">
                Visual Description
              </label>
              <Textarea
                value={String(localData.visual_description ?? '')}
                onChange={(e) => updateField('visual_description', e.target.value)}
                placeholder="Describe the visual scenes..."
                rows={4}
                disabled={draft.is_approved}
              />
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-medium text-gray-700">
                Duration (seconds)
              </label>
              <Input
                type="number"
                value={String(localData.duration_seconds ?? '')}
                onChange={(e) => updateField('duration_seconds', e.target.value)}
                placeholder="60"
                disabled={draft.is_approved}
              />
            </div>
          </>
        )}

        {!draft.is_approved && (
          <div className="flex gap-3 pt-2">
            <Button
              variant="outline"
              size="sm"
              onClick={handleSave}
              disabled={saving}
            >
              {saving ? (
                <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Save className="mr-2 h-3.5 w-3.5" />
              )}
              Save Changes
            </Button>
            <Button
              size="sm"
              onClick={handleApprove}
              disabled={approving}
              className="bg-green-600 hover:bg-green-700"
            >
              {approving ? (
                <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
              ) : (
                <CheckCircle className="mr-2 h-3.5 w-3.5" />
              )}
              Approve & Generate
            </Button>
          </div>
        )}

        {draft.is_approved && (
          <div className="flex items-center gap-2 rounded-lg bg-green-50 px-4 py-3 text-sm text-green-700">
            <CheckCircle className="h-4 w-4" />
            Approved — generation in progress
          </div>
        )}
      </CardContent>
    </Card>
  )
}
