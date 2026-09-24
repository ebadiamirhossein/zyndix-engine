-- Dashboard identity: auth uid -> role, plus the source_cursors baseline fix (09 §U1)
-- Apply in Supabase SQL editor.

-- ============================================================
-- app_users: maps a Supabase Auth user to a dashboard role.
-- Seeded on first magic-link login from DASHBOARD_ALLOWED_EMAILS;
-- this table is the authority afterwards, so a role change needs
-- no redeploy.
--
-- No grant block: 0001's `alter default privileges ... to service_role`
-- already covers tables created by later migrations. RLS is NOT covered
-- by default privileges, which is exactly how 0004 slipped — see below.
-- ============================================================
create table app_users (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null unique references auth.users(id) on delete cascade,
  email      text not null unique,
  role       text not null default 'viewer' check (role in ('admin', 'operator', 'viewer')),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index app_users_role_idx on app_users (role);

-- `role` is the only check constraint in the schema. The repo enforces
-- state legality in application code, but a role is a privilege boundary:
-- an unrecognised value must not be insertable in the first place.

create trigger trg_updated_at before update on app_users      for each row execute function set_updated_at();
alter table app_users      enable row level security;

-- ============================================================
-- Baseline fix: source_cursors (0004) is the only table in public
-- with no RLS and no updated_at trigger, unlike all 16 tables in 0001.
-- Not exploitable — anon/authenticated are ungranted — but it breaks
-- the pattern. Recorded as finding 6 in 07-build-log.md Session 3.
--
-- src/lib/stages/source/cursor.ts passes updated_at explicitly in its
-- upsert; on the UPDATE branch the trigger now sets the same value.
-- ============================================================
alter table source_cursors enable row level security;
create trigger trg_updated_at before update on source_cursors for each row execute function set_updated_at();

-- ============================================================
-- Verification (run in the SQL editor after applying; paste the
-- result into 07-build-log.md). Expect three rows, all t.
-- ============================================================
-- select relname, relrowsecurity
--   from pg_class
--  where relnamespace = 'public'::regnamespace
--    and relname in ('app_users', 'source_cursors', 'leads')
--  order by relname;
