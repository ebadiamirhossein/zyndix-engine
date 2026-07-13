-- Zyndix Outbound Engine — full v1 schema (doc 02)
-- Apply in Supabase SQL editor. Idempotent-ish: safe to re-run on a fresh DB.

create extension if not exists pgcrypto;

-- ---------- updated_at trigger function ----------
create or replace function set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ============================================================
-- CORE
-- ============================================================

create table companies (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  domain text unique,
  segment text,
  country text,
  city text,
  timezone text,
  employee_range text,
  industry text,
  linkedin_url text,
  apollo_org_id text,
  attio_company_id text,
  status text default 'new',
  park_reason text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table sequences (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  segment text,
  channel text,
  active bool default true,
  version int default 1,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table sequence_steps (
  id uuid primary key default gen_random_uuid(),
  sequence_id uuid not null references sequences(id) on delete cascade,
  step_no int not null,
  wait_days int default 0,
  channel text,
  template_hint text,
  requires_approval bool default false,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (sequence_id, step_no)
);

create table send_accounts (
  id uuid primary key default gen_random_uuid(),
  kind text,
  identifier text,
  domain text,
  provider text,
  daily_quota int default 0,
  ramp_stage text default 'warmup',
  health text default 'ok',
  paused_reason text,
  bounce_rate_7d numeric,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table leads (
  id uuid primary key default gen_random_uuid(),
  company_id uuid references companies(id) on delete cascade,
  first_name text,
  last_name text,
  title text,
  email text,
  email_status text default 'unverified',
  email_verified_at timestamptz,
  linkedin_url text,
  apollo_person_id text,
  attio_person_id text,
  timezone text,
  state text not null default 'sourced',
  state_changed_at timestamptz default now(),
  current_sequence_id uuid references sequences(id),
  current_step int,
  next_action_at timestamptz,
  owner text default 'engine',
  do_not_contact bool default false,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index leads_state_next_action_at_idx on leads (state, next_action_at);
create index leads_company_id_idx on leads (company_id);

create table qualification (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references leads(id) on delete cascade,
  fit_score int,
  segment text,
  problem_hypothesis text not null,
  evidence jsonb,
  triggers jsonb,
  visible_tools jsonb,
  recommended_angle text,
  disqualify_reason text,
  prompt_version int,
  model text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create unique index qualification_lead_uidx on qualification (lead_id);

create table qualification_history (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references leads(id) on delete cascade,
  fit_score int,
  segment text,
  problem_hypothesis text not null,
  evidence jsonb,
  triggers jsonb,
  visible_tools jsonb,
  recommended_angle text,
  disqualify_reason text,
  prompt_version int,
  model text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index qualification_history_lead_idx on qualification_history (lead_id);

create table enrichment_payloads (
  id uuid primary key default gen_random_uuid(),
  company_id uuid references companies(id) on delete cascade,
  lead_id uuid references leads(id) on delete cascade,
  source text,
  payload jsonb,
  fetched_at timestamptz default now(),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index enrichment_company_idx on enrichment_payloads (company_id);
create index enrichment_lead_idx on enrichment_payloads (lead_id);

-- ============================================================
-- OUTREACH
-- ============================================================

create table touches (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid references leads(id) on delete cascade,
  sequence_id uuid references sequences(id),
  step_no int,
  channel text,
  direction text,
  status text,
  subject text,
  body text,
  draft_body text,
  send_account_id uuid references send_accounts(id),
  provider_message_id text,
  scheduled_for timestamptz,
  sent_at timestamptz,
  opened_at timestamptz,
  replied_at timestamptz,
  reply_classification text,
  reply_body text,
  prompt_version int,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index touches_lead_idx on touches (lead_id);
create index touches_status_idx on touches (status);

create table capacity_ledger (
  id uuid primary key default gen_random_uuid(),
  send_account_id uuid references send_accounts(id) on delete cascade,
  date date not null,
  quota int default 0,
  used int default 0,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (send_account_id, date)
);

create table suppression_list (
  id uuid primary key default gen_random_uuid(),
  email text,
  domain text,
  linkedin_url text,
  reason text,
  source_touch_id uuid references touches(id),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index suppression_email_idx on suppression_list (email);
create index suppression_domain_idx on suppression_list (domain);

-- ============================================================
-- SYSTEM
-- ============================================================

create table settings (
  id uuid primary key default gen_random_uuid(),
  key text not null,
  version int not null default 1,
  value jsonb,
  active bool default false,
  changed_by text,
  change_note text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create unique index settings_key_active_uidx on settings (key) where active;

create table webhook_events (
  id uuid primary key default gen_random_uuid(),
  provider text,
  external_id text,
  event_type text,
  payload jsonb,
  processed bool default false,
  processed_at timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create unique index webhook_events_provider_external_uidx on webhook_events (provider, external_id);

create table lead_events (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid references leads(id) on delete cascade,
  event text,
  detail jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index lead_events_lead_idx on lead_events (lead_id);

create table weekly_digests (
  id uuid primary key default gen_random_uuid(),
  week_start date,
  stats jsonb,
  narrative text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table ads_attribution (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid references leads(id) on delete cascade,
  gclid text,
  fbclid text,
  li_fat_id text,
  utm jsonb,
  conversion_uploads jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- ============================================================
-- updated_at triggers (every table)
-- ============================================================
create trigger trg_updated_at before update on companies             for each row execute function set_updated_at();
create trigger trg_updated_at before update on sequences             for each row execute function set_updated_at();
create trigger trg_updated_at before update on sequence_steps        for each row execute function set_updated_at();
create trigger trg_updated_at before update on send_accounts         for each row execute function set_updated_at();
create trigger trg_updated_at before update on leads                 for each row execute function set_updated_at();
create trigger trg_updated_at before update on qualification         for each row execute function set_updated_at();
create trigger trg_updated_at before update on qualification_history for each row execute function set_updated_at();
create trigger trg_updated_at before update on enrichment_payloads   for each row execute function set_updated_at();
create trigger trg_updated_at before update on touches               for each row execute function set_updated_at();
create trigger trg_updated_at before update on capacity_ledger       for each row execute function set_updated_at();
create trigger trg_updated_at before update on suppression_list      for each row execute function set_updated_at();
create trigger trg_updated_at before update on settings              for each row execute function set_updated_at();
create trigger trg_updated_at before update on webhook_events        for each row execute function set_updated_at();
create trigger trg_updated_at before update on lead_events           for each row execute function set_updated_at();
create trigger trg_updated_at before update on weekly_digests        for each row execute function set_updated_at();
create trigger trg_updated_at before update on ads_attribution       for each row execute function set_updated_at();

-- ============================================================
-- RLS: enable on every table (anon/authenticated get nothing;
-- engine uses service_role, which bypasses RLS)
-- ============================================================
alter table companies             enable row level security;
alter table sequences             enable row level security;
alter table sequence_steps        enable row level security;
alter table send_accounts         enable row level security;
alter table leads                 enable row level security;
alter table qualification         enable row level security;
alter table qualification_history enable row level security;
alter table enrichment_payloads   enable row level security;
alter table touches               enable row level security;
alter table capacity_ledger       enable row level security;
alter table suppression_list      enable row level security;
alter table settings              enable row level security;
alter table webhook_events        enable row level security;
alter table lead_events           enable row level security;
alter table weekly_digests        enable row level security;
alter table ads_attribution       enable row level security;

-- ============================================================
-- Grants: engine identity only. anon/authenticated deliberately ungranted.
-- Covers current tables + all future ones (default privileges).
-- ============================================================
grant usage on schema public to service_role;
grant all on all tables    in schema public to service_role;
grant all on all sequences in schema public to service_role;
alter default privileges in schema public grant all on tables    to service_role;
alter default privileges in schema public grant all on sequences to service_role;

-- ============================================================
-- Retire the step-1 throwaway table
-- ============================================================
drop table if exists _ping;
