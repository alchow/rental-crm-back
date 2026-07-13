-- Close the two remaining tenancy-ending lifecycle gaps:
--   * a normal ending is a fact that has already taken effect, not a scheduled
--     future state change;
--   * once an immutable ending exists, generic tenancy PATCHes cannot reopen
--     the row or move its operational end_date away from that fact.

create or replace function public._guard_recorded_tenancy_ending()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ending public.tenancy_endings%rowtype;
  v_expected_end_date date;
begin
  select te.*
    into v_ending
    from public.tenancy_endings te
   where te.account_id = NEW.account_id
     and te.tenancy_id = NEW.id;

  if v_ending.id is null then
    return NEW;
  end if;

  -- Once an ending is recorded, both boundaries are historical facts. In
  -- particular, a cancelled tenancy's operational end_date is its ORIGINAL
  -- scheduled start. Deriving this from NEW.start_date would let a caller
  -- rewrite both dates together and preserve the equality while changing
  -- history.
  if NEW.start_date is distinct from OLD.start_date then
    raise exception 'conflict: start_date is fixed by the immutable tenancy ending'
      using errcode = 'check_violation';
  end if;

  v_expected_end_date := case
    when v_ending.kind = 'cancelled_before_move_in' then OLD.start_date
    else v_ending.effective_date
  end;

  if NEW.status <> 'ended' then
    raise exception 'conflict: a tenancy with an immutable ending cannot be reopened'
      using errcode = 'check_violation';
  end if;

  if NEW.end_date is distinct from v_expected_end_date then
    raise exception 'conflict: end_date is fixed by the immutable tenancy ending'
      using errcode = 'check_violation';
  end if;

  return NEW;
end;
$$;

create trigger tenancies_guard_recorded_ending
  before update of status, end_date, start_date on public.tenancies
  for each row execute function public._guard_recorded_tenancy_ending();

revoke all on function public._guard_recorded_tenancy_ending()
  from public, anon, authenticated, service_role;

create or replace function public.end_tenancy(
  p_account_id            uuid,
  p_tenancy_id            uuid,
  p_kind                  text,
  p_effective_date        date,
  p_initiated_by          text default 'unknown',
  p_reason_code           text default 'other',
  p_reason_note           text default null,
  p_source_notice_id      uuid default null,
  p_source_interaction_id uuid default null
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_tenancy public.tenancies%rowtype;
  v_ending public.tenancy_endings%rowtype;
  v_tenancy_end date;
begin
  perform pg_advisory_xact_lock(hashtextextended('tenancy_end:' || p_tenancy_id::text, 0));

  select *
    into v_tenancy
    from public.tenancies
   where account_id = p_account_id
     and id = p_tenancy_id
     and deleted_at is null
   for update;

  if v_tenancy.id is null then
    raise exception 'not_found: tenancy';
  end if;
  if v_tenancy.status = 'ended' then
    raise exception 'conflict: tenancy already ended';
  end if;
  if p_effective_date is null then
    raise exception 'invalid: effective_date is required';
  end if;
  if p_kind not in ('ended', 'cancelled_before_move_in') then
    raise exception 'invalid: kind must be ended or cancelled_before_move_in';
  end if;
  if p_initiated_by not in ('tenant', 'landlord', 'mutual', 'unknown') then
    raise exception 'invalid: initiated_by is not recognized';
  end if;

  if p_kind = 'cancelled_before_move_in' then
    if v_tenancy.status <> 'upcoming' then
      raise exception 'conflict: cancellation before move-in requires an upcoming tenancy';
    end if;
    if p_effective_date > v_tenancy.start_date then
      raise exception 'invalid: cancellation effective_date must be on or before start_date';
    end if;
    if p_reason_code not in ('applicant_withdrew', 'landlord_withdrew', 'other') then
      raise exception 'invalid: reason_code is not valid for cancelled_before_move_in';
    end if;
    v_tenancy_end := v_tenancy.start_date;
  else
    if v_tenancy.status not in ('active', 'holdover') then
      raise exception 'conflict: ending requires an active or holdover tenancy';
    end if;
    if p_effective_date < v_tenancy.start_date then
      raise exception 'invalid: ending effective_date cannot be before start_date';
    end if;
    -- Use an explicit UTC calendar date so a caller-controlled session
    -- timezone cannot turn tomorrow into today for this integrity check.
    if p_effective_date > (statement_timestamp() at time zone 'UTC')::date then
      raise exception 'invalid: ending effective_date cannot be in the future';
    end if;
    if p_reason_code not in (
      'notice', 'abandonment', 'fixed_term_completed', 'mutual_surrender', 'other'
    ) then
      raise exception 'invalid: reason_code is not valid for ended';
    end if;
    v_tenancy_end := p_effective_date;
  end if;

  if p_source_notice_id is not null and not exists (
    select 1
      from public.notices n
     where n.account_id = p_account_id
       and n.id = p_source_notice_id
       and n.tenancy_id = p_tenancy_id
       and n.deleted_at is null
  ) then
    raise exception 'not_found: source notice';
  end if;

  if p_source_interaction_id is not null and not exists (
    select 1
      from public.interactions i
     where i.account_id = p_account_id
       and i.id = p_source_interaction_id
       and i.tenancy_id = p_tenancy_id
       and i.deleted_at is null
  ) then
    raise exception 'not_found: source interaction';
  end if;

  perform set_config('app.tenancy_end_workflow', '1', true);

  insert into public.tenancy_endings (
    account_id, tenancy_id, kind, effective_date, initiated_by, reason_code,
    reason_note, source_notice_id, source_interaction_id
  ) values (
    p_account_id, p_tenancy_id, p_kind, p_effective_date, p_initiated_by,
    p_reason_code, p_reason_note, p_source_notice_id, p_source_interaction_id
  )
  returning * into v_ending;

  update public.tenancies
     set status = 'ended',
         end_date = v_tenancy_end,
         updated_at = now()
   where account_id = p_account_id
     and id = p_tenancy_id
  returning * into v_tenancy;

  return jsonb_build_object(
    'tenancy', to_jsonb(v_tenancy),
    'ending', to_jsonb(v_ending)
  );
exception
  when unique_violation then
    raise exception 'conflict: tenancy already has an ending record';
end;
$$;

-- Reassert the complete desired ACL instead of relying on Supabase defaults.
revoke all on function public.end_tenancy(
  uuid, uuid, text, date, text, text, text, uuid, uuid
) from public, anon, authenticated, service_role;
grant execute on function public.end_tenancy(
  uuid, uuid, text, date, text, text, text, uuid, uuid
) to authenticated, service_role;

notify pgrst, 'reload schema';
