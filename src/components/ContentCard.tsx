'use client'

import { Card, CardContent } from '@/components/ui/card'
import StatusBadge from './StatusBadge'
import type { ContentJob } from '@/types/content'
import { formatDistanceToNow } from '@/lib/dateUtils'

interface ContentCardProps {
  job: ContentJob
  onClick: () => void
}

export default function ContentCard({ job, onClick }: ContentCardProps) {
  return (
    <Card
      className="cursor-pointer border bg-white transition-colors hover:border-primary/40"
      onClick={onClick}
    >
      <CardContent className="p-5">
        <div className="mb-3 flex items-start justify-between gap-2">
          <h3 className="line-clamp-2 text-sm font-semibold text-gray-900">
            {job.topic}
          </h3>
          <StatusBadge status={job.status} className="shrink-0" />
        </div>

        <div className="space-y-1.5">
          <p className="text-xs text-gray-500">
            <span className="font-medium text-gray-700">Category:</span>{' '}
            {job.category}
          </p>
          <p className="text-xs text-gray-500">
            <span className="font-medium text-gray-700">Audience:</span>{' '}
            {job.target_audience}
          </p>
          <p className="text-xs text-gray-500">
            <span className="font-medium text-gray-700">Language:</span>{' '}
            {job.language}
          </p>
        </div>

        <div className="mt-3 flex flex-wrap gap-1.5">
          {job.content_types.map((type) => (
            <span
              key={type}
              className="rounded-full bg-gray-100 px-2 py-0.5 text-xs capitalize text-gray-600"
            >
              {type.replace('_', ' ')}
            </span>
          ))}
        </div>

        <p className="mt-3 text-xs text-gray-400">
          {formatDistanceToNow(job.created_at)}
        </p>
      </CardContent>
    </Card>
  )
}
