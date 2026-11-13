begin;

-- Owner-approved correction of a mistyped starting balance ("void and re-enter").
-- DATA FLOW: live opening entry -> its live allocations voided with the reason -> entry
-- voided -> a new opening entry (linked to the one it replaces) for typed amount +
-- receipts answered add_to_owed -> the same payments (or, for a credit, the same
-- charges) re-applied oldest first up to the new amount -> a correction row records
-- who changed what. Nothing is edited in place; anything not re-applied is unapplied
-- credit (or, for a credit that covered charges, those charges are owed again).
create or replace function pg_temp.patched(p_body text, p_anchor text, p_replacement text, p_count integer default 1)
returns text language plpgsql as $$
declare found_count integer := (length(p_body) - length(replace(p_body, p_anchor, ''))) / length(p_anchor);
begin
  if found_count <> p_count then
    raise exception 'migration anchor matched % times, expected %: %', found_count, p_count, p_anchor;
  end if;
  return replace(p_body, p_anchor, p_replacement);
end;
$$;

-- INVARIANT: exactly one live opening entry per adoption; voided ones stay as history.
drop index public.charges_one_per_opening_adoption;
create unique index charges_one_live_per_opening_adoption on public.charges(account_id, opening_adoption_id)
  where opening_adoption_id is not null and voided_at is null;
drop index public.payments_one_per_opening_adoption;
create unique index payments_one_live_per_opening_adoption on public.payments(account_id, opening_adoption_id)
  where opening_adoption_id is not null and voided_at is null;

alter table public.payments
  add column replaces_payment_id uuid,
  add constraint payments_replaces_payment_fk foreign key (account_id, replaces_payment_id)
    references public.payments(account_id, id),
  add constraint payments_replacement_shape check (replaces_payment_id is null or entry_source = 'opening_credit');

create table public.opening_balance_corrections (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete cascade,
  tenancy_id uuid not null,
  adoption_id uuid not null,
  previous_typed_cents bigint not null,
  previous_opening_cents bigint not null,
  typed_cents bigint not null,
  opening_cents bigint not null,
  basis text,
  reason text not null check (length(btrim(reason)) between 1 and 500),
  replaced_charge_id uuid,
  replaced_payment_id uuid,
  new_charge_id uuid,
  new_payment_id uuid,
  allocations jsonb not null default '[]',
  corrected_by uuid not null,
  corrected_at timestamptz not null default now(),
  foreign key (account_id, tenancy_id) references public.tenancies(account_id, id),
  foreign key (account_id, adoption_id) references public.tenancy_adoptions(account_id, id)
);
create index opening_balance_corrections_adoption_idx on public.opening_balance_corrections(account_id, adoption_id, corrected_at);
alter table public.opening_balance_corrections enable row level security;
alter table public.opening_balance_corrections force row level security;
create policy opening_balance_corrections_member_select on public.opening_balance_corrections for select
  using (account_id in (select m.account_id from public.account_members m
    where m.user_id = (select auth.uid()) and m.deleted_at is null));
grant select on public.opening_balance_corrections to authenticated;
create trigger opening_balance_corrections_audit after insert or update or delete on public.opening_balance_corrections
  for each row execute function public._emit_event();
-- Correction rows are written only by the correction command and never change.
create function public._freeze_opening_balance_correction() returns trigger
language plpgsql set search_path = public as $$
begin
  raise exception 'opening balance corrections are immutable' using errcode = '42501';
end;
$$;
revoke all on function public._freeze_opening_balance_correction() from public, anon, authenticated, service_role;
create trigger opening_balance_corrections_freeze before update on public.opening_balance_corrections
  for each row execute function public._freeze_opening_balance_correction();

-- Replacement links are written only by the commands that own them.
create or replace function public._guard_charge_replacement() returns trigger
language plpgsql set search_path = public as $$
begin
  if (tg_op = 'INSERT' and new.replaces_charge_id is not null and current_user not in ('tenancy_date_writer', 'postgres'))
    or (tg_op = 'UPDATE' and new.replaces_charge_id is distinct from old.replaces_charge_id) then
    raise exception 'Replacement charges are written by the tenancy commands' using errcode = '42501';
  end if;
  return new;
end;
$$;
create function public._guard_payment_replacement() returns trigger
language plpgsql set search_path = public as $$
begin
  if (tg_op = 'INSERT' and new.replaces_payment_id is not null and current_user <> 'postgres')
    or (tg_op = 'UPDATE' and new.replaces_payment_id is distinct from old.replaces_payment_id) then
    raise exception 'Replacement payments are written by the correction command' using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke all on function public._guard_payment_replacement() from public, anon, authenticated, service_role;
create trigger payments_guard_replacement before insert or update of replaces_payment_id on public.payments
  for each row execute function public._guard_payment_replacement();

-- Materialize targets the live-entry index.
do $migration$
declare body text;
begin
  body := pg_get_functiondef('public._materialize_opening_balance(public.tenancy_adoptions)'::regprocedure);
  body := pg_temp.patched(body, 'on conflict (account_id, opening_adoption_id) where opening_adoption_id is not null do nothing',
    'on conflict (account_id, opening_adoption_id) where opening_adoption_id is not null and voided_at is null do nothing', 2);
  execute body;
end;
$migration$;

-- The amount the landlord last typed and the opening entry it produced.
create function public._current_opening(p_adoption public.tenancy_adoptions)
returns table(typed_cents bigint, opening_cents bigint, added_cents bigint)
language sql stable set search_path = public as $$
  with latest as (
    select c.typed_cents, c.opening_cents from public.opening_balance_corrections c
    where c.account_id = p_adoption.account_id and c.adoption_id = p_adoption.id
    order by c.corrected_at desc, c.id desc limit 1
  ),
  added as (
    select coalesce(sum((e->>'amount_cents')::bigint) filter (where e->>'choice' = 'add_to_owed'), 0)::bigint as cents
    from jsonb_array_elements(coalesce(p_adoption.earlier_receipts, '[]')) e
  )
  select coalesce((select l.typed_cents from latest l), p_adoption.typed_opening_cents, p_adoption.opening_balance_cents),
    coalesce((select l.opening_cents from latest l), p_adoption.opening_balance_cents),
    (select cents from added)
$$;
revoke all on function public._current_opening(public.tenancy_adoptions) from public, anon;
grant execute on function public._current_opening(public.tenancy_adoptions) to authenticated, service_role;

create function public._apply_opening_correction(p_account_id uuid, p_tenancy_id uuid, p_payload jsonb)
returns jsonb language plpgsql set search_path = public as $$
declare
  a public.tenancy_adoptions;
  cur record;
  old_charge public.charges;
  old_payment public.payments;
  new_charge_id uuid;
  new_payment_id uuid;
  new_typed bigint := (p_payload->>'amount_cents')::bigint;
  new_opening bigint;
  basis text := nullif(btrim(coalesce(p_payload->>'basis', '')), '');
  reason text := btrim(coalesce(p_payload->>'reason', ''));
  marker text;
  owed_before jsonb;
  owed_after jsonb;
  moves jsonb := '[]';
  left_cents bigint;
  applied bigint;
  alloc record;
  correction_id uuid;
begin
  if p_payload - array['amount_cents','basis','reason'] <> '{}' or coalesce(jsonb_typeof(p_payload->'amount_cents'), '') <> 'number'
    or length(reason) not between 1 and 500 or (basis is not null and length(basis) > 200)
    or (new_typed <> 0 and basis is null) then
    raise exception 'invalid: send the corrected amount, a reason, and what the amount is for unless it is 0';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('rent_change:'||p_tenancy_id::text, 0));
  select * into a from public.tenancy_adoptions where account_id = p_account_id and tenancy_id = p_tenancy_id
    and deleted_at is null;
  if not found then raise exception 'not_found: no starting balance for this tenancy' using errcode = 'P0002'; end if;
  if not exists (select 1 from public.accounts where id = p_account_id and opening_balance_ledger_enabled) then
    raise exception 'conflict: opening_ledger_disabled';
  end if;
  select * into old_charge from public.charges where account_id = p_account_id and opening_adoption_id = a.id
    and voided_at is null and deleted_at is null;
  select * into old_payment from public.payments where account_id = p_account_id and opening_adoption_id = a.id
    and voided_at is null and deleted_at is null;
  if old_charge.id is null and old_payment.id is null and not exists (
    select 1 from public.opening_balance_corrections c where c.account_id = p_account_id and c.adoption_id = a.id) then
    raise exception 'conflict: opening_not_in_ledger';
  end if;
  select * into cur from public._current_opening(a);
  new_opening := new_typed + cur.added_cents;
  if new_typed = cur.typed_cents then raise exception 'invalid: opening_unchanged'; end if;
  marker := 'Starting balance corrected: ' || reason;
  select to_jsonb(s) into owed_before from public.owed_summaries(p_account_id, p_tenancy_id) s where s.currency = a.currency;

  -- Release what the old entry carried, then void it.
  create temporary table if not exists opening_correction_moves(
    ord integer, allocation_id uuid, payment_id uuid, charge_id uuid, amount_cents bigint) on commit drop;
  truncate opening_correction_moves;
  if old_charge.id is not null then
    insert into opening_correction_moves
      select row_number() over (order by p.received_at nulls first, p.created_at, x.created_at)::integer,
        x.id, x.payment_id, x.charge_id, x.amount_cents
      from public.payment_allocations x join public.payments p on p.account_id = x.account_id and p.id = x.payment_id
      where x.account_id = p_account_id and x.charge_id = old_charge.id and x.voided_at is null and x.deleted_at is null
        and p.voided_at is null and p.deleted_at is null;
  elsif old_payment.id is not null then
    insert into opening_correction_moves
      select row_number() over (order by c.due_date, c.created_at, x.created_at)::integer,
        x.id, x.payment_id, x.charge_id, x.amount_cents
      from public.payment_allocations x join public.charges c on c.account_id = x.account_id and c.id = x.charge_id
      where x.account_id = p_account_id and x.payment_id = old_payment.id and x.voided_at is null and x.deleted_at is null
        and c.voided_at is null and c.deleted_at is null;
  end if;
  update public.payment_allocations set voided_at = now(), void_reason = marker
    where account_id = p_account_id and id in (select allocation_id from opening_correction_moves);
  if old_charge.id is not null then
    update public.charges set voided_at = clock_timestamp(), void_reason = marker, updated_at = clock_timestamp()
      where account_id = p_account_id and id = old_charge.id;
  end if;
  if old_payment.id is not null then
    update public.payments set voided_at = clock_timestamp(), void_reason = marker, updated_at = clock_timestamp()
      where account_id = p_account_id and id = old_payment.id;
  end if;

  -- The new opening entry, linked to what it replaces.
  if new_opening > 0 then
    insert into public.charges(account_id, tenancy_id, type, amount_cents, currency, due_date, description,
      opening_adoption_id, opening_category, replaces_charge_id)
    values (p_account_id, p_tenancy_id, 'opening_balance', new_opening, a.currency, coalesce(a.opening_on, a.adoption_date),
      'Entered at setup (corrected)', a.id,
      case lower(coalesce(basis, old_charge.opening_category, ''))
        when 'rent' then 'rent' when 'fees' then 'fees' when 'utilities' then 'utilities'
        when 'several' then 'mixed' when 'mixed' then 'mixed' else 'unspecified' end,
      old_charge.id)
    returning id into new_charge_id;
  elsif new_opening < 0 then
    insert into public.payments(account_id, tenancy_id, amount_cents, currency, method, received_at, receipt_date_unknown,
      entry_source, opening_adoption_id, opening_credit_on, replaces_payment_id)
    values (p_account_id, p_tenancy_id, -new_opening, a.currency, null, null, true, 'opening_credit', a.id,
      coalesce(a.opening_on, a.adoption_date), old_payment.id)
    returning id into new_payment_id;
  end if;

  -- Re-apply the same money oldest first, up to the new amount.
  left_cents := abs(new_opening);
  for alloc in select * from opening_correction_moves order by ord loop
    applied := 0;
    if new_charge_id is not null and old_charge.id is not null then
      applied := least(left_cents, alloc.amount_cents);
      if applied > 0 then
        insert into public.payment_allocations(account_id, payment_id, charge_id, amount_cents)
        values (p_account_id, alloc.payment_id, new_charge_id, applied);
      end if;
    elsif new_payment_id is not null and old_payment.id is not null then
      applied := least(left_cents, alloc.amount_cents);
      if applied > 0 then
        insert into public.payment_allocations(account_id, payment_id, charge_id, amount_cents)
        values (p_account_id, new_payment_id, alloc.charge_id, applied);
      end if;
    end if;
    left_cents := left_cents - applied;
    moves := moves || jsonb_build_array(jsonb_build_object('allocation_id', alloc.allocation_id,
      'payment_id', alloc.payment_id, 'charge_id', alloc.charge_id, 'amount_cents', alloc.amount_cents,
      'moved_cents', applied, 'released_cents', alloc.amount_cents - applied));
  end loop;

  insert into public.opening_balance_corrections(account_id, tenancy_id, adoption_id, previous_typed_cents,
    previous_opening_cents, typed_cents, opening_cents, basis, reason, replaced_charge_id, replaced_payment_id,
    new_charge_id, new_payment_id, allocations, corrected_by)
  values (p_account_id, p_tenancy_id, a.id, cur.typed_cents, cur.opening_cents, new_typed, new_opening, basis, reason,
    old_charge.id, old_payment.id, new_charge_id, new_payment_id, moves, auth.uid())
  returning id into correction_id;
  select to_jsonb(s) into owed_after from public.owed_summaries(p_account_id, p_tenancy_id) s where s.currency = a.currency;
  return jsonb_build_object('correction_id', correction_id, 'adoption_id', a.id, 'currency', a.currency,
    'previous', jsonb_build_object('typed_cents', cur.typed_cents, 'opening_cents', cur.opening_cents,
      'entry', case when old_charge.id is not null then jsonb_build_object('kind', 'charge', 'id', old_charge.id)
        when old_payment.id is not null then jsonb_build_object('kind', 'credit', 'id', old_payment.id)
        else jsonb_build_object('kind', 'none', 'id', null) end),
    'next', jsonb_build_object('typed_cents', new_typed, 'opening_cents', new_opening, 'added_receipts_cents', cur.added_cents,
      'entry', case when new_charge_id is not null then jsonb_build_object('kind', 'charge', 'id', new_charge_id)
        when new_payment_id is not null then jsonb_build_object('kind', 'credit', 'id', new_payment_id)
        else jsonb_build_object('kind', 'none', 'id', null) end),
    'allocations', moves, 'owed_before', owed_before, 'owed_after', owed_after);
end;
$$;
revoke all on function public._apply_opening_correction(uuid,uuid,jsonb) from public, anon, authenticated, service_role;

-- SECURITY: owner-owned to write opening entries (provenance guard) under a live
-- owner/manager check; preview runs the same correction and rolls it back.
create function public.preview_opening_balance_correction(p_account_id uuid, p_tenancy_id uuid, p_payload jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare result jsonb;
begin
  if auth.uid() is null or not exists (select 1 from public.account_members m where m.account_id = p_account_id
    and m.user_id = auth.uid() and m.deleted_at is null and m.role in ('owner','manager')) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  begin
    result := public._apply_opening_correction(p_account_id, p_tenancy_id, p_payload) - 'correction_id';
    raise exception 'opening_correction_preview' using errcode = 'P0099';
  exception when sqlstate 'P0099' then null;
  end;
  return result;
end;
$$;
revoke all on function public.preview_opening_balance_correction(uuid,uuid,jsonb) from public, anon;
grant execute on function public.preview_opening_balance_correction(uuid,uuid,jsonb) to authenticated;

create function public.correct_opening_balance(p_account_id uuid, p_tenancy_id uuid, p_payload jsonb,
  p_idempotency_key text, p_request_fingerprint text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare k public.idempotency_keys; result jsonb;
begin
  if auth.uid() is null or not exists (select 1 from public.account_members m where m.account_id = p_account_id
    and m.user_id = auth.uid() and m.deleted_at is null and m.role in ('owner','manager')) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  select * into k from public.idempotency_keys where account_id = p_account_id and key = p_idempotency_key for update;
  if not found or k.request_fingerprint is distinct from p_request_fingerprint then
    raise exception 'invalid: idempotency claim missing or mismatched';
  end if;
  if k.completed_at is not null then return k.body; end if;
  result := public._apply_opening_correction(p_account_id, p_tenancy_id, p_payload);
  update public.idempotency_keys set status_code = 200, body = result, completed_at = clock_timestamp()
    where account_id = p_account_id and key = p_idempotency_key;
  return result;
end;
$$;
revoke all on function public.correct_opening_balance(uuid,uuid,jsonb,text,text) from public, anon;
grant execute on function public.correct_opening_balance(uuid,uuid,jsonb,text,text) to authenticated;

-- The rent roll's adoption block shows the latest corrected starting amount.
do $migration$
declare body text;
begin
  body := pg_get_functiondef('public.rent_rollup(uuid,text[],date)'::regprocedure);
  body := pg_temp.patched(body, $old$      'opening_balance_cents',
      a.opening_balance_cents,'recorded_in_ledger',($old$,
    $new$      'opening_balance_cents',
      coalesce((select c.opening_cents from public.opening_balance_corrections c where c.account_id=a.account_id
        and c.adoption_id=a.id order by c.corrected_at desc, c.id desc limit 1), a.opening_balance_cents),
      'recorded_in_ledger',($new$);
  execute body;
end;
$migration$;

notify pgrst, 'reload schema';
commit;
