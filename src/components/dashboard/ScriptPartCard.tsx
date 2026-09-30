'use client'

import { useEffect, useState } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Textarea } from '@/components/ui/textarea'

export interface ScriptPart {
  speaker: string
  text: string
  video_prompt: string
  image_prompt: string
  word_count: number
}

interface ScriptPartCardProps {
  index: number
  part: ScriptPart
  onChange: (index: number, field: string, value: string) => void
  disabled?: boolean
}

const BADGE_COLORS: Record<string, string> = {
  A:   'bg-red-100 text-red-700 border-red-300',
  B:   'bg-blue-100 text-blue-700 border-blue-300',
  VO:  'bg-purple-100 text-purple-700 border-purple-300',
  CTA: 'bg-green-100 text-green-700 border-green-300',
}

const SPEAKER_LABELS: Record<string, string> = {
  A:   'Speaker A — Problem',
  B:   'Speaker B — Solution',
  VO:  'Voiceover',
  CTA: 'Call to Action',
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <label className="block text-xs font-medium text-gray-500 uppercase tracking-wide">
      {children}
    </label>
  )
}

export default function ScriptPartCard({
  index,
  part,
  onChange,
  disabled = false,
}: ScriptPartCardProps) {
  const [text, setText] = useState(part.text)
  const [videoPrompt, setVideoPrompt] = useState(part.video_prompt)
  const [imagePrompt, setImagePrompt] = useState(part.image_prompt)

  useEffect(() => {
    setText(part.text)
    setVideoPrompt(part.video_prompt)
    setImagePrompt(part.image_prompt)
  }, [part.text, part.video_prompt, part.image_prompt])

  const handle = (
    setter: React.Dispatch<React.SetStateAction<string>>,
    field: string,
  ) => (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setter(e.target.value)
    onChange(index, field, e.target.value)
  }

  const badgeClass = BADGE_COLORS[part.speaker] ?? 'bg-gray-100 text-gray-700 border-gray-300'
  const speakerLabel = SPEAKER_LABELS[part.speaker] ?? `Speaker ${part.speaker}`
  const wordCount = text.trim().split(/\s+/).filter(Boolean).length

  return (
    <Card className="border bg-white">
      <CardContent className="space-y-4 p-5">

        {/* Header */}
        <div className="flex items-center gap-2.5">
          <span className="text-xs font-medium text-gray-400 tabular-nums w-12">
            Part {index + 1}
          </span>
          <span
            className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-bold tracking-wide ${badgeClass}`}
          >
            {part.speaker}
          </span>
          <span className="text-sm font-semibold text-gray-700">{speakerLabel}</span>
        </div>

        {/* Spoken Text */}
        <div className="space-y-1.5">
          <FieldLabel>Spoken Text</FieldLabel>
          <Textarea
            value={text}
            onChange={handle(setText, 'text')}
            rows={2}
            disabled={disabled}
            className="resize-none text-sm"
          />
          <p className="text-xs text-gray-400">
            {wordCount} word{wordCount !== 1 ? 's' : ''}
          </p>
        </div>

        {/* Video Prompt */}
        <div className="space-y-1.5">
          <FieldLabel>Video Prompt — Seedance</FieldLabel>
          <Textarea
            value={videoPrompt}
            onChange={handle(setVideoPrompt, 'video_prompt')}
            rows={3}
            disabled={disabled}
            className="resize-none text-sm"
          />
        </div>

        {/* Image Prompt (conditional) */}
        {imagePrompt !== '' ? (
          <div className="space-y-1.5">
            <FieldLabel>Image Prompt — nano-banana-2</FieldLabel>
            <Textarea
              value={imagePrompt}
              onChange={handle(setImagePrompt, 'image_prompt')}
              rows={2}
              disabled={disabled}
              className="resize-none text-sm"
            />
          </div>
        ) : (
          <div className="flex items-center gap-2 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2.5">
            <span className="text-sm text-gray-500">📷 Real photo used for this scene</span>
          </div>
        )}

      </CardContent>
    </Card>
  )
}
