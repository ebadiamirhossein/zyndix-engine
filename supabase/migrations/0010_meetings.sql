-- Meetings (09 §U8, brief §9 Calendly row, §11 meeting tracking).
-- Apply in Supabase SQL editor after 0009d_instantly_enrollments.sql.

-- ============================================================
-- One row per Calendly invitee. Calendly's invitee `uri` is the canonical id
-- ("Canonical reference (unique identifier) for the invitee", OpenAPI
-- InviteePayload), so it is the natural key: a redelivered invitee.created
-- is a no-op, and a reschedule links the new invitee to the old one through
-- `rescheduled_from` (the new invitee's `old_invitee`).
--
--   status       meaning
--   -----------  ---------------------------------------------------------
--   scheduled    booked and not canceled
--   canceled     canceled (not a reschedule). Outreach is NOT restarted.
--   rescheduled  this invitee was replaced by a new one (rescheduled=true)
--   held         operator-recorded: the meeting happened
--   no_show      invitee_no_show.created, or operator-recorded
--
-- Cancellation or rescheduling never restarts cold contact (brief §10).
-- lead_id is null only while unmatched (the exception queue holds the event).
-- ============================================================

create table meetings (
  id                   uuid primary key default gen_random_uuid(),
  provider             text not null default 'calendly',
  external_id          text not null,
  scheduled_event_uri  text,
  rescheduled_from     text,
  rescheduled_to       text,
  lead_id              uuid references leads(id) on delete set null,
  company_id           uuid references companies(id) on delete set null,
  invitee_email        text not null,
  invitee_name         text,
  event_name           text,
  status               text not null default 'scheduled'
                       check (status in ('scheduled', 'canceled', 'rescheduled', 'held', 'no_show')),
  start_at             timestamptz,
  end_at               timestamptz,
  canceled_at          timestamptz,
  canceled_by          text,
  canceler_type        text,
  cancel_reason        text,
  no_show_at           timestamptz,
  -- Operator-reported outcome (brief §11: provider facts vs operator values).
  outcome_recorded_by  text,
  outcome_recorded_at  timestamptz,
  webhook_event_id     uuid references webhook_events(id) on delete set null,
  raw                  jsonb,
  created_at           timestamptz default now(),
  updated_at           timestamptz default now()
);

create unique index meetings_provider_external_uniq on meetings (provider, external_id);
create index meetings_lead_idx on meetings (lead_id);
create index meetings_start_idx on meetings (start_at) where status = 'scheduled';
create index meetings_rescheduled_from_idx on meetings (rescheduled_from) where rescheduled_from is not null;

create trigger trg_updated_at before update on meetings for each row execute function set_updated_at();
alter table meetings enable row level security;

-- No grant block: 0001's default privileges cover service_role (see 0005).

-- ============================================================
-- Verification (run in the SQL editor after applying; paste into 07).
-- ============================================================
-- select relname, relrowsecurity from pg_class
--  where relnamespace = 'public'::regnamespace and relname = 'meetings';
-- -- expect: meetings | t
--
-- select indexname from pg_indexes where tablename = 'meetings' order by indexname;
-- -- expect 5: meetings_lead_idx, meetings_pkey, meetings_provider_external_uniq,
-- --           meetings_rescheduled_from_idx, meetings_start_idx
--
-- select count(*) from meetings;
-- -- expect 0
