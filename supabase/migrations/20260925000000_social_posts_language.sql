-- Adds a language dimension to social_posts so a BOTH-language job's EN and
-- FR content can be approved/posted/retried independently, mirroring the
-- per-language split blog/image/video already have (content_language_tracks,
-- generated_content.language). Reuses the existing content_language enum
-- (EN|FR only, never BOTH) rather than introducing a new type.
alter table social_posts
  add column language content_language not null default 'EN';
-- Backfills existing rows to 'EN' — they all predate any per-language
-- distinction (a handful of real rows in production, all created before
-- generated_content even had a language column), so there's no reliable way
-- to recover which language they actually targeted.

-- Widen the per-post uniqueness from (job_id, content_type) to
-- (job_id, content_type, language). The existing constraint predates this
-- repo's supabase/migrations directory (no migration ever created it), so
-- its name isn't known — look it up by its actual column set instead of
-- guessing a name.
do $$
declare
  con_name text;
begin
  select conname into con_name
  from pg_constraint
  where conrelid = 'social_posts'::regclass
    and contype = 'u'
    and conkey = (
      select array_agg(attnum order by attnum)
      from pg_attribute
      where attrelid = 'social_posts'::regclass
        and attname in ('job_id', 'content_type')
    );
  if con_name is not null then
    execute format('alter table social_posts drop constraint %I', con_name);
  end if;
end $$;

alter table social_posts
  add constraint social_posts_job_id_content_type_language_key
  unique (job_id, content_type, language);
