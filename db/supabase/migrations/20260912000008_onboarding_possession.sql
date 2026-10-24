-- Independent onboarding progress and audited possession facts.

create function public.effective_tenancy_status(p_status text, p_start date,
  p_as_of date default (now() at time zone 'UTC')::date) returns text
language sql immutable set search_path = public as $$
  select case when p_status in ('ended','holdover') then p_status
    when p_start > p_as_of then 'upcoming' else 'active' end
$$;
revoke all on function public.effective_tenancy_status(text,date,date) from public,anon;
grant execute on function public.effective_tenancy_status(text,date,date)
  to authenticated,service_role,tenancy_date_writer;

create view public.tenancy_current with (security_invoker = true) as
select id,account_id,area_id,start_date,end_date,
  public.effective_tenancy_status(status,start_date) as status,
  created_at,updated_at,deleted_at,start_date_basis,actual_move_in_date,date_revision
from public.tenancies;
revoke all on public.tenancy_current from public,anon;
grant select on public.tenancy_current to authenticated,service_role,tenancy_date_writer;

create function public._normalize_tenancy_lifecycle() returns trigger
language plpgsql set search_path = public as $$
begin
  NEW.status := public.effective_tenancy_status(NEW.status,NEW.start_date);
  return NEW;
end $$;
revoke all on function public._normalize_tenancy_lifecycle() from public,anon,authenticated,service_role;
create trigger tenancies_lifecycle before insert or update of start_date,status
  on public.tenancies for each row execute function public._normalize_tenancy_lifecycle();

create table public.tenancy_onboarding_progress (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id),
  tenancy_id uuid not null,
  selected_lease_id uuid,
  selected_lease_updated_at timestamptz,
  agreement_confirmed boolean not null default false,
  condition_decision text not null default 'pending'
    check(condition_decision in ('pending','in_progress','complete','deferred')),
  possession_confirmed_revision bigint check(possession_confirmed_revision >= 0),
  rent_decision text not null default 'pending'
    check(rent_decision in ('pending','configured','deferred')),
  deposit_decision text not null default 'pending'
    check(deposit_decision in ('pending','configured','deferred')),
  revision bigint not null default 0 check(revision >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(account_id,tenancy_id),
  foreign key(account_id,tenancy_id) references public.tenancies(account_id,id),
  foreign key(account_id,selected_lease_id) references public.leases(account_id,id)
);
alter table public.tenancy_onboarding_progress enable row level security;
alter table public.tenancy_onboarding_progress force row level security;
revoke all on public.tenancy_onboarding_progress from public,anon,authenticated,service_role;
grant select,insert,update on public.tenancy_onboarding_progress to authenticated,service_role;
create policy tenancy_onboarding_progress_member on public.tenancy_onboarding_progress
  for all using(public.is_account_member(account_id)) with check(public.is_account_member(account_id));
create trigger tenancy_onboarding_progress_audit after insert or update
  on public.tenancy_onboarding_progress for each row execute function public._emit_event();

create function public._guard_onboarding_progress() returns trigger
language plpgsql set search_path = public as $$
declare t public.tenancies; l public.leases;
begin
  if TG_OP='UPDATE' and (NEW.id,NEW.account_id,NEW.tenancy_id,NEW.created_at)
    is distinct from (OLD.id,OLD.account_id,OLD.tenancy_id,OLD.created_at) then
    raise exception 'invalid_request: onboarding identity is immutable' using errcode='22023';
  end if;
  select * into t from public.tenancies where account_id=NEW.account_id and id=NEW.tenancy_id
    and deleted_at is null;
  if not found then raise exception 'not_found' using errcode='P0002'; end if;
  if NEW.selected_lease_id is not null then
    select * into l from public.leases where account_id=NEW.account_id and id=NEW.selected_lease_id
      and tenancy_id=NEW.tenancy_id and deleted_at is null and voided_at is null;
    if not found then raise exception 'source_scope_invalid' using errcode='22023'; end if;
  end if;
  if NEW.agreement_confirmed then
    if l.id is null or l.status='draft' then
      raise exception 'invalid_request: confirm recorded lease terms first' using errcode='22023';
    end if;
    if TG_OP='UPDATE' and OLD.agreement_confirmed
      and NEW.selected_lease_id is not distinct from OLD.selected_lease_id
      and NEW.selected_lease_updated_at is not distinct from OLD.selected_lease_updated_at
      and OLD.selected_lease_updated_at is distinct from l.updated_at then
      NEW.agreement_confirmed := false;
      NEW.selected_lease_updated_at := null;
    else NEW.selected_lease_updated_at := l.updated_at; end if;
  else NEW.selected_lease_updated_at := null;
  end if;
  if NEW.possession_confirmed_revision is not null and
    (NEW.possession_confirmed_revision <> t.date_revision or t.start_date_basis <> 'possession_entitlement') then
    if TG_OP='UPDATE' and NEW.possession_confirmed_revision is not distinct from OLD.possession_confirmed_revision then
      NEW.possession_confirmed_revision := null;
    else raise exception 'date_context_changed' using errcode='P0001'; end if;
  end if;
  return NEW;
end $$;
revoke all on function public._guard_onboarding_progress() from public,anon,authenticated,service_role;
create trigger tenancy_onboarding_progress_guard before insert or update
  on public.tenancy_onboarding_progress for each row execute function public._guard_onboarding_progress();

create function public.get_tenancy_onboarding_progress(p_account_id uuid,p_tenancy_id uuid) returns jsonb
language plpgsql stable set search_path = public as $$
declare t public.tenancies; p public.tenancy_onboarding_progress; l public.leases;
  condition text; rent text; deposit text;
begin
  if auth.uid() is null or not public.is_account_member(p_account_id) then
    raise exception 'not_found' using errcode='P0002'; end if;
  select * into t from public.tenancies where account_id=p_account_id and id=p_tenancy_id
    and deleted_at is null;
  if not found then raise exception 'not_found' using errcode='P0002'; end if;
  select * into p from public.tenancy_onboarding_progress where account_id=p_account_id and tenancy_id=t.id;
  select * into l from public.leases where account_id=p_account_id and tenancy_id=t.id
    and id=p.selected_lease_id and deleted_at is null and voided_at is null;
  condition := coalesce(p.condition_decision,'pending');
  if exists(select 1 from public.inspections where account_id=p_account_id and tenancy_id=t.id
    and kind='move_in' and deleted_at is null and voided_at is null
    and (completed_at is not null or status='completed'))
    or exists(select 1 from public.documents where account_id=p_account_id and tenancy_id=t.id
      and document_type='move_in' and deleted_at is null) then condition := 'complete';
  elsif exists(select 1 from public.inspections where account_id=p_account_id and tenancy_id=t.id
    and kind='move_in' and deleted_at is null and voided_at is null) then condition := 'in_progress';
  elsif condition in ('complete','in_progress') then condition := 'pending'; end if;
  rent := coalesce(p.rent_decision,'pending'); deposit := coalesce(p.deposit_decision,'pending');
  if exists(select 1 from public.rent_schedules where account_id=p_account_id and tenancy_id=t.id
    and kind='rent' and deleted_at is null) then rent := 'configured';
  elsif rent='configured' then rent := 'pending'; end if;
  if exists(select 1 from public.charges where account_id=p_account_id and tenancy_id=t.id
    and type='deposit' and deleted_at is null and voided_at is null) then deposit := 'configured';
  elsif deposit='configured' then deposit := 'pending'; end if;
  return jsonb_build_object('tenancy_id',t.id,'selected_lease_id',p.selected_lease_id,
    'selected_lease_updated_at',p.selected_lease_updated_at,
    'agreement_confirmed',coalesce(p.agreement_confirmed and l.id is not null
      and l.status <> 'draft' and l.updated_at=p.selected_lease_updated_at,false),
    'condition_decision',condition,'possession_confirmed_revision',case
      when p.possession_confirmed_revision=t.date_revision then p.possession_confirmed_revision else null end,
    'rent_decision',rent,'deposit_decision',deposit,'revision',coalesce(p.revision,0),
    'date_revision',t.date_revision,'effective_status',public.effective_tenancy_status(t.status,t.start_date),
    'as_of_date',(now() at time zone 'UTC')::date,'clock_basis','UTC','updated_at',p.updated_at);
end $$;
revoke all on function public.get_tenancy_onboarding_progress(uuid,uuid) from public,anon;
grant execute on function public.get_tenancy_onboarding_progress(uuid,uuid) to authenticated,service_role;

create function public.update_tenancy_onboarding_progress(p_account_id uuid,p_tenancy_id uuid,p_payload jsonb) returns jsonb
language plpgsql set search_path = public as $$
declare p public.tenancy_onboarding_progress; t public.tenancies;
begin
  if auth.uid() is null or not public.is_account_member(p_account_id) then
    raise exception 'not_found' using errcode='P0002'; end if;
  if jsonb_typeof(p_payload) is distinct from 'object' or p_payload - array[
    'expected_revision','selected_lease_id','agreement_confirmed','condition_decision',
    'possession_confirmed_revision','rent_decision','deposit_decision'] <> '{}'::jsonb then
    raise exception 'invalid_request' using errcode='22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('onboarding:'||p_tenancy_id::text,0));
  select * into t from public.tenancies where account_id=p_account_id and id=p_tenancy_id
    and deleted_at is null for update;
  if not found then raise exception 'not_found' using errcode='P0002'; end if;
  select * into p from public.tenancy_onboarding_progress where account_id=p_account_id and tenancy_id=t.id for update;
  if p_payload ? 'possession_confirmed_revision' and p_payload->>'possession_confirmed_revision' is not null
    and ((p_payload->>'possession_confirmed_revision')::bigint <> t.date_revision
      or t.start_date_basis <> 'possession_entitlement') then raise exception 'date_context_changed'; end if;
  if p_payload ? 'expected_revision' and (p_payload->>'expected_revision')::bigint
    is distinct from coalesce(p.revision,0) then raise exception 'date_context_changed'; end if;
  if p.agreement_confirmed and not exists(select 1 from public.leases where account_id=p_account_id
    and tenancy_id=t.id and id=p.selected_lease_id and voided_at is null and deleted_at is null
    and updated_at=p.selected_lease_updated_at) then p.agreement_confirmed := false; end if;
  if p_payload ? 'selected_lease_id' and (p_payload->>'selected_lease_id')::uuid
    is distinct from p.selected_lease_id and not (p_payload ? 'agreement_confirmed') then
    p.agreement_confirmed := false;
  end if;
  insert into public.tenancy_onboarding_progress(account_id,tenancy_id,selected_lease_id,agreement_confirmed,
    condition_decision,possession_confirmed_revision,rent_decision,deposit_decision,revision)
  values(p_account_id,t.id,
    case when p_payload ? 'selected_lease_id' then (p_payload->>'selected_lease_id')::uuid else p.selected_lease_id end,
    coalesce((p_payload->>'agreement_confirmed')::boolean,p.agreement_confirmed,false),
    coalesce(p_payload->>'condition_decision',p.condition_decision,'pending'),
    case when p_payload ? 'possession_confirmed_revision' then (p_payload->>'possession_confirmed_revision')::bigint
      else case when p.possession_confirmed_revision=t.date_revision then p.possession_confirmed_revision else null end end,
    coalesce(p_payload->>'rent_decision',p.rent_decision,'pending'),
    coalesce(p_payload->>'deposit_decision',p.deposit_decision,'pending'),coalesce(p.revision,0)+1)
  on conflict(account_id,tenancy_id) do update set selected_lease_id=excluded.selected_lease_id,
    selected_lease_updated_at=excluded.selected_lease_updated_at,
    agreement_confirmed=excluded.agreement_confirmed,condition_decision=excluded.condition_decision,
    possession_confirmed_revision=excluded.possession_confirmed_revision,rent_decision=excluded.rent_decision,
    deposit_decision=excluded.deposit_decision,revision=excluded.revision,updated_at=now();
  return public.get_tenancy_onboarding_progress(p_account_id,t.id);
end $$;
revoke all on function public.update_tenancy_onboarding_progress(uuid,uuid,jsonb) from public,anon;
grant execute on function public.update_tenancy_onboarding_progress(uuid,uuid,jsonb) to authenticated,service_role;

create function public.bootstrap_tenancy(p_account_id uuid,p_idempotency_key text,
  p_request_fingerprint text,p_payload jsonb) returns jsonb
language plpgsql set search_path = public as $$
declare t public.tenancies; m public.tenancy_tenants; k public.idempotency_keys; result jsonb;
  area uuid; tenant uuid; start_on date;
begin
  if auth.uid() is null or not public.is_account_member(p_account_id) then
    raise exception 'not_found' using errcode='P0002'; end if;
  select * into k from public.idempotency_keys where account_id=p_account_id and key=p_idempotency_key for update;
  if not found or k.request_fingerprint is distinct from p_request_fingerprint then
    raise exception 'idempotency_fingerprint_mismatch' using errcode='22023'; end if;
  if k.completed_at is not null then return k.body; end if;
  if jsonb_typeof(p_payload) is distinct from 'object' or p_payload - array[
    'area_id','tenant_id','start_date','start_date_basis','actual_move_in_date','end_date','status'] <> '{}'::jsonb then
    raise exception 'invalid_request' using errcode='22023'; end if;
  area := (p_payload->>'area_id')::uuid; tenant := (p_payload->>'tenant_id')::uuid;
  start_on := public._tenancy_calendar_date(p_payload->>'start_date');
  if not exists(select 1 from public.areas where account_id=p_account_id and id=area and kind='unit' and deleted_at is null)
    or not exists(select 1 from public.tenants where account_id=p_account_id and id=tenant and deleted_at is null) then
    raise exception 'not_found' using errcode='P0002'; end if;
  perform pg_advisory_xact_lock(hashtextextended('tenancy_identity:'||p_account_id::text||':'||area::text,0));
  if exists(select 1 from public.tenancies x join public.tenancy_tenants y on y.account_id=x.account_id and y.tenancy_id=x.id
    where x.account_id=p_account_id and x.area_id=area and x.start_date=start_on and x.deleted_at is null
      and y.tenant_id=tenant and y.deleted_at is null) then
    raise exception 'conflict: tenancy already recorded' using errcode='P0001'; end if;
  insert into public.tenancies(account_id,area_id,start_date,start_date_basis,actual_move_in_date,end_date,status)
  values(p_account_id,area,start_on,coalesce(p_payload->>'start_date_basis','legacy_unverified'),
    (p_payload->>'actual_move_in_date')::date,(p_payload->>'end_date')::date,
    public.effective_tenancy_status(coalesce(p_payload->>'status','upcoming'),start_on)) returning * into t;
  insert into public.tenancy_tenants(account_id,tenancy_id,tenant_id,role)
    values(p_account_id,t.id,tenant,'primary') returning * into m;
  result := jsonb_build_object('tenancy',to_jsonb(t),'member',to_jsonb(m));
  update public.idempotency_keys set status_code=201,body=result,completed_at=now()
    where account_id=p_account_id and key=p_idempotency_key and request_fingerprint=p_request_fingerprint;
  if not found then raise exception 'idempotency_completion_lost'; end if;
  return result;
end $$;
revoke all on function public.bootstrap_tenancy(uuid,text,text,jsonb) from public,anon;
grant execute on function public.bootstrap_tenancy(uuid,text,text,jsonb) to authenticated,service_role;
