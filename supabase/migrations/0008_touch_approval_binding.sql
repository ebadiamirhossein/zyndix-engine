-- Approval binding and sender pinning (09 §U5, brief §8 and §10)
-- Apply in Supabase SQL editor, then 0008b_outbox.sql.

-- ============================================================
-- touches: the approval is bound to the exact content and recipient.
--
-- At approval time (Telegram approve / edit) the engine stores
--   approval_snapshot = canonical {touch_id, lead_id, step_no, channel,
--                                  recipient, subject, body, prompt_version}
--   approval_hash     = sha256(canonical JSON of approval_snapshot)
-- Preflight recomputes the hash from the CURRENT touch and lead immediately
-- before every send and refuses with `stale_approval` on any difference —
-- brief §8: "materially changed content, recipient, offer, referenced facts or
-- channel requires renewed review".
--
-- idempotency_key: the send stage's stable key for this touch's dispatch
-- (send:<touch_id>:<approval_hash>). Unique, so one approved version of a
-- touch can be dispatched at most once.
-- ============================================================

alter table touches
  add column approval_hash     text,
  add column approval_snapshot jsonb,
  add column approved_at       timestamptz,
  add column approved_by       text,
  add column idempotency_key   text;

create unique index touches_idempotency_key_uniq
  on touches (idempotency_key) where idempotency_key is not null;

-- ============================================================
-- leads.send_account_id: the sender binding (operator requirement, 2026-09-25).
--
-- The same mailbox names (amir@, ingrida@) exist on both sending domains, so a
-- lead keeps ONE send_account for its whole sequence and never rotates
-- mid-sequence. Written once, at first send, with a conditional update
-- (`where send_account_id is null`) so two racing workers cannot bind two
-- different accounts; the loser reads the winner's binding. Preflight refuses
-- any touch whose sender differs with `sender_mismatch`. Null = not yet bound.
-- ============================================================

alter table leads
  add column send_account_id uuid references send_accounts(id);

create index leads_send_account_id_idx on leads (send_account_id) where send_account_id is not null;

-- ============================================================
-- send_accounts: one Instantly campaign per sending account.
--
-- Instantly has no per-lead sending-account field, so pinning is structural:
-- each send_account owns exactly one single-step Instantly campaign whose
-- email_list is that one mailbox. Step 1 is enrolled into it; steps >= 2 are
-- sent with POST /api/v2/emails/reply from the same mailbox into the same
-- thread. Null = campaign not created yet (scripts/instantly-sender-campaigns.ts).
--
-- identifier is unique case-insensitively: one row per mailbox.
-- ============================================================

alter table send_accounts
  add column instantly_campaign_id text;

create unique index send_accounts_instantly_campaign_id_uniq
  on send_accounts (instantly_campaign_id) where instantly_campaign_id is not null;
create unique index send_accounts_identifier_lower_uniq
  on send_accounts (lower(identifier)) where identifier is not null;

-- No grant block: 0001's default privileges cover service_role (see 0005).

-- ============================================================
-- Verification (run in the SQL editor after applying 0008 and 0008b;
-- paste the result into 07-build-log.md).
-- ============================================================
-- select table_name, column_name, data_type
--   from information_schema.columns
--  where table_schema = 'public'
--    and ((table_name = 'touches' and column_name in ('approval_hash','approval_snapshot','approved_at','approved_by','idempotency_key'))
--      or (table_name = 'leads' and column_name = 'send_account_id')
--      or (table_name = 'send_accounts' and column_name = 'instantly_campaign_id'))
--  order by table_name, column_name;
-- -- expect 7 rows
