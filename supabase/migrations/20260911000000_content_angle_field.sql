begin;

-- User-selected creative angle/hook for a single image_post job — a fixed
-- dropdown (src/app/dashboard/new/page.tsx), never free text, so the
-- generated caption (and, for image_style: 'infographic', the on-image
-- headline/subtitle via generate_ad_copy) draw from one of a known set of
-- briefs (worker/src/prompts/brand/fresh-can.ts adAngleBriefs) instead of
-- two independent, unrelated guesses at the same topic. Null = "let AI
-- decide" (the default, same convention as content_jobs.province's 'auto').
alter table content_jobs
  add column if not exists content_angle text
    check (content_angle in (
      'community_story', 'behind_scenes', 'fresh_produce', 'stat_fact', 'call_to_action'
    ));

comment on column content_jobs.content_angle is
  'Optional user-selected creative angle/hook for this post (null = let AI decide). Read by the worker '
  'to keep the generated caption, and for image_style=''infographic'' jobs the shared on-image '
  'headline/subtitle (see generate_ad_copy step), thematically cohesive with each other.';

commit;
