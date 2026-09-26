-- Instantly-owned follow-up sequences (09 §U6c): enrollments, provider-sent
-- capacity, and the all-or-nothing sequence approval.
-- Apply in Supabase SQL editor after 0009c_claim_ledger.sql.

-- ============================================================
-- Follow-ups (step >= 2) are Instantly campaign sequence steps, not engine
-- sends (Session 16 decision, 06 §5). The engine enrolls step 1 once; this
-- table is its record of that enrollment and of how it was stopped.
--
--   state        meaning
--   -----------  ---------------------------------------------------------
--   active       enrolled; Instantly may still send unsent steps
--   stopping     stopSequence started (DELETE sent, not yet confirmed)
--   removed      DELETE confirmed (GET 404): no further step can go out
--   completed    Instantly finished every step with no stop
--   stop_failed  DELETE failed after one retry: escalated, campaign paused
--
-- sequence_hash is the approval hash every step's touch carries: the
-- enrollment is bound to exactly one approved sequence.
-- ============================================================

create table instantly_enrollments (
  id               uuid primary key default gen_random_uuid(),
  lead_id          uuid not null references leads(id) on delete cascade,
  send_account_id  uuid not null references send_accounts(id),
  campaign_id      text not null,
  provider_lead_id text,
  sequence_hash    text not null,
  steps_total      int  not null check (steps_total > 0),
  state            text not null default 'active'
                   check (state in ('active', 'stopping', 'removed', 'completed', 'stop_failed')),
  stop_reason      text,
  removed_at       timestamptz,
  last_checked_at  timestamptz,
  created_at       timestamptz default now(),
  updated_at       timestamptz default now()
);

-- At most one live enrollment per lead: a second enroll while one is active
-- or stopping is a bug, never a second sequence.
create unique index instantly_enrollments_live_lead_uniq
  on instantly_enrollments (lead_id) where state in ('active', 'stopping');
create index instantly_enrollments_state_idx on instantly_enrollments (state);

create trigger trg_updated_at before update on instantly_enrollments for each row execute function set_updated_at();
alter table instantly_enrollments enable row level security;

-- No grant block: 0001's default privileges cover service_role (see 0005).

-- ============================================================
-- record_provider_send(): count one Instantly-sent follow-up in the capacity
-- ledger exactly once (09 §U6c scope 5).
--
-- 0007b's header says reserve_capacity/settle_capacity are the only counter
-- writers; this is the third. A follow-up is sent by Instantly, not
-- dispatched by the engine, so there is nothing to reserve: the send has
-- already happened, and it is recorded as an accepted reservation with
--   idempotency key  provider_sent:<email_id>
-- and counter deltas  used += 1, accepted += 1  — only when that row is new.
-- A redelivered webhook returns 'already' and changes nothing. There is no
-- quota gate (the email is out); the day's used count simply includes it,
-- so step-1 reservations see less room.
--
-- The ledger day is created with p_quota under reserve_capacity's rules
-- (first write sets it, it never rises), so a follow-up recorded before the
-- day's first reservation cannot set the day's quota to 0.
-- ============================================================

create or replace function record_provider_send(
  p_send_account_id uuid,
  p_date            date,
  p_quota           int,
  p_email_id        text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_key    text;
  v_res    capacity_reservations%rowtype;
  v_ledger capacity_ledger%rowtype;
begin
  if p_send_account_id is null then
    raise exception 'record_provider_send: p_send_account_id is required';
  end if;
  if p_date is null then
    raise exception 'record_provider_send: p_date is required';
  end if;
  if p_quota is null or p_quota < 0 or p_quota > 10000 then
    raise exception 'record_provider_send: p_quota must be 0..10000, got %', p_quota;
  end if;
  if p_email_id is null or length(trim(p_email_id)) = 0 then
    raise exception 'record_provider_send: p_email_id is required';
  end if;
  v_key := 'provider_sent:' || trim(p_email_id);

  select * into v_res from capacity_reservations where idempotency_key = v_key;
  if found then
    select * into v_ledger from capacity_ledger where id = v_res.ledger_id;
    return jsonb_build_object(
      'status', 'already', 'reservation_id', v_res.id, 'ledger_id', v_ledger.id,
      'quota', v_ledger.quota, 'used', coalesce(v_ledger.used, 0), 'accepted', v_ledger.accepted);
  end if;

  insert into capacity_ledger (send_account_id, date, quota)
  values (p_send_account_id, p_date, p_quota)
  on conflict (send_account_id, date) do nothing;

  update capacity_ledger
     set quota = p_quota
   where send_account_id = p_send_account_id
     and date = p_date
     and (quota is null or quota > p_quota);

  select * into v_ledger
    from capacity_ledger
   where send_account_id = p_send_account_id and date = p_date;

  begin
    insert into capacity_reservations (ledger_id, send_account_id, date, n, state, idempotency_key, settled_at)
    values (v_ledger.id, p_send_account_id, p_date, 1, 'accepted', v_key, now())
    returning * into v_res;
  exception when unique_violation then
    -- A concurrent delivery of the same email won: count nothing.
    select * into v_res from capacity_reservations where idempotency_key = v_key;
    select * into v_ledger from capacity_ledger where id = v_res.ledger_id;
    return jsonb_build_object(
      'status', 'already', 'reservation_id', v_res.id, 'ledger_id', v_ledger.id,
      'quota', v_ledger.quota, 'used', coalesce(v_ledger.used, 0), 'accepted', v_ledger.accepted);
  end;

  update capacity_ledger
     set used     = coalesce(used, 0) + 1,
         accepted = accepted + 1
   where id = v_ledger.id
  returning * into v_ledger;

  return jsonb_build_object(
    'status', 'recorded', 'reservation_id', v_res.id, 'ledger_id', v_ledger.id,
    'quota', v_ledger.quota, 'used', coalesce(v_ledger.used, 0), 'accepted', v_ledger.accepted);
end;
$$;

-- ============================================================
-- approve_email_sequence(): approve every step of one lead's sequence in one
-- fenced write (09 §U6c scope 2), or none of them.
--
-- PostgREST cannot fence N rows all-or-nothing: a filtered UPDATE would
-- approve 2 of 3 steps if one had changed. This locks the lead's pending
-- outbound touches and the named ones, then refuses unless
--   - every named touch belongs to the lead, is outbound and pending_approval,
--   - the named touches are exactly the lead's pending outbound touches.
-- Only then does it write, per step, body + claim_ledger, and on every step
-- the shared approval: status, hash, snapshot, sender, approved_at/by.
--
--   p_steps  jsonb array of {touch_id, body, claim_ledger}
-- ============================================================

create or replace function approve_email_sequence(
  p_lead_id         uuid,
  p_steps           jsonb,
  p_hash            text,
  p_snapshot        jsonb,
  p_send_account_id uuid,
  p_approved_by     text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ids       uuid[];
  v_named     int;
  v_matching  int;
  v_pending   int;
  v_step      jsonb;
  v_now       timestamptz := now();
begin
  if p_lead_id is null or p_send_account_id is null then
    raise exception 'approve_email_sequence: p_lead_id and p_send_account_id are required';
  end if;
  if p_hash is null or length(trim(p_hash)) = 0 then
    raise exception 'approve_email_sequence: p_hash is required';
  end if;
  if p_snapshot is null or jsonb_typeof(p_snapshot) <> 'object' then
    raise exception 'approve_email_sequence: p_snapshot must be an object';
  end if;
  if p_approved_by is null or length(trim(p_approved_by)) = 0 then
    raise exception 'approve_email_sequence: p_approved_by is required';
  end if;
  if p_steps is null or jsonb_typeof(p_steps) <> 'array' or jsonb_array_length(p_steps) = 0 then
    raise exception 'approve_email_sequence: p_steps must be a non-empty array';
  end if;

  select array_agg((s->>'touch_id')::uuid) into v_ids from jsonb_array_elements(p_steps) s;
  v_named := (select count(distinct x) from unnest(v_ids) x);
  if v_named <> jsonb_array_length(p_steps) then
    raise exception 'approve_email_sequence: duplicate touch ids in p_steps';
  end if;

  -- Lock the named touches and the lead's pending ones before judging them.
  perform 1
     from touches
    where id = any(v_ids)
       or (lead_id = p_lead_id and direction = 'outbound' and status = 'pending_approval')
    for update;

  select count(*) into v_matching
    from touches
   where id = any(v_ids)
     and lead_id = p_lead_id
     and direction = 'outbound'
     and status = 'pending_approval';

  select count(*) into v_pending
    from touches
   where lead_id = p_lead_id and direction = 'outbound' and status = 'pending_approval';

  if v_matching <> v_named or v_pending <> v_named then
    return jsonb_build_object(
      'status', 'not_pending', 'named', v_named, 'matching', v_matching, 'lead_pending', v_pending);
  end if;

  for v_step in select * from jsonb_array_elements(p_steps) loop
    update touches
       set body              = v_step->>'body',
           claim_ledger      = v_step->'claim_ledger',
           status            = 'approved',
           approval_hash     = p_hash,
           approval_snapshot = p_snapshot,
           send_account_id   = p_send_account_id,
           approved_at       = v_now,
           approved_by       = p_approved_by
     where id = (v_step->>'touch_id')::uuid;
  end loop;

  return jsonb_build_object('status', 'approved', 'approved', v_named, 'approved_at', v_now);
end;
$$;

revoke execute on function record_provider_send(uuid, date, int, text) from public;
revoke execute on function record_provider_send(uuid, date, int, text) from anon, authenticated;
grant  execute on function record_provider_send(uuid, date, int, text) to service_role;

revoke execute on function approve_email_sequence(uuid, jsonb, text, jsonb, uuid, text) from public;
revoke execute on function approve_email_sequence(uuid, jsonb, text, jsonb, uuid, text) from anon, authenticated;
grant  execute on function approve_email_sequence(uuid, jsonb, text, jsonb, uuid, text) to service_role;

-- ============================================================
-- Verification (run in the SQL editor after applying; paste into 07).
-- ============================================================
-- select relname, relrowsecurity from pg_class
--  where relnamespace = 'public'::regnamespace and relname = 'instantly_enrollments';
-- -- expect: instantly_enrollments | t
--
-- select routine_name, grantee from information_schema.routine_privileges
--  where routine_schema = 'public' and routine_name in ('record_provider_send', 'approve_email_sequence')
--  order by routine_name, grantee;
-- -- expect service_role (plus the owner, postgres) for each; no anon, authenticated or PUBLIC
--
-- select conname from pg_constraint where conrelid = 'instantly_enrollments'::regclass and contype = 'c';
-- -- expect 2 rows (steps_total, state)
