-- Atomic lead state transition (doc 02 §5, step 4)
-- Apply in Supabase SQL editor.

create or replace function transition_lead(
  p_lead_id     uuid,
  p_from        text,
  p_to          text,
  p_event       text,
  p_detail      jsonb default '{}'::jsonb,
  p_next_action timestamptz default null
)
returns leads
language plpgsql
security definer
as $$
declare
  v_lead leads;
begin
  -- lock the row: two concurrent transitions on one lead must serialize
  select * into v_lead from leads where id = p_lead_id for update;

  if not found then
    raise exception 'lead % not found', p_lead_id;
  end if;

  -- optimistic guard: caller states the state it believes the lead is in
  if v_lead.state is distinct from p_from then
    raise exception 'stale transition: lead % is in state %, caller expected %',
      p_lead_id, v_lead.state, p_from;
  end if;

  update leads
     set state            = p_to,
         state_changed_at = now(),
         next_action_at   = p_next_action
   where id = p_lead_id
  returning * into v_lead;

  insert into lead_events (lead_id, event, detail)
  values (p_lead_id, p_event, p_detail || jsonb_build_object('from', p_from, 'to', p_to));

  return v_lead;
end;
$$;

grant execute on function transition_lead(uuid, text, text, text, jsonb, timestamptz) to service_role;
