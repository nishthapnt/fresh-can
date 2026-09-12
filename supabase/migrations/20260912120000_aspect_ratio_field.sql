-- User-selected per video job — one of a fixed set of aspect ratios passed
-- straight through to Flux Kontext's own aspectRatio param for character-ref
-- and scene-image generation (worker/src/adapters/kie.ts). Kling image-to-
-- video has no aspect-ratio param of its own; it inherits the shape of
-- whatever reference image it's animating, so getting the shared images
-- generated at the right ratio is sufficient to get matching video clips.
-- Default '9:16' — the native shape for TikTok/Reels/Shorts, this app's
-- primary distribution channels. Same additive/nullable-with-check
-- convention as image_style (20260910000000)/content_angle (20260911000000).
alter table content_jobs
  add column if not exists aspect_ratio text not null default '9:16'
  check (aspect_ratio in ('9:16', '1:1', '16:9'));
