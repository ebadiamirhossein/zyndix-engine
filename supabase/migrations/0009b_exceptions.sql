-- Exception queue (09 §U6, brief §10 "unmatched contacts and failed stops go
-- to an exception queue with escalation").
-- Apply in Supabase SQL editor after 0009_send_prereqs.sql.

-- ============================================================
-- One row per thing the engine could not handle automatically and a human
-- must look at. Written by the Instantly webhook processor (U6) and, from
-- U6's reconcile job, by the stop-path health check.
--
--   kind                  written when
--   --------------------  ------------------------------------------------------
--   unmatched_recipient   a webhook names an email no lead has — ZERO lead
--                         mutations are made
--   foreign_campaign      a webhook comes from a campaign that is not one of
--                         our send_accounts.instantly_campaign_id
--   stop_failed           a stop could not be completed (e.g. the Instantly
--                         block-list write failed) — escalated immediately
--   invalid_payload       the body failed Zod validation after being stored
--   stop_processing_stale reconcile: sends with no webhook activity → paused
--
--   status: open → escalated (operator alerted) → resolved (by a human).
-- webhook_event_id links the raw event, which is always stored first.
-- ============================================================

create table exceptions (
  id               uuid primary key default gen_random_uuid(),
  kind             text not null,
  provider         text,
  webhook_event_id uuid references webhook_events(id) on delete set null,
  lead_id          uuid references leads(id) on delete set null,
  detail           jsonb,
  status           text not null default 'open' check (status in ('open', 'escalated', 'resolved')),
  escalated_at     timestamptz,
  resolved_at      timestamptz,
  resolved_by      text,
  created_at       timestamptz default now(),
  updated_at       timestamptz default now()
);

create index exceptions_open_idx on exceptions (status, created_at) where status <> 'resolved';
create index exceptions_webhook_event_idx on exceptions (webhook_event_id) where webhook_event_id is not null;

create trigger trg_updated_at before update on exceptions for each row execute function set_updated_at();
alter table exceptions enable row level security;

-- ============================================================
-- webhook_events.processing_error: why processing of a stored event failed.
-- The row is written BEFORE processing (persist-first); processed stays false
-- and this records the error, so a failed event is visible and replayable.
-- ============================================================

alter table webhook_events
  add column processing_error text;

-- No grant block: 0001's default privileges cover service_role (see 0005).

-- ============================================================
-- Verification (run in the SQL editor after applying; paste into 07).
-- ============================================================
-- select relname, relrowsecurity
--   from pg_class
--  where relnamespace = 'public'::regnamespace and relname = 'exceptions';
-- -- expect: exceptions | t
--
-- select column_name from information_schema.columns
--  where table_schema = 'public' and table_name = 'webhook_events' and column_name = 'processing_error';
-- -- expect 1 row
