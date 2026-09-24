-- Capacity counters and reservations (09 §U3, brief §10)
-- Apply in Supabase SQL editor, then 0007b_reserve_capacity.sql.

-- ============================================================
-- Brief §10: "Quota accounting includes reserved, accepted, failed and
-- reconciled attempts with documented recovery semantics." This is that
-- documentation. One capacity_ledger row per (send account, UTC date).
--
-- Every reservation is a row in capacity_reservations, and every counter
-- change happens as part of a state transition on that row, inside
-- reserve_capacity() / settle_capacity() (0007b). A transition applies at
-- most once, so a job that is re-claimed and re-run cannot double-count.
--
--   operation          from state   ledger counters
--   -----------------  -----------  -----------------------------------------------
--   reserve            (new)        reserved += n   only if used + reserved + n <= quota
--   release            reserved     reserved -= n   refused before the provider call
--   accept             reserved     reserved -= n; used += n; accepted += n
--   fail               reserved     reserved -= n; failed += n   provider definitively
--                                   rejected; nothing went out, so capacity is freed
--   uncertain          reserved     no change — the capacity STAYS HELD. A timeout
--                                   after possible acceptance may have sent the
--                                   message; it is never resent (U5), and it keeps
--                                   consuming quota until reconciliation says otherwise
--   reconcile_sent     uncertain    reserved -= n; used += n; reconciled += n
--   reconcile_not_sent uncertain    reserved -= n; reconciled += n
--
-- `used` therefore counts messages that went out (accepted + reconciled as
-- sent). `quota` for a day is set by the first reservation from the ramp curve
-- and can only go DOWN within that day (see 0007b).
--
-- An uncertain reservation stays on the ledger date it was reserved on, even
-- if it is reconciled days later.
--
-- send_accounts.ramp_started_on: the date the account began cold sending, the
-- anchor of the capacity_defaults ramp (15 → 30/day, +5 every 4 days). Null
-- means not started — unknown is null, never zero. send_accounts.daily_quota
-- (0001, default 0) is not used by the scheduler.
--
-- No grant block: 0001's default privileges cover service_role (see 0005).
-- ============================================================

alter table capacity_ledger
  add column reserved   int not null default 0 check (reserved   >= 0),
  add column accepted   int not null default 0 check (accepted   >= 0),
  add column failed     int not null default 0 check (failed     >= 0),
  add column reconciled int not null default 0 check (reconciled >= 0);

alter table send_accounts
  add column ramp_started_on date;

create table capacity_reservations (
  id                 uuid primary key default gen_random_uuid(),
  ledger_id          uuid not null references capacity_ledger(id) on delete cascade,
  send_account_id    uuid not null references send_accounts(id) on delete cascade,
  date               date not null,
  n                  int  not null check (n > 0),
  state              text not null default 'reserved'
                     check (state in ('reserved', 'accepted', 'failed', 'released', 'uncertain', 'reconciled')),
  reconciled_outcome text check (reconciled_outcome in ('sent', 'not_sent')),
  idempotency_key    text,
  settled_at         timestamptz,
  created_at         timestamptz default now(),
  updated_at         timestamptz default now(),
  check ((state = 'reconciled') = (reconciled_outcome is not null))
);

-- One reservation per idempotency key, forever: a re-run send job that
-- reserves again gets its first reservation back instead of a second one.
create unique index capacity_reservations_idempotency_key_uniq
  on capacity_reservations (idempotency_key) where idempotency_key is not null;
create index capacity_reservations_ledger_idx on capacity_reservations (ledger_id);
create index capacity_reservations_open_idx
  on capacity_reservations (send_account_id, date) where state in ('reserved', 'uncertain');

create trigger trg_updated_at before update on capacity_reservations for each row execute function set_updated_at();
alter table capacity_reservations enable row level security;

-- ============================================================
-- Verification (run in the SQL editor after applying 0007 and 0007b;
-- paste the result into 07-build-log.md).
-- ============================================================
-- select relname, relrowsecurity
--   from pg_class
--  where relnamespace = 'public'::regnamespace
--    and relname in ('capacity_ledger', 'capacity_reservations');
-- -- expect: both t
--
-- select routine_name, grantee, privilege_type
--   from information_schema.routine_privileges
--  where routine_schema = 'public' and routine_name in ('reserve_capacity', 'settle_capacity')
--  order by routine_name, grantee;
-- -- expect service_role EXECUTE (plus the owner, postgres); no anon, authenticated or PUBLIC
