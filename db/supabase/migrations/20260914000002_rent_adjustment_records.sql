-- Correction receipts and lineage are authoritative, immutable evidence.
create role rent_adjustment_writer nologin noinherit;
grant rent_adjustment_writer to postgres;
grant usage, create on schema public to rent_adjustment_writer;
grant usage on schema auth, extensions to rent_adjustment_writer;
grant execute on function auth.uid(), public.is_account_member(uuid) to rent_adjustment_writer;
grant select on public.accounts, public.account_members, public.tenancies, public.tenancy_endings,
  public.leases, public.notices, public.rent_schedules, public.charges, public.payments,
  public.payment_allocations, public.idempotency_keys to rent_adjustment_writer;
grant insert, update on public.leases, public.notices, public.rent_schedules,
  public.charges, public.payment_allocations to rent_adjustment_writer;
grant update (status_code, body, completed_at) on public.idempotency_keys to rent_adjustment_writer;

create table public.rent_adjustments (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id),
  tenancy_id uuid not null,
  kind text not null check (kind in ('edit_details','correct_rent','change_rent')),
  created_by uuid not null,
  created_at timestamptz not null default now(),
  request_key text not null,
  request_fingerprint text not null,
  response_body jsonb not null,
  foreign key (account_id,tenancy_id) references public.tenancies(account_id,id),
  unique(account_id,id), unique(account_id,request_key)
);
alter table public.rent_adjustments enable row level security;
alter table public.rent_adjustments force row level security;
revoke all on public.rent_adjustments from public, anon, authenticated, service_role;
grant select on public.rent_adjustments to authenticated, service_role, rent_adjustment_writer;
grant insert on public.rent_adjustments to rent_adjustment_writer;
create policy rent_adjustments_read on public.rent_adjustments for select
  using (public.is_account_member(account_id));
create policy rent_adjustments_insert on public.rent_adjustments for insert to rent_adjustment_writer
  with check (public.is_account_member(account_id) and created_by=auth.uid());
create index rent_adjustments_history on public.rent_adjustments(account_id,tenancy_id,created_at,id);

alter table public.rent_schedules add column corrects_schedule_id uuid,
  add foreign key (account_id,corrects_schedule_id) references public.rent_schedules(account_id,id);
alter table public.charges add column corrects_charge_id uuid,
  add foreign key (account_id,corrects_charge_id) references public.charges(account_id,id);
alter table public.payment_allocations add unique(account_id,id), add column corrects_allocation_id uuid,
  add foreign key (account_id,corrects_allocation_id) references public.payment_allocations(account_id,id);

create function public._guard_rent_adjustment_history() returns trigger
language plpgsql set search_path=public as $$
begin
  if TG_TABLE_NAME='rent_adjustments' then
    if TG_OP <> 'INSERT' or current_user <> 'rent_adjustment_writer' then
      raise exception 'adjustment_history_immutable' using errcode='42501';
    end if;
  elsif TG_OP='INSERT' then
    if to_jsonb(NEW)->>TG_ARGV[0] is not null and current_user <> 'rent_adjustment_writer' then
      raise exception 'adjustment_lineage_managed' using errcode='42501';
    end if;
  elsif to_jsonb(NEW)->TG_ARGV[0] is distinct from to_jsonb(OLD)->TG_ARGV[0] then
    raise exception 'adjustment_lineage_immutable' using errcode='42501';
  end if;
  return NEW;
end $$;
create trigger rent_adjustments_immutable before insert or update or delete on public.rent_adjustments
  for each row execute function public._guard_rent_adjustment_history();
create trigger rent_adjustments_audit after insert on public.rent_adjustments
  for each row execute function public._emit_event();
create trigger rent_schedules_lineage before insert or update on public.rent_schedules
  for each row execute function public._guard_rent_adjustment_history('corrects_schedule_id');
create trigger charges_lineage before insert or update on public.charges
  for each row execute function public._guard_rent_adjustment_history('corrects_charge_id');
create trigger allocations_lineage before insert or update on public.payment_allocations
  for each row execute function public._guard_rent_adjustment_history('corrects_allocation_id');
revoke all on function public._guard_rent_adjustment_history() from public,anon,authenticated,service_role;

create function public._rent_adjustment_terms(p_lease public.leases) returns jsonb
language sql immutable set search_path=public as $$
  select jsonb_build_object('term_start',p_lease.term_start,'term_end',p_lease.term_end,
    'rent_amount_cents',p_lease.rent_amount_cents,'rent_currency',p_lease.rent_currency,
    'deposit_amount_cents',p_lease.deposit_amount_cents,'deposit_currency',p_lease.deposit_currency)
$$;
revoke all on function public._rent_adjustment_terms(public.leases) from public,anon,authenticated,service_role;
grant execute on function public._rent_adjustment_terms(public.leases) to authenticated,rent_adjustment_writer;
