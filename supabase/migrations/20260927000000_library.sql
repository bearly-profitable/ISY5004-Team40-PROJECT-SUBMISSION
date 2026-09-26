-- Lumina library: every signed-in user's permanent photo collection.
-- Run once in the Supabase dashboard (SQL Editor → New query → Run), or with
-- `supabase db push`. Safe to re-run. Needs 20260926000000_profiles.sql first
-- (it defines public.touch_updated_at).
--
-- The gallery saves each analysed session's *best* photos here (duplicates and
-- rejects are left out), so the library reads like a curated Google Photos:
-- the same image analysed twice is stored once, keyed by its SHA-256.

-- ---------------------------------------------------------------------------
-- library_photos: one row per unique image per user
-- ---------------------------------------------------------------------------
create table if not exists public.library_photos (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null default auth.uid() references auth.users (id) on delete cascade,
  content_hash  text not null check (content_hash ~ '^[0-9a-f]{64}$'),

  -- Objects in the private `library` bucket, both under <user_id>/.
  storage_path  text not null,
  thumb_path    text not null,

  name          text check (char_length(name) <= 255),
  mime_type     text,
  bytes         bigint check (bytes >= 0),
  width         integer not null check (width > 0),
  height        integer not null check (height > 0),

  -- What the analysis knew about the photo when it was saved.
  taken_at      timestamptz,
  event_label   text check (char_length(event_label) <= 120),
  people        text[] not null default '{}',
  score         real,
  is_best       boolean not null default false,

  favourite     boolean not null default false,

  -- Every "<job_id>/<photo_id>" this image arrived from, so re-opening a
  -- session never re-uploads what is already here.
  source_keys   text[] not null default '{}',

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (user_id, content_hash)
);

create index if not exists library_photos_timeline
  on public.library_photos (user_id, (coalesce(taken_at, created_at)) desc);
create index if not exists library_photos_sources
  on public.library_photos using gin (source_keys);

alter table public.library_photos enable row level security;

drop policy if exists "library_photos: own rows" on public.library_photos;
create policy "library_photos: own rows" on public.library_photos
  for all using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

drop trigger if exists library_photos_touch on public.library_photos;
create trigger library_photos_touch
  before update on public.library_photos
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- library bucket: private originals + thumbnails, each user only in <uid>/
-- (images are read through short-lived signed URLs, never public links)
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('library', 'library', false, 26214400,
        array['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif', 'image/heic', 'image/heif'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "library: read own" on storage.objects;
create policy "library: read own" on storage.objects
  for select to authenticated
  using (bucket_id = 'library' and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists "library: upload own" on storage.objects;
create policy "library: upload own" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'library' and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists "library: update own" on storage.objects;
create policy "library: update own" on storage.objects
  for update to authenticated
  using (bucket_id = 'library' and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists "library: delete own" on storage.objects;
create policy "library: delete own" on storage.objects
  for delete to authenticated
  using (bucket_id = 'library' and (storage.foldername(name))[1] = (select auth.uid())::text);
