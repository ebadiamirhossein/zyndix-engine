-- Durable job queue (09 §U2, brief §13 and the lease half of §10)
-- Apply in Supabase SQL editor, then 0006b_claim_jobs_rpc.sql.

-- ============================================================
-- jobs: every long-running unit of work (sends, reconciles, imports,
-- extraction, syncs) is a row here, claimed under a lease by a worker.
-- A browser session or an in-memory timer is not the job system.
--
-- Lifecycle:
--   queued  → leased            claim_jobs() (0006b); attempts += 1 at claim
--   leased  → done              handler succeeded
--   leased  → queued            handler threw, attempts < max_attempts; run_after = backoff
--   leased  → dead              attempts exhausted, or a permanent error
--   leased  → (re-claimed)      lease_expires_at passed — the worker crashed
--   queued  → cancelled         e.g. a reply freezes a lead's queued sends (U6)
-- `failed` is reserved for a terminal non-retry outcome that is not a
-- dead letter; nothing in U2 writes it.
--
-- No grant block: 0001's default privileges cover service_role (see 0005).
-- ============================================================
create table jobs (
  id               uuid primary key default gen_random_uuid(),
  type             text not null,
  payload          jsonb not null default '{}'::jsonb,
  state            text not null default 'queued'
                   check (state in ('queued', 'leased', 'done', 'failed', 'dead', 'cancelled')),
  run_after        timestamptz not null default now(),
  lease_owner      text,
  lease_expires_at timestamptz,
  attempts         int not null default 0 check (attempts >= 0),
  max_attempts     int not null default 5 check (max_attempts > 0),
  last_error       text,
  idempotency_key  text,
  finished_at      timestamptz,
  created_at       timestamptz default now(),
  updated_at       timestamptz default now()
);

-- Like app_users.role, `state` carries a check constraint: a lease state is an
-- integrity boundary, and an unrecognised value would be invisible to every
-- claimer — a job silently lost.

-- One job per idempotency key, forever (across all states). Enqueueing the
-- same logical work twice returns the first row instead of creating a second.
create unique index jobs_idempotency_key_uniq on jobs (idempotency_key) where idempotency_key is not null;

-- claim_jobs() scans exactly these two predicates.
create index jobs_queued_idx on jobs (type, run_after) where state = 'queued';
create index jobs_leased_idx on jobs (lease_expires_at)  where state = 'leased';

create trigger trg_updated_at before update on jobs for each row execute function set_updated_at();
alter table jobs enable row level security;

-- ============================================================
-- Verification (run in the SQL editor after applying 0006 and 0006b;
-- paste the result into 07-build-log.md).
-- ============================================================
-- select relname, relrowsecurity
--   from pg_class
--  where relnamespace = 'public'::regnamespace and relname = 'jobs';
-- -- expect: jobs | t
--
-- select grantee, privilege_type
--   from information_schema.routine_privileges
--  where routine_schema = 'public' and routine_name = 'claim_jobs'
--  order by grantee;
-- -- expect service_role EXECUTE (plus the owner, postgres); no anon, authenticated or PUBLIC
