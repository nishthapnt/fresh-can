import { cn } from '@/lib/utils'

type ChipTone = 'neutral' | 'primary' | 'info'

const TONES: Record<ChipTone, string> = {
  neutral: 'border-border bg-surface text-muted-foreground',
  primary: 'border-primary/20 bg-primary-subtle text-primary',
  info:    'border-blue-200 bg-blue-50 text-blue-700',
}

// One shape for category / language / count chips. Status badges keep their
// own semantic colors (StatusBadge) and must not use this.
export function Chip({
  tone = 'neutral',
  className,
  children,
}: {
  tone?: ChipTone
  className?: string
  children: React.ReactNode
}) {
  return (
    <span className={cn('inline-flex h-5 items-center rounded-md border px-1.5 text-[11px] font-medium leading-none whitespace-nowrap', TONES[tone], className)}>
      {children}
    </span>
  )
}
