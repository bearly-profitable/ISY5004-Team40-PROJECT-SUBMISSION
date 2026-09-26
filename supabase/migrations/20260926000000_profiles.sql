-- Lumina accounts: profiles, per-user session labels, and avatar storage.
-- Run once in the Supabase dashboard (SQL Editor → New query → Run), or with
-- `supabase db push` if you use the Supabase CLI. Safe to re-run.

-- ---------------------------------------------------------------------------
-- profiles: one row per user, everything they can customise
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  id             uuid primary key references auth.users (id) on delete cascade,
  display_name   text check (char_length(display_name) <= 40),
  tagline        text check (char_length(tagline) <= 80),

  -- The profile button: a Lumi pose on a coloured badge, or an uploaded photo.
  avatar_pose    text not null default 'wave',
  avatar_bg      text not null default 'lavender',
  avatar_url     text,

  -- Look and feel across the whole app.
  accent         text not null default 'lumi'
                 check (accent in ('lumi', 'rose', 'mint', 'honey', 'ocean')),
  lumi_outfit    text not null default 'classic'
                 check (lumi_outfit in ('classic', 'mint', 'honey', 'ocean')),

  -- Defaults the gallery starts from.
  collage_theme  text not null default 'lumi',
  enhance_style  text not null default 'natural'
                 check (enhance_style in ('natural', 'polished')),

  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

alter table public.profiles enable row level security;

drop policy if exists "profiles: read own" on public.profiles;
create policy "profiles: read own" on public.profiles
  for select using ((select auth.uid()) = id);

drop policy if exists "profiles: insert own" on public.profiles;
create policy "profiles: insert own" on public.profiles
  for insert with check ((select auth.uid()) = id);

drop policy if exists "profiles: update own" on public.profiles;
create policy "profiles: update own" on public.profiles
  for update using ((select auth.uid()) = id) with check ((select auth.uid()) = id);

-- A profile appears the moment someone signs up, named after their Google account.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name)
  values (
    new.id,
    left(coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name',
                  split_part(new.email, '@', 1)), 40)
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Users who signed in before this migration get a profile too.
insert into public.profiles (id, display_name)
select id, left(coalesce(raw_user_meta_data ->> 'full_name', raw_user_meta_data ->> 'name',
                         split_part(email, '@', 1)), 40)
from auth.users
on conflict (id) do nothing;

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists profiles_touch on public.profiles;
create trigger profiles_touch
  before update on public.profiles
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- session_labels: a user's own name + favourite star for an analysis session.
-- The sessions themselves (photos, results) live on the Lumina backend; this
-- is only the personal layer on top, keyed by the backend's job id.
-- ---------------------------------------------------------------------------
create table if not exists public.session_labels (
  user_id     uuid not null references auth.users (id) on delete cascade,
  job_id      text not null,
  title       text check (char_length(title) <= 60),
  favourite   boolean not null default false,
  updated_at  timestamptz not null default now(),
  primary key (user_id, job_id)
);

alter table public.session_labels enable row level security;

drop policy if exists "session_labels: own rows" on public.session_labels;
create policy "session_labels: own rows" on public.session_labels
  for all using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

drop trigger if exists session_labels_touch on public.session_labels;
create trigger session_labels_touch
  before update on public.session_labels
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- avatars bucket: public images, each user writes only inside <their uid>/
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatars', 'avatars', true, 2097152, array['image/png', 'image/jpeg', 'image/webp'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Viewing works through the public URL; this lets users list/replace their own.
drop policy if exists "avatars: read own" on storage.objects;
create policy "avatars: read own" on storage.objects
  for select to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists "avatars: upload own" on storage.objects;
create policy "avatars: upload own" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists "avatars: update own" on storage.objects;
create policy "avatars: update own" on storage.objects
  for update to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists "avatars: delete own" on storage.objects;
create policy "avatars: delete own" on storage.objects
  for delete to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text);
