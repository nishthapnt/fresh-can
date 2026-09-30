import { useCallback, useEffect, useMemo } from 'react'

export const PAGE_SIZE = 16

interface Options {
  page: number
  onPageChange: (page: number) => void
  // False while the list is still loading — an empty list mid-load must not
  // clamp a remembered page back to 1.
  ready: boolean
}

// Slices the FINAL list (after filter/sort/job grouping) into pages. The page
// number itself lives with the caller so it can outlive the section's own
// unmount (Base UI tab panels unmount when inactive).
export function usePagination<T>(items: T[], { page, onPageChange, ready }: Options) {
  const totalPages = Math.max(1, Math.ceil(items.length / PAGE_SIZE))
  const safePage   = Math.min(Math.max(1, page), totalPages)

  // Clamp after a delete / posted-exclusion shrinks the list.
  useEffect(() => {
    if (ready && page !== safePage) onPageChange(safePage)
  }, [ready, page, safePage, onPageChange])

  const pageItems = useMemo(
    () => items.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE),
    [items, safePage],
  )

  const goToPage = useCallback((p: number) => {
    onPageChange(Math.min(Math.max(1, p), totalPages))
  }, [onPageChange, totalPages])

  return { page: safePage, totalPages, pageItems, goToPage, offset: (safePage - 1) * PAGE_SIZE }
}
