/**
 * Appends a cache-busting query param derived from the asset's own
 * updated_at. A regenerate/re-render that overwrites the SAME storage path
 * (video render retries, image regeneration) never changes the URL string
 * itself, so a <video>/<img> tag pointed at an unchanged src never re-fetches
 * on its own — not even after a hard page reload — since neither the browser
 * nor React has any signal the underlying bytes changed. Confirmed live
 * 2026-09-25: re-rendering a video's scene transitions kept showing the
 * pre-fix render in every dashboard view until this was added.
 */
export function withCacheBust(url: string, updatedAt: string | null | undefined): string {
  if (!updatedAt) return url
  const separator = url.includes('?') ? '&' : '?'
  return `${url}${separator}v=${encodeURIComponent(updatedAt)}`
}
