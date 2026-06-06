-- ----------------------------------------------------------------------------
-- Phase 6.1: payment + inline allocations are atomic.
--
-- The Phase 6 route did two writes (payments INSERT, then allocations
-- INSERT) sequentially. If the allocations INSERT was rejected (over-alloc,
-- cross-tenancy, currency mismatch...), the payment row was left orphaned
-- -- money in limbo. The 5xx → delete-placeholder retry semantics of the
-- idempotency middleware also relied on atomic handler writes; without
-- this fix, a 5xx-then-retry could double-write the payment.
--
-- Fix: wrap the two writes in ONE Postgres function (one transaction). If
-- any allocation's _assert_allocation_integrity check fails, the function
-- aborts and the entire transaction -- including the payment INSERT --
-- rolls back. No phantom payment row possible.
--
-- Also tighten amount-positive checks: 0 is meaningless for a charge, a
-- payment, or an allocation. rent_schedules keeps >= 0 (a "free rent" promo
-- schedule is a valid record).
-- ----------------------------------------------------------------------------

-- ============================================================================
-- 1. amount_cents must be strictly positive on the money-row tables
-- ============================================================================

do $$
declare c text;
begin
  for c in
    select conname
      from pg_constraint
     where conrelid = 'public.charges'::regclass
       and contype  = 'c'
       and pg_get_constraintdef(oid) like '%amount_cents >= 0%'
  loop
    execute format('alter table public.charges drop constraint %I', c);
  end loop;
  for c in
    select conname
      from pg_constraint
     where conrelid = 'public.payments'::regclass
       and contype  = 'c'
       and pg_get_constraintdef(oid) like '%amount_cents >= 0%'
  loop
    execute format('alter table public.payments drop constraint %I', c);
  end loop;
  for c in
    select conname
      from pg_constraint
     where conrelid = 'public.payment_allocations'::regclass
       and contype  = 'c'
       and pg_get_constraintdef(oid) like '%amount_cents >= 0%'
  loop
    execute format('alter table public.payment_allocations drop constraint %I', c);
  end loop;
end $$;

alter table public.charges
  add constraint charges_amount_cents_positive check (amount_cents > 0);
alter table public.payments
  add constraint payments_amount_cents_positive check (amount_cents > 0);
alter table public.payment_allocations
  add constraint payment_allocations_amount_cents_positive check (amount_cents > 0);

-- ============================================================================
-- 2. create_payment_with_allocations: payment + N allocations in one txn
-- ============================================================================
--
-- SECURITY DEFINER so the inserts bypass RLS, BUT we explicitly verify
-- is_account_member(auth.uid(), p_account_id) inside the function -- the
-- definer privilege is used to reach the tables, not to skip the membership
-- check. Any allocation that trips the integrity trigger aborts the whole
-- function and Postgres rolls back the payment INSERT too.

create or replace function public.create_payment_with_allocations(
  p_account_id      uuid,
  p_tenancy_id      uuid,
  p_amount_cents    bigint,
  p_currency        text,
  p_received_at     timestamptz,
  p_method          text,
  p_reference       text,
  p_payer_tenant_id uuid,
  p_notes           text,
  p_allocations     jsonb
)
returns table (
  payment     jsonb,
  allocations jsonb
)
language plpgsql
security definer
set search_path = public, extensions, auth
as $$
declare
  v_user_id  uuid := auth.uid();
  v_payment  public.payments%rowtype;
  v_allocs   jsonb;
begin
  if v_user_id is null then
    raise exception 'no authenticated user' using errcode = '28000';
  end if;
  -- Belt-and-braces: the route's middleware already verified membership,
  -- but a direct RPC call from elsewhere would skip that. SECURITY DEFINER
  -- means we have to do this check ourselves.
  if not public.is_account_member(p_account_id) then
    raise exception 'not a member of account %', p_account_id
      using errcode = '42501';
  end if;

  insert into public.payments
    (account_id, tenancy_id, amount_cents, currency, received_at, method,
     reference, payer_tenant_id, notes)
  values
    (p_account_id, p_tenancy_id, p_amount_cents, p_currency, p_received_at, p_method,
     p_reference, p_payer_tenant_id, p_notes)
  returning *
  into v_payment;

  -- Insert all allocations in one statement. The
  -- _assert_allocation_integrity trigger runs per row; ANY rejection
  -- here raises and aborts the entire function, rolling back the payment.
  with new_allocs as (
    insert into public.payment_allocations
      (account_id, payment_id, charge_id, amount_cents)
    select
      p_account_id,
      v_payment.id,
      (a->>'charge_id')::uuid,
      (a->>'amount_cents')::bigint
    from jsonb_array_elements(coalesce(p_allocations, '[]'::jsonb)) as a
    returning *
  )
  select coalesce(jsonb_agg(to_jsonb(new_allocs.*)), '[]'::jsonb)
    into v_allocs
    from new_allocs;

  payment     := to_jsonb(v_payment);
  allocations := v_allocs;
  return next;
end;
$$;

grant execute on function public.create_payment_with_allocations(
  uuid, uuid, bigint, text, timestamptz, text, text, uuid, text, jsonb
) to authenticated;
