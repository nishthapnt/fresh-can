import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import type { JobStatus, SocialStatus } from '@/types/content'

type BadgeStatus = JobStatus | SocialStatus

const statusConfig: Record<BadgeStatus, { label: string; className: string }> =
  {
    pending: {
      label: 'Pending',
      className: 'bg-gray-100 text-gray-700 border-gray-200',
    },
    draft_ready: {
      label: 'Draft Ready',
      className: 'bg-amber-100 text-amber-700 border-amber-200',
    },
    approved: {
      label: 'Approved',
      className: 'bg-blue-100 text-blue-700 border-blue-200',
    },
    generating: {
      label: 'Generating',
      className: 'bg-blue-100 text-blue-700 border-blue-200 animate-pulse',
    },
    ready: {
      label: 'Ready',
      className: 'bg-green-100 text-green-700 border-green-200',
    },
    failed: {
      label: 'Failed',
      className: 'bg-red-100 text-red-700 border-red-200',
    },
    pending_approval: {
      label: 'Pending Approval',
      className: 'bg-amber-100 text-amber-700 border-amber-200',
    },
    posting: {
      label: 'Posting',
      className: 'bg-blue-100 text-blue-700 border-blue-200 animate-pulse',
    },
    posted: {
      label: 'Posted',
      className: 'bg-purple-100 text-purple-700 border-purple-200',
    },
    partial: {
      label: 'Partial',
      className: 'bg-amber-100 text-amber-700 border-amber-200',
    },
  }

interface StatusBadgeProps {
  status: BadgeStatus
  className?: string
}

export default function StatusBadge({ status, className }: StatusBadgeProps) {
  const config = statusConfig[status] ?? statusConfig.pending

  return (
    <Badge
      variant="outline"
      className={cn(config.className, 'text-xs font-medium', className)}
    >
      {config.label}
    </Badge>
  )
}
