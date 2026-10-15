-- ============================================================
-- Open World — Supabase cloud saving setup
-- Run this once: Supabase Dashboard → SQL Editor → New query
-- → paste this whole file → Run.
-- ============================================================

create table if not exists openworld_data (
  key        text primary key,
  data       jsonb not null,
  updated_at timestamptz not null default now()
);

-- The game is a public, account-per-browser site: anyone (anonymous)
-- may read and write game data. Passwords are hashed client-side.
alter table openworld_data enable row level security;

drop policy if exists "openworld_public_read"   on openworld_data;
drop policy if exists "openworld_public_write"  on openworld_data;
drop policy if exists "openworld_public_update" on openworld_data;
drop policy if exists "openworld_public_delete" on openworld_data;

create policy "openworld_public_read"
  on openworld_data for select
  using (true);

create policy "openworld_public_write"
  on openworld_data for insert
  with check (true);

create policy "openworld_public_update"
  on openworld_data for update
  using (true)
  with check (true);

-- Without a delete policy, RLS silently blocks all deletes (PostgREST
-- still returns success), so deleted accounts would resurrect on other
-- devices via the boot merge.
create policy "openworld_public_delete"
  on openworld_data for delete
  using (true);
