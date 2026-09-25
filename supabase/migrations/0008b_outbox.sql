-- Send outbox (09 §U5, brief §10 "outbox/reconciliation process")
-- Apply in Supabase SQL editor after 0008_touch_approval_binding.sql.

-- ============================================================
-- One outbox row per provider dispatch. The send stage writes the row in
-- state `dispatching` BEFORE it calls Instantly, keyed by the same stable
-- idempotency key as the job and the capacity reservation. Whatever happens
-- to the worker afterwards, the row records that a dispatch may have left.
--
--   state                from                  meaning / ledger (0007)
--   -------------------  --------------------  ------------------------------------------
--   dispatching          (new)                 written before the provider call
--   accepted             dispatching           provider accepted; ledger accept
--   retry_wait           dispatching           429 / connect-phase failure: nothing reached
--                                              the provider; the reservation stays held and
--                                              is replayed by key; the job retries
--   dispatching          retry_wait            the retry dispatches again
--   failed               dispatching           provider definitively rejected; ledger fail;
--                                              lead queued -> manual_hold
--   uncertain            dispatching           timeout / 5xx / unreadable after dispatch, OR a
--                                              re-claimed job found the row still
--                                              `dispatching` (worker crashed mid-flight).
--                                              Ledger uncertain: capacity STAYS HELD.
--                                              NEVER resent. A send.reconcile job resolves it
--   reconciled_sent      uncertain             provider shows the lead/email; ledger
--                                              reconcile_sent; lead -> sent
--   reconciled_not_sent  uncertain             provider proves absence; ledger
--                                              reconcile_not_sent; lead queued -> manual_hold
--                                              for the operator. No automatic resend
--
-- operation: `enroll` (step 1, POST /api/v2/leads/add into the bound account's
-- campaign) or `reply` (step >= 2, POST /api/v2/emails/reply into step 1's thread).
-- provider_email_id / provider_thread_id: Instantly email ids. For `enroll` they
-- are unknown at acceptance (Instantly sends later) and are filled by the
-- email_sent webhook (U6) or a listEmails lookup.
-- ============================================================

create table outbox (
  id                   uuid primary key default gen_random_uuid(),
  touch_id             uuid not null references touches(id) on delete cascade,
  lead_id              uuid not null references leads(id) on delete cascade,
  send_account_id      uuid not null references send_accounts(id),
  channel              text not null default 'email',
  operation            text not null check (operation in ('enroll', 'reply')),
  idempotency_key      text not null,
  approval_hash        text not null,
  reservation_id       uuid references capacity_reservations(id),
  state                text not null default 'dispatching'
                       check (state in ('dispatching', 'accepted', 'retry_wait', 'uncertain', 'failed',
                                        'reconciled_sent', 'reconciled_not_sent')),
  provider_campaign_id text,
  provider_lead_id     text,
  provider_email_id    text,
  provider_thread_id   text,
  reply_to_email_id    text,
  uncertain_reason     text,
  fingerprint          jsonb,
  last_error           text,
  dispatch_count       int not null default 0 check (dispatch_count >= 0),
  dispatched_at        timestamptz,
  settled_at           timestamptz,
  created_at           timestamptz default now(),
  updated_at           timestamptz default now()
);

create unique index outbox_idempotency_key_uniq on outbox (idempotency_key);
create index outbox_touch_idx on outbox (touch_id);
create index outbox_lead_idx on outbox (lead_id);
create index outbox_open_idx on outbox (state) where state in ('dispatching', 'retry_wait', 'uncertain');

create trigger trg_updated_at before update on outbox for each row execute function set_updated_at();
alter table outbox enable row level security;

-- No grant block: 0001's default privileges cover service_role (see 0005).

-- ============================================================
-- Verification (run in the SQL editor after applying; paste into 07).
-- ============================================================
-- select relname, relrowsecurity
--   from pg_class
--  where relnamespace = 'public'::regnamespace and relname = 'outbox';
-- -- expect: outbox | t
--
-- select conname from pg_constraint where conrelid = 'outbox'::regclass and contype = 'c' order by conname;
-- -- expect: dispatch_count, operation and state checks
