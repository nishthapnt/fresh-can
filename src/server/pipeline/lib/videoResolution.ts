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
//
// Pinned to 720p (2026-09-23) to match KieVideoGenerator's `resolution:
// '720p'` — see that class's header in adapters/kie.ts for the credit-cost
// reasoning. Keeping these two in lockstep matters: SceneClipScaler always
// runs one ffmpeg scale pass per clip with no short-circuit for "already at
// target" (generateSceneVisual.ts's runSceneVideoClipStep), so if this
// target resolution and Seedance's generation resolution ever drift apart
// again, every clip gets upscaled/downscaled through upload-post.com's
// FFmpeg queue instead of getting a same-size no-op — that queue's
// wait-to-start was measured at ~15min for a 5-scene job on 2026-09-22,
// which is what forced the previous 720p attempt back to 1080p.
export const ASPECT_RATIO_RESOLUTIONS: Record<'9:16' | '1:1' | '16:9', { width: number; height: number }> = {
  '9:16': { width: 720, height: 1280 },
  '1:1': { width: 720, height: 720 },
  '16:9': { width: 1280, height: 720 },
}
