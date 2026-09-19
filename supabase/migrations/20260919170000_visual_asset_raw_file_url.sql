-- Fixes a real, confirmed money-losing bug: generate_scene_visual's clip
-- step (src/server/pipeline/steps/video/generateSceneVisual.ts) treats a
-- FAILURE OF THE DOWNSCALE PASS (upload-post.com's FFmpeg Editor API,
-- SceneClipScaler.submitScale, run right after a successful, already-BILLED
-- KIE.ai video generation) as if the whole clip attempt failed — discarding
-- the KIE output and resubmitting a brand-new, separately-billed KIE video
-- generation on every retry, just to redo a cheap downscale step. Confirmed
-- live 2026-09-19: a real 6-scene job hit "downscale poll timed out" on
-- EVERY scene, on 3 consecutive attempts each (18 wasted KIE charges)
-- before being cancelled.
--
-- Additive only, same discipline as every prior migration in this
-- directory: no existing column/table/constraint touched. Nullable with no
-- default — every existing content_visual_assets row (Blog/Image's
-- hero_image/inline_image/photo, and every scene_image/character_ref row)
-- is completely unaffected and reads back NULL.
begin;

alter table content_visual_assets
  add column raw_file_url text;

comment on column content_visual_assets.raw_file_url is
  'scene_video_clip only: the KIE.ai clip URL captured the moment video generation succeeds, BEFORE the downscale pass runs. If downscale then fails, this is kept (not wiped) so the next attempt retries only the downscale step instead of resubmitting to KIE. Cleared (set NULL) once the asset reaches status=ready. Always NULL for every other asset_type.';

commit;
