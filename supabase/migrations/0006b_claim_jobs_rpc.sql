-- claim_jobs(): lease up to p_limit runnable jobs of the given types (09 §U2)
-- Apply in Supabase SQL editor, after 0006_jobs.sql.

-- ============================================================
-- Two concurrent callers get DISJOINT rows: the candidate select takes row
-- locks with SKIP LOCKED, so a row locked by one claimer is invisible to the
-- other instead of blocking it or being handed out twice.
--
-- Runnable = queued with run_after <= now(), OR leased with an expired lease
-- (the previous holder crashed or overran). A re-claimed row keeps its id,
-- payload and idempotency_key; only lease_owner/lease_expires_at change, and
-- attempts increments — a crash counts as an attempt, so a job that kills
-- its worker cannot loop forever.
--
-- p_types is mandatory: a worker only claims types it has handlers for, and
-- tests claim only their own tagged fixture type.
--
-- Unlike 0002's transition_lead, this function pins search_path and revokes
-- the PUBLIC execute default (09 §5 backlog: function_search_path_mutable).
-- ============================================================
create or replace function claim_jobs(
  p_owner         text,
  p_types         text[],
  p_limit         int default 1,
  p_lease_seconds int default 300
)
returns setof jobs
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_owner is null or length(trim(p_owner)) = 0 then
    raise exception 'claim_jobs: p_owner is required';
  end if;
  if p_types is null or cardinality(p_types) = 0 then
    raise exception 'claim_jobs: p_types must name at least one job type';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 100 then
    raise exception 'claim_jobs: p_limit must be 1..100, got %', p_limit;
  end if;
  if p_lease_seconds is null or p_lease_seconds < 1 or p_lease_seconds > 3600 then
    raise exception 'claim_jobs: p_lease_seconds must be 1..3600, got %', p_lease_seconds;
  end if;

  -- 1. Dead-letter expired leases that already used their final attempt.
  --    Re-claiming them would exceed max_attempts.
  update jobs j
     set state            = 'dead',
         last_error       = 'lease_expired_after_final_attempt',
         lease_owner      = null,
         lease_expires_at = null,
         finished_at      = now()
   where j.id in (
           select id
             from jobs
            where type = any(p_types)
              and state = 'leased'
              and lease_expires_at < now()
              and attempts >= max_attempts
            for update skip locked
         );

  -- 2. Lease the runnable rows.
  return query
  with candidates as (
    select id
      from jobs
     where type = any(p_types)
       and (
             (state = 'queued' and run_after <= now())
          or (state = 'leased' and lease_expires_at < now() and attempts < max_attempts)
           )
     order by run_after, created_at
     limit p_limit
     for update skip locked
  )
  update jobs j
     set state            = 'leased',
         lease_owner      = p_owner,
         lease_expires_at = now() + make_interval(secs => p_lease_seconds),
         attempts         = j.attempts + 1
    from candidates c
   where j.id = c.id
  returning j.*;
end;
$$;

revoke execute on function claim_jobs(text, text[], int, int) from public;
revoke execute on function claim_jobs(text, text[], int, int) from anon, authenticated;
grant  execute on function claim_jobs(text, text[], int, int) to service_role;
