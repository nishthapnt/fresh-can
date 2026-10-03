-- Settings → API Keys: custom provider credentials + per-job credential pins.
--
-- api_credentials is APPEND-ONLY VERSIONED: replacing or resetting a key
-- never edits/deletes the row in place — it sets retired_at, so a job that
-- pinned that version keeps using the same account until it finishes. Retired
-- ciphertext is purged later by the app once no unfinished job references it
-- (src/server/pipeline/credentials.ts, purgeRetiredCredentials).
--
-- Plaintext keys are NEVER stored: encrypted_value is AES-256-GCM output
-- (src/server/pipeline/credentialCrypto.ts). RLS is enabled with NO policies
-- and anon/authenticated are revoked, so only the service role (server-side
-- code) can read or write this table.

create table api_credentials (
  id              uuid primary key default gen_random_uuid(),
  provider        text not null
                    check (provider in ('openai', 'kie', 'elevenlabs', 'assemblyai', 'upload_post')),
  encrypted_value text not null,
  last4           text not null,
  -- upload_post only: the upload-post.com profile that belongs to THIS key's
  -- account (the env UPLOAD_POST_PROFILE belongs to the default account).
  -- Not a secret.
  profile         text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  updated_by      text,
  retired_at      timestamptz
);

-- At most one ACTIVE custom credential per provider.
create unique index api_credentials_one_active_per_provider
  on api_credentials (provider)
  where retired_at is null;

alter table api_credentials enable row level security;
revoke all on api_credentials from anon, authenticated;

-- Atomically retire the current active credential (if any) and insert the new
-- one, so there is never a window where a job pinning credentials would see
-- "no custom key" and silently pin the default account.
create or replace function replace_active_api_credential(
  p_provider        text,
  p_encrypted_value text,
  p_last4           text,
  p_profile         text,
  p_updated_by      text
) returns uuid
language plpgsql
as $$
declare
  new_id uuid;
begin
  update api_credentials
     set retired_at = now(), updated_at = now()
   where provider = p_provider and retired_at is null;

  insert into api_credentials (provider, encrypted_value, last4, profile, updated_by)
  values (p_provider, p_encrypted_value, p_last4, p_profile, p_updated_by)
  returning id into new_id;

  return new_id;
end;
$$;

revoke all on function replace_active_api_credential(text, text, text, text, text)
  from public, anon, authenticated;

-- Per-job credential pins: { "<provider>": "<api_credentials.id>" | "default" }.
-- Holds version ids only — never key material. NULL = not pinned yet (jobs
-- that predate this feature, or haven't started generating); pinned lazily on
-- first credential use.
alter table content_jobs add column credential_pins jsonb;
