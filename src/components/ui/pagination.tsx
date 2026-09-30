import { ChevronLeft, ChevronRight } from 'lucide-react'

import { Button } from '@/components/ui/button'

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
      <p className="text-sm text-gray-500" aria-live="polite">
        Showing {from}–{to} of {totalItems}
      </p>
      <nav aria-label="Pagination" className="flex items-center gap-1">
        <Button
          variant="outline"
          size="sm"
          disabled={page === 1}
          onClick={() => onPageChange(page - 1)}
          aria-label="Previous page"
        >
          <ChevronLeft /> Prev
        </Button>
        {pageList(page, totalPages).map((p) =>
          typeof p === 'string' ? (
            <span key={p} className="px-1.5 text-sm text-gray-400" aria-hidden="true">…</span>
          ) : (
            <Button
              key={p}
              variant={p === page ? 'default' : 'outline'}
              size="sm"
              onClick={() => onPageChange(p)}
              aria-current={p === page ? 'page' : undefined}
              aria-label={`Page ${p}`}
            >
              {p}
            </Button>
          ),
        )}
        <Button
          variant="outline"
          size="sm"
          disabled={page === totalPages}
          onClick={() => onPageChange(page + 1)}
          aria-label="Next page"
        >
          Next <ChevronRight />
        </Button>
      </nav>
    </div>
  )
}

export { Pagination }
