-- Adds a per-job image style toggle: 'photo' (strictly no text baked into
-- the image — the existing Flux Kontext pipeline, unchanged) or
-- 'infographic' (headline/subtitle/logo/CTA text rendered onto the image
-- via a different, text-capable model — see worker/src/adapters/nanoBanana.ts).
-- User-selected at job creation (src/app/dashboard/new/page.tsx), not an
-- automatic per-category guess — a prior automatic-by-category version of
-- this was tried and removed (poor image quality when the wrong model
-- tried to render text). Additive only; existing rows default to 'photo',
-- which reproduces today's exact behavior.
begin;

alter table content_jobs
  add column if not exists image_style text not null default 'photo'
    check (image_style in ('photo', 'infographic'));

comment on column content_jobs.image_style is
  'User-selected: "photo" (strictly no on-image text) or "infographic" (headline/subtitle/logo/CTA text rendered onto the image via a text-capable model). Applies to whichever image(s) this job generates (blog hero/inline and/or image_post photo).';

commit;
