-- Claim ledger (09 §U6b, Session 15). Additive.
-- Apply in Supabase SQL editor after 0009b_exceptions.sql.

-- ============================================================
-- touches.claim_ledger: the writer's claims for this draft, as the claim guard
-- accepted them — [{span, kind, evidence_ids}], kind in
-- prospect_fact | inference | offer | question, evidence ids E1…En indexing
-- the lead's qualification.evidence (interim ids until U15).
--
-- Approval re-runs the guard on the exact text being approved and writes the
-- ledger it accepted here; the approval snapshot (and so approval_hash)
-- includes it, and preflight recomputes the hash from this column.
--
-- null = drafted before U6b (or a drill touch written by an operator script):
-- such a touch cannot be approved through Telegram.
-- ============================================================

alter table touches
  add column claim_ledger jsonb;

-- Verify:
--   select column_name, data_type from information_schema.columns
--   where table_name = 'touches' and column_name = 'claim_ledger';
--   → claim_ledger | jsonb
