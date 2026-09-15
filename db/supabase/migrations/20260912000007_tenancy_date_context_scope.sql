-- Bind previews to one tenancy even when all selected date facts happen to match.
create or replace function public.get_tenancy_date_context(p_account_id uuid, p_tenancy_id uuid,
  p_lease_id uuid default null, p_rent_schedule_id uuid default null) returns jsonb
language plpgsql stable set search_path = public as $$
declare
  t public.tenancies; l jsonb; s jsonb; e jsonb; v jsonb; h text;
  info text[] := '{}'; explanation jsonb;
begin
  if public._tenancy_date_actor() is null or not public.is_account_member(p_account_id) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  select * into t from public.tenancies where account_id = p_account_id
    and id = p_tenancy_id and deleted_at is null;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  if p_lease_id is not null then
    select jsonb_build_object('id', id, 'term_start', term_start, 'term_end', term_end,
      'status', status, 'voided_at', voided_at, 'updated_at', updated_at) into l
      from public.leases where account_id = p_account_id and tenancy_id = t.id
        and id = p_lease_id and deleted_at is null;
    if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  end if;
  if p_rent_schedule_id is not null then
    select jsonb_build_object('id', id, 'start_date', start_date, 'end_date', end_date,
      'due_day', due_day, 'updated_at', updated_at) into s
      from public.rent_schedules where account_id = p_account_id and tenancy_id = t.id
        and id = p_rent_schedule_id and deleted_at is null;
    if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  end if;
  select jsonb_build_object('id', id, 'kind', kind, 'effective_date', effective_date)
    into e from public.tenancy_endings where account_id = p_account_id and tenancy_id = t.id;
  v := jsonb_build_object('version', 1, 'facts', public._tenancy_date_facts(t),
    'lease', l, 'schedule', s, 'ending', e);
  h := encode(sha256(convert_to(jsonb_build_object('account_id', p_account_id,
    'tenancy_id', p_tenancy_id, 'context', v)::text, 'UTF8')), 'hex');
  if t.start_date_basis = 'legacy_unverified' then info := array_append(info, 'legacy_date_unverified'); end if;
  if (l is not null and (l->>'term_start')::date <> t.start_date)
    or (s is not null and (s->>'start_date')::date <> t.start_date) then
    info := array_append(info, 'date_values_differ');
  end if;
  if s is not null and (s->>'start_date')::date < t.start_date then
    info := array_append(info, 'billing_precedes_possession');
  end if;
  if t.status = 'ended' and t.end_date is null and e is null then
    info := array_append(info, 'legacy_ending_incomplete');
  end if;
  select to_jsonb(r) - array['request_key','request_fingerprint','response_body']
    into explanation from public.tenancy_date_records r
    where account_id = p_account_id and tenancy_id = t.id and kind = 'explanation'
      and context_fingerprint = h order by created_at desc, id desc limit 1;
  return v || jsonb_build_object('context_fingerprint', h, 'information', info,
    'applicable_explanation', explanation,
    'can_correct_start', coalesce(e->>'kind', '') <> 'cancelled_before_move_in');
end $$;
