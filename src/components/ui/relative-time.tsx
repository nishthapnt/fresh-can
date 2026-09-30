'use client'

import { formatDateTime, formatDistanceToNow } from '@/lib/dateUtils'

// "2h ago" with the full date/time on hover/focus. suppressHydrationWarning:
// the relative string depends on "now", so server and client may differ.
export function RelativeTime({ value, className }: { value: string; className?: string }) {
  return (
    <time dateTime={value} title={formatDateTime(value)} className={className} suppressHydrationWarning>
      {formatDistanceToNow(value)}
    </time>
  )
}
