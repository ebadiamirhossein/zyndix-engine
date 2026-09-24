-- reserve_capacity() / settle_capacity(): atomic quota reservations (09 §U3)
-- Apply in Supabase SQL editor, after 0007_capacity_counters.sql.

-- ============================================================
-- Counter semantics are documented in 0007's header. These two functions are
-- the only writers of capacity_ledger's counters and capacity_reservations'
-- state.
--
-- Atomicity: the reserve is a single guarded UPDATE
--     ... set reserved = reserved + n where used + reserved + n <= quota
-- Concurrent callers queue on the ledger row's lock; under READ COMMITTED
-- each waiter re-evaluates the WHERE against the row the previous holder
-- committed. So 30 concurrent calls against quota 15 give exactly 15 ok.
--
-- Same pattern as claim_jobs (0006b): security definer, pinned search_path,
-- PUBLIC execute revoked, service_role only.
-- ============================================================

create or replace function reserve_capacity(
  p_send_account_id uuid,
  p_date            date,
  p_quota           int,
  p_n               int  default 1,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_res    capacity_reservations%rowtype;
  v_ledger capacity_ledger%rowtype;
begin
  if p_send_account_id is null then
    raise exception 'reserve_capacity: p_send_account_id is required';
  end if;
  if p_date is null then
    raise exception 'reserve_capacity: p_date is required';
  end if;
  if p_quota is null or p_quota < 0 or p_quota > 10000 then
    raise exception 'reserve_capacity: p_quota must be 0..10000, got %', p_quota;
  end if;
  if p_n is null or p_n < 1 or p_n > 1000 then
    raise exception 'reserve_capacity: p_n must be 1..1000, got %', p_n;
  end if;
  if p_idempotency_key is not null and length(trim(p_idempotency_key)) = 0 then
    raise exception 'reserve_capacity: p_idempotency_key must be null or non-blank';
  end if;

  -- 1. Replay: the same logical send reserving again gets its first reservation.
  if p_idempotency_key is not null then
    select * into v_res from capacity_reservations where idempotency_key = p_idempotency_key;
    if found then
      select * into v_ledger from capacity_ledger where id = v_res.ledger_id;
      return jsonb_build_object(
        'status', 'ok', 'replayed', true,
        'reservation_id', v_res.id, 'reservation_state', v_res.state,
        'ledger_id', v_ledger.id, 'date', v_ledger.date,
        'quota', v_ledger.quota, 'used', coalesce(v_ledger.used, 0), 'reserved', v_ledger.reserved);
    end if;
  end if;

  -- 2. The day's ledger row; the first reservation of the day sets its quota.
  insert into capacity_ledger (send_account_id, date, quota)
  values (p_send_account_id, p_date, p_quota)
  on conflict (send_account_id, date) do nothing;

  -- 3. A day's quota only ever goes down (e.g. the ramp was lowered mid-day).
  update capacity_ledger
     set quota = p_quota
   where send_account_id = p_send_account_id
     and date = p_date
     and (quota is null or quota > p_quota);

  -- 4. Guarded increment + reservation row, as one subtransaction: if a
  --    concurrent caller with the same idempotency key won, the unique
  --    violation rolls back this increment and we return the winner's row.
  begin
    update capacity_ledger l
       set reserved = l.reserved + p_n
     where l.send_account_id = p_send_account_id
       and l.date = p_date
       and coalesce(l.used, 0) + l.reserved + p_n <= l.quota
    returning * into v_ledger;

    if not found then
      select * into v_ledger
        from capacity_ledger
       where send_account_id = p_send_account_id and date = p_date;
      return jsonb_build_object(
        'status', 'quota_exhausted', 'replayed', false,
        'reservation_id', null, 'reservation_state', null,
        'ledger_id', v_ledger.id, 'date', v_ledger.date,
        'quota', v_ledger.quota, 'used', coalesce(v_ledger.used, 0), 'reserved', v_ledger.reserved);
    end if;

    insert into capacity_reservations (ledger_id, send_account_id, date, n, idempotency_key)
    values (v_ledger.id, p_send_account_id, p_date, p_n, p_idempotency_key)
    returning * into v_res;
  exception when unique_violation then
    select * into v_res from capacity_reservations where idempotency_key = p_idempotency_key;
    select * into v_ledger from capacity_ledger where id = v_res.ledger_id;
    return jsonb_build_object(
      'status', 'ok', 'replayed', true,
      'reservation_id', v_res.id, 'reservation_state', v_res.state,
      'ledger_id', v_ledger.id, 'date', v_ledger.date,
      'quota', v_ledger.quota, 'used', coalesce(v_ledger.used, 0), 'reserved', v_ledger.reserved);
  end;

  return jsonb_build_object(
    'status', 'ok', 'replayed', false,
    'reservation_id', v_res.id, 'reservation_state', v_res.state,
    'ledger_id', v_ledger.id, 'date', v_ledger.date,
    'quota', v_ledger.quota, 'used', coalesce(v_ledger.used, 0), 'reserved', v_ledger.reserved);
end;
$$;

-- ============================================================
-- settle_capacity(): move a reservation one step and apply its counter
-- deltas (table in 0007). Reaching a state the reservation is already in is
-- an idempotent 'already' with no counter change; any other transition from
-- the wrong state raises.
-- ============================================================
create or replace function settle_capacity(
  p_reservation_id uuid,
  p_outcome        text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_res        capacity_reservations%rowtype;
  v_ledger     capacity_ledger%rowtype;
  v_from       text;
  v_to         text;
  v_recon      text := null;
  d_reserved   int := 0;
  d_used       int := 0;
  d_accepted   int := 0;
  d_failed     int := 0;
  d_reconciled int := 0;
begin
  if p_reservation_id is null then
    raise exception 'settle_capacity: p_reservation_id is required';
  end if;

  case p_outcome
    when 'release'            then v_from := 'reserved';  v_to := 'released';
    when 'accept'             then v_from := 'reserved';  v_to := 'accepted';
    when 'fail'               then v_from := 'reserved';  v_to := 'failed';
    when 'uncertain'          then v_from := 'reserved';  v_to := 'uncertain';
    when 'reconcile_sent'     then v_from := 'uncertain'; v_to := 'reconciled'; v_recon := 'sent';
    when 'reconcile_not_sent' then v_from := 'uncertain'; v_to := 'reconciled'; v_recon := 'not_sent';
    else raise exception 'settle_capacity: unknown outcome %', p_outcome;
  end case;

  select * into v_res from capacity_reservations where id = p_reservation_id for update;
  if not found then
    raise exception 'settle_capacity: reservation % not found', p_reservation_id;
  end if;

  if v_res.state = v_to and v_res.reconciled_outcome is not distinct from v_recon then
    select * into v_ledger from capacity_ledger where id = v_res.ledger_id;
    return jsonb_build_object(
      'status', 'already', 'reservation_id', v_res.id, 'state', v_res.state,
      'ledger_id', v_ledger.id, 'quota', v_ledger.quota, 'used', coalesce(v_ledger.used, 0),
      'reserved', v_ledger.reserved, 'accepted', v_ledger.accepted,
      'failed', v_ledger.failed, 'reconciled', v_ledger.reconciled);
  end if;

  if v_res.state <> v_from then
    raise exception 'settle_capacity: cannot % reservation % in state %', p_outcome, v_res.id, v_res.state;
  end if;

  case p_outcome
    when 'release'            then d_reserved := -v_res.n;
    when 'accept'             then d_reserved := -v_res.n; d_used := v_res.n; d_accepted := v_res.n;
    when 'fail'               then d_reserved := -v_res.n; d_failed := v_res.n;
    when 'uncertain'          then null; -- capacity stays held until reconciled
    when 'reconcile_sent'     then d_reserved := -v_res.n; d_used := v_res.n; d_reconciled := v_res.n;
    when 'reconcile_not_sent' then d_reserved := -v_res.n; d_reconciled := v_res.n;
  end case;

  update capacity_reservations
     set state              = v_to,
         reconciled_outcome = v_recon,
         settled_at         = case when v_to = 'uncertain' then null else now() end
   where id = v_res.id;

  update capacity_ledger
     set reserved   = reserved + d_reserved,
         used       = coalesce(used, 0) + d_used,
         accepted   = accepted + d_accepted,
         failed     = failed + d_failed,
         reconciled = reconciled + d_reconciled
   where id = v_res.ledger_id
  returning * into v_ledger;

  return jsonb_build_object(
    'status', 'ok', 'reservation_id', v_res.id, 'state', v_to,
    'ledger_id', v_ledger.id, 'quota', v_ledger.quota, 'used', coalesce(v_ledger.used, 0),
    'reserved', v_ledger.reserved, 'accepted', v_ledger.accepted,
    'failed', v_ledger.failed, 'reconciled', v_ledger.reconciled);
end;
$$;

revoke execute on function reserve_capacity(uuid, date, int, int, text) from public;
revoke execute on function reserve_capacity(uuid, date, int, int, text) from anon, authenticated;
grant  execute on function reserve_capacity(uuid, date, int, int, text) to service_role;

revoke execute on function settle_capacity(uuid, text) from public;
revoke execute on function settle_capacity(uuid, text) from anon, authenticated;
grant  execute on function settle_capacity(uuid, text) to service_role;
