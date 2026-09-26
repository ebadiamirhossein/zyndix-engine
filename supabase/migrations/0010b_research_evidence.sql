-- Research sources and typed evidence items (09 §UR, carrying U15's evidence
-- record forward for the Apify research sources).
-- Apply in Supabase SQL editor after 0010_meetings.sql.

-- ============================================================
-- research_runs: one row per actor run (or per reuse / cap skip), with its
-- estimated cost. Company-level sources are researched once per company and
-- reused across its contacts for research_policy.reuse_days; the reuse is
-- recorded as a 'reused' row so the per-lead cost stays auditable.
--
--   status       meaning
--   -----------  ---------------------------------------------------------
--   running      the Apify run started
--   succeeded    items parsed (item_count may still be 0 after filters)
--   empty        the actor returned nothing usable
--   failed       the run failed: missing information, NEVER evidence
--   skipped_cap  not run: it would exceed max_cost_usd_per_lead
--   reused       a fresh company-level run was reused (no Apify call)
-- ============================================================

create table research_runs (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references companies(id) on delete cascade,
  lead_id         uuid references leads(id) on delete set null,
  source_type     text not null
                  check (source_type in ('li_person_post', 'li_company_post', 'li_profile', 'job_post',
                                         'google_review', 'news', 'blog')),
  actor_id        text,
  apify_run_id    text,
  status          text not null default 'running'
                  check (status in ('running', 'succeeded', 'empty', 'failed', 'skipped_cap', 'reused')),
  reused_run_id   uuid references research_runs(id) on delete set null,
  item_count      int not null default 0 check (item_count >= 0),
  -- Estimated from the actor's pay-per-event price; null when unknown (never 0 for unknown).
  est_cost_usd    numeric(10, 5),
  max_charge_usd  numeric(10, 5),
  error           text,
  started_at      timestamptz default now(),
  finished_at     timestamptz,
  created_at      timestamptz default now(),
  updated_at      timestamptz default now()
);

create index research_runs_company_source_idx on research_runs (company_id, source_type, finished_at desc);
create index research_runs_lead_idx on research_runs (lead_id) where lead_id is not null;

create trigger trg_updated_at before update on research_runs for each row execute function set_updated_at();
alter table research_runs enable row level security;

-- ============================================================
-- evidence_items: one dated, source-linked item. `excerpt` is VERBATIM from
-- the source (a post's text, a review, a job description, a headline) —
-- never a paraphrase; the claim guard checks quotes and fact tokens against
-- it. fetched_at is per item (replaces U6b's one-date-per-lead proxy);
-- published_at is the source's own date, null when the source has none.
-- lead_id is null for company-level items (reused across contacts).
-- label: 'observed' for everything UR stores; U15 adds inferred /
-- prospect_confirmed / contradicted / unknown.
-- ============================================================

create table evidence_items (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null references companies(id) on delete cascade,
  lead_id          uuid references leads(id) on delete cascade,
  research_run_id  uuid references research_runs(id) on delete set null,
  source_type      text not null
                   check (source_type in ('li_person_post', 'li_company_post', 'li_profile', 'job_post',
                                          'google_review', 'news', 'blog')),
  source_url       text not null,
  title            text,
  excerpt          text not null check (length(excerpt) > 0),
  published_at     timestamptz,
  fetched_at       timestamptz not null,
  actor_id         text,
  content_hash     text not null,
  label            text not null default 'observed'
                   check (label in ('observed', 'inferred', 'prospect_confirmed', 'contradicted', 'unknown')),
  raw              jsonb,
  created_at       timestamptz default now(),
  updated_at       timestamptz default now()
);

-- The same item fetched twice is one row (the later fetch refreshes fetched_at).
create unique index evidence_items_dedupe_uniq on evidence_items (company_id, source_type, source_url, content_hash);
create index evidence_items_lead_idx on evidence_items (lead_id) where lead_id is not null;
create index evidence_items_company_fetched_idx on evidence_items (company_id, fetched_at desc);

create trigger trg_updated_at before update on evidence_items for each row execute function set_updated_at();
alter table evidence_items enable row level security;

-- No grant block: 0001's default privileges cover service_role (see 0005).

-- ============================================================
-- Verification (run in the SQL editor after applying; paste into 07).
-- ============================================================
-- select relname, relrowsecurity from pg_class
--  where relnamespace = 'public'::regnamespace and relname in ('research_runs', 'evidence_items')
--  order by relname;
-- -- expect: evidence_items | t ; research_runs | t
--
-- select conrelid::regclass as tbl, count(*) from pg_constraint
--  where conrelid in ('research_runs'::regclass, 'evidence_items'::regclass) and contype = 'c'
--  group by 1 order by 1;
-- -- expect: research_runs 3 (source_type, status, item_count); evidence_items 3 (source_type, excerpt, label)
--
-- select (select count(*) from research_runs) as runs, (select count(*) from evidence_items) as items;
-- -- expect 0, 0
