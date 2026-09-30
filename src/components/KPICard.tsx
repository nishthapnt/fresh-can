import { Card, CardContent } from '@/components/ui/card'
import { LucideIcon, TrendingUp, TrendingDown, Minus } from 'lucide-react'
import { cn } from '@/lib/utils'

interface KPICardProps {
  title: string
  value: number
  icon: LucideIcon
  /** e.g. +12 means +12% vs last period, -5 means -5%, 0 means no change */
  trendPercent?: number
  /** Label shown below the trend, e.g. "vs last week" */
  trendLabel?: string
  iconColor?: string
  iconBg?: string
}

export default function KPICard({
  title,
  value,
  icon: Icon,
  trendPercent,
  trendLabel = 'vs last week',
  iconColor = 'text-gray-600',
  iconBg = 'bg-gray-100',
}: KPICardProps) {
  const hasTrend = trendPercent !== undefined
  const isPositive = (trendPercent ?? 0) > 0
  const isNegative = (trendPercent ?? 0) < 0
  const isNeutral = (trendPercent ?? 0) === 0

  const trendColor = isPositive
    ? 'text-green-600'
    : isNegative
      ? 'text-red-500'
      : 'text-gray-400'

  const TrendIcon = isPositive ? TrendingUp : isNegative ? TrendingDown : Minus

  return (
    <Card className="gap-0 py-0 border bg-white transition-colors hover:border-primary/40">
      <CardContent className="p-4 sm:p-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
          <div className="order-2 min-w-0 flex-1 sm:order-1">
            <p className="text-sm font-medium leading-tight text-gray-500 sm:truncate">{title}</p>
            <p className="mt-1 text-2xl font-bold sm:text-3xl tracking-tight text-gray-900">
              {value.toLocaleString()}
            </p>
            {hasTrend && (
              <div className="mt-2 flex items-center gap-1">
                <TrendIcon className={cn('h-3.5 w-3.5 flex-shrink-0', trendColor)} />
                <span className={cn('text-xs font-semibold', trendColor)}>
                  {isPositive ? '+' : ''}
                  {trendPercent}%
                </span>
                <span className="text-xs text-gray-400">{trendLabel}</span>
              </div>
            )}
            {!hasTrend && (
              <p className="mt-2 flex items-center gap-1 text-[11px] leading-tight text-gray-400 sm:text-xs">
                <Minus className="h-3 w-3" />
                No comparison data
              </p>
            )}
          </div>
          <div className={cn('order-1 w-fit flex-shrink-0 rounded-lg p-2 sm:order-2 sm:p-2.5', iconBg)}>
            <Icon className={cn('h-5 w-5', iconColor)} />
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
