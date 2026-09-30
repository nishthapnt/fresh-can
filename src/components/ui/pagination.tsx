import { ChevronLeft, ChevronRight } from 'lucide-react'

import { cn } from '@/lib/utils'

const arrowCls =
  'flex h-8 w-8 items-center justify-center rounded-lg border border-border text-muted-foreground transition-colors hover:bg-surface hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent'

interface PaginationProps {
  page: number
  totalPages: number
  totalItems: number
  pageSize: number
  onPageChange: (page: number) => void
}

// 1 … 4 5 6 … 12 — first, last, and a window around the current page.
function pageList(page: number, total: number): (number | 'ellipsis-l' | 'ellipsis-r')[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1)
  const out: (number | 'ellipsis-l' | 'ellipsis-r')[] = [1]
  const start = Math.max(2, page - 1)
  const end   = Math.min(total - 1, page + 1)
  if (start > 2) out.push('ellipsis-l')
  for (let p = start; p <= end; p++) out.push(p)
  if (end < total - 1) out.push('ellipsis-r')
  out.push(total)
  return out
}

function Pagination({ page, totalPages, totalItems, pageSize, onPageChange }: PaginationProps) {
  if (totalPages <= 1) return null
  const from = (page - 1) * pageSize + 1
  const to   = Math.min(page * pageSize, totalItems)

  return (
    <div className="flex flex-col items-center justify-between gap-3 pt-2 sm:flex-row">
      <p className="text-sm text-muted-foreground" aria-live="polite">
        Showing {from}–{to} of {totalItems}
      </p>
      <nav aria-label="Pagination" className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => onPageChange(page - 1)}
          disabled={page === 1}
          aria-label="Previous page"
          className={cn(arrowCls)}
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
        {pageList(page, totalPages).map((p) =>
          typeof p === 'string' ? (
            <span key={p} className="flex h-8 w-8 items-center justify-center text-xs text-muted-foreground" aria-hidden="true">…</span>
          ) : (
            <button
              key={p}
              type="button"
              onClick={() => onPageChange(p)}
              aria-current={p === page ? 'page' : undefined}
              aria-label={`Page ${p}`}
              className={cn(
                'flex h-8 w-8 items-center justify-center rounded-lg text-xs font-bold transition-colors',
                p === page ? 'bg-primary text-white' : 'text-muted-foreground hover:bg-surface hover:text-foreground',
              )}
            >
              {p}
            </button>
          ),
        )}
        <button
          type="button"
          onClick={() => onPageChange(page + 1)}
          disabled={page === totalPages}
          aria-label="Next page"
          className={cn(arrowCls)}
        >
          <ChevronRight className="h-4 w-4" />
        </button>
      </nav>
    </div>
  )
}

export { Pagination }
