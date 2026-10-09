/** Strip leading '#'s and whitespace, drop empties, de-dupe case-insensitively. */
export function normalizeHashtags(tags: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of tags) {
    const tag = String(raw).replace(/^[#\s]+/, '').replace(/\s+/g, '')
    const key = tag.toLowerCase()
    if (!tag || seen.has(key)) continue
    seen.add(key)
    out.push(tag)
  }
  return out
}

/** Remove a trailing run of '#word' tokens the model sometimes appends to a caption. */
export function stripTrailingHashtags(caption: string): string {
  return caption.replace(/(?:[\s]+#[\p{L}\p{N}_]+)+\s*$/u, '').trimEnd()
}

/** Tags not already present as '#tag' in the caption, with '#' prefixed. */
export function hashtagsToAppend(caption: string, tags: readonly string[]): string[] {
  const present = new Set(
    (caption.match(/#[\p{L}\p{N}_]+/gu) ?? []).map((t) => t.slice(1).toLowerCase()),
  )
  return normalizeHashtags(tags)
    .filter((t) => !present.has(t.toLowerCase()))
    .map((t) => `#${t}`)
}
