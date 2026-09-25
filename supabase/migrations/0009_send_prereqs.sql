-- Send prerequisites (09 §U6 Session 12, operator items before the webhook work)
-- Apply in Supabase SQL editor, then 0009b_exceptions.sql.

-- ============================================================
-- companies: HQ location, and where it came from.
--
-- US leads need a recipient timezone before any send (Session 11 rule:
-- `timezone_unknown` is a hold). The US has several zones, so the country is
-- not enough; the HQ state (and, for a state that spans two zones, the city)
-- is. hq_location_source names the provider/record (e.g. 'apollo_org_enrich',
-- 'operator'); hq_location_fetched_at is when it was read. Null = unknown.
-- ============================================================

alter table companies
  add column hq_state               text,
  add column hq_city                text,
  add column hq_location_source     text,
  add column hq_location_fetched_at timestamptz;

-- ============================================================
-- leads.timezone_source: how leads.timezone was derived.
--
--   hq_state       single-zone US state → IANA zone (static table)
--   hq_state_city  split US state resolved by an explicitly listed city
-- Null with a timezone set = set before this column existed, or by hand.
-- A missing state or an ambiguous split state leaves timezone null, and the
-- send stage keeps holding the lead as `timezone_unknown`.
-- ============================================================

alter table leads
  add column timezone_source     text,
  add column timezone_derived_at timestamptz;

-- ============================================================
-- send_accounts.signature_text: the plain-text signature appended to every
-- outbound email from this mailbox (step 1 and threaded follow-ups).
--
-- Instantly API sends carry no mailbox signature, so the engine appends it.
-- The text is part of the approval snapshot and hash (sending/approval.ts),
-- so changing it after approval makes preflight refuse `stale_approval`.
-- Null = no signature configured → preflight refuses `sender_signature_missing`.
-- ============================================================

alter table send_accounts
  add column signature_text text;

-- No grant block: 0001's default privileges cover service_role (see 0005).

-- ============================================================
-- Verification (run in the SQL editor after applying 0009 and 0009b;
-- paste the result into 07-build-log.md).
-- ============================================================
-- select table_name, column_name, data_type
--   from information_schema.columns
--  where table_schema = 'public'
--    and ((table_name = 'companies' and column_name in ('hq_state','hq_city','hq_location_source','hq_location_fetched_at'))
--      or (table_name = 'leads' and column_name in ('timezone_source','timezone_derived_at'))
--      or (table_name = 'send_accounts' and column_name = 'signature_text'))
--  order by table_name, column_name;
-- -- expect 7 rows
