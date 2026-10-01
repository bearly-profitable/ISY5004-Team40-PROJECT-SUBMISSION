-- Answers from the separate photo-study site. The Vercel functions write
-- with the service role key, which bypasses these policies. The anon key
-- used by the Lumina app cannot read or insert these rows.
-- Safe to re-run.

create table if not exists public.study_responses (
  id           bigint generated always as identity primary key,
  session_id   text not null,
  tester       text not null,
  phase        text not null,
  event_id     text not null,
  photo_id     text not null,
  answered_at  timestamptz not null default now()
);

alter table public.study_responses enable row level security;
