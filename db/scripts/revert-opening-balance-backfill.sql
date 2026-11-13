-- Use only the adoption IDs from the original backfill report for this account.
-- psql -v account_id=<account UUID> -v adoption_ids='{<uuid>,<uuid>}'
-- Refuses entries written at setup (same transaction as their adoption), entries
-- with any ledger activity, and IDs outside the account. Turning the flag off also
-- stops the generator honouring "this month's rent is included"; adoptions that
-- answered yes this month are listed as warnings so their rent can be checked.
\set ON_ERROR_STOP on
begin;
set local audit.actor = 'system:migration:opening-balance-revert';
select set_config('app.opening_backfill_account', :'account_id', true);
select set_config('app.opening_backfill_adoptions', :'adoption_ids', true);

select pg_advisory_xact_lock(hashtextextended('rent_change:' || t.id::text, 0))
from public.tenancies t
where t.account_id = :'account_id'::uuid
order by t.id;
update public.accounts set opening_balance_ledger_enabled = false
where id = :'account_id'::uuid and deleted_at is null;

do $$
declare
  account uuid := current_setting('app.opening_backfill_account')::uuid;
  adoption_ids uuid[] := current_setting('app.opening_backfill_adoptions')::uuid[];
  included record;
begin
  if coalesce(cardinality(adoption_ids),0) = 0 then
    raise exception 'Pass the adoption IDs from the backfill report';
  end if;
  if exists (
    select 1 from unnest(adoption_ids) as requested(id)
    where not exists (
      select 1 from public.tenancy_adoptions a
      where a.account_id=account and a.id=requested.id and a.deleted_at is null
    )
  ) then raise exception 'Backfill IDs do not all belong to this account'; end if;
  -- PROVENANCE: setup writes its entry in the adoption's transaction, so an entry
  -- created no later than its adoption did not come from the backfill.
  if exists (
    select 1 from public.tenancy_adoptions a
    where a.account_id=account and a.id=any(adoption_ids) and (
      exists(select 1 from public.charges c where c.account_id=a.account_id and c.opening_adoption_id=a.id and c.created_at<=a.created_at)
      or exists(select 1 from public.payments p where p.account_id=a.account_id and p.opening_adoption_id=a.id and p.created_at<=a.created_at))
  ) then raise exception 'An entry was written at setup, not by the backfill. Remove its adoption ID.'; end if;
  if exists (
    select 1 from public.charges c where c.account_id=account and c.opening_adoption_id=any(adoption_ids)
    and (c.voided_at is not null or c.deleted_at is not null or exists(
      select 1 from public.payment_allocations a where a.account_id=c.account_id and a.charge_id=c.id)
      or exists(select 1 from public.charges f where f.account_id=c.account_id and f.parent_charge_id=c.id))
  ) or exists (
    select 1 from public.payments p where p.account_id=account and p.opening_adoption_id=any(adoption_ids)
    and (p.voided_at is not null or p.deleted_at is not null or exists(
      select 1 from public.payment_allocations a where a.account_id=p.account_id and a.payment_id=p.id))
  ) then
    raise exception 'A starting entry already has ledger activity. Review the affected ledger before reversing.';
  end if;
  for included in
    select a.tenancy_id, a.id from public.tenancy_adoptions a
    where a.account_id=account and a.deleted_at is null and a.includes_current_rent
      and date_trunc('month',a.adoption_date) = date_trunc('month',public._account_date(account))
  loop
    raise warning 'Tenancy % (adoption %) said this month''s rent is included; the generator may now bill it.',
      included.tenancy_id, included.id;
  end loop;
end;
$$;

delete from public.charges where account_id=:'account_id'::uuid
  and opening_adoption_id=any(:'adoption_ids'::uuid[])
returning tenancy_id,opening_adoption_id,amount_cents,currency;
delete from public.payments where account_id=:'account_id'::uuid
  and opening_adoption_id=any(:'adoption_ids'::uuid[])
returning tenancy_id,opening_adoption_id,-amount_cents as signed_amount_cents,currency;
commit;
