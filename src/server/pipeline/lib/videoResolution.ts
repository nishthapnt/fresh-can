// Standard delivery resolution per aspect ratio — what TikTok/Reels/Shorts
// (and this app's own video playback modals — dashboard/page.tsx's and
// library/LibraryContent.tsx's "Watch" dialogs, which play at the clip's
// real aspect ratio; their grid-card thumbnails crop to a fixed square
// instead and don't factor into this) treat as the real display size
// regardless of how many more pixels a generated clip happens to natively
// carry. Pulled out of generateSceneVisual.ts (2026-09-19) so avMerger.ts's
// caption-burn pass can size/wrap text against the SAME real pixel
// dimensions every scene clip is downscaled to, instead of guessing at a
// frame width it has no way to know.
export const ASPECT_RATIO_RESOLUTIONS: Record<'9:16' | '1:1' | '16:9', { width: number; height: number }> = {
  '9:16': { width: 1080, height: 1920 },
  '1:1': { width: 1080, height: 1080 },
  '16:9': { width: 1920, height: 1080 },
}
