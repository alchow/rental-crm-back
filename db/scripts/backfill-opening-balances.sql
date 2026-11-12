-- Run with psql -v account_id=<account uuid>. The default reports then rolls back.
-- Pass -v apply=on after reconciling on a restored copy.
-- Report: per adoption, ledger (charges - receipts) before and after in the adoption's
-- currency, the stated starting amount, and the unapplied credit left in that currency
-- (a payment that was meant for the starting balance needs allocating by hand).
\set ON_ERROR_STOP on
\if :{?apply}
\else
\set apply off
\endif
begin;
set local audit.actor = 'system:migration:opening-balance';
select set_config('app.opening_backfill_account', :'account_id', true);

-- Match the tenancy writer lock and acquire it before the account flag.
select pg_advisory_xact_lock(hashtextextended('rent_change:' || t.id::text, 0))
from public.tenancies t
where t.account_id = :'account_id'::uuid
order by t.id;
update public.accounts set opening_balance_ledger_enabled = true
where id = :'account_id'::uuid and deleted_at is null;

create temporary table opening_balance_report (
  tenancy_id uuid, adoption_id uuid, currency text, before_ledger_cents bigint,
  statement_cents bigint, after_ledger_cents bigint, unapplied_credit_cents bigint
) on commit drop;

do $$
declare
  a public.tenancy_adoptions;
  before_cents bigint;
  after_cents bigint;
  credit_cents bigint;
begin
  for a in
    select source.* from public.tenancy_adoptions source
    join public.tenancies t on t.account_id = source.account_id and t.id = source.tenancy_id and t.deleted_at is null
    where source.account_id = current_setting('app.opening_backfill_account')::uuid
      and source.deleted_at is null and source.opening_balance_cents <> 0
      and not exists(select 1 from public.charges c where c.account_id = source.account_id and c.opening_adoption_id = source.id)
      and not exists(select 1 from public.payments p where p.account_id = source.account_id and p.opening_adoption_id = source.id)
    order by source.tenancy_id, source.id
  loop
    select coalesce((select sum(c.amount_cents) from public.charges c
        where (c.account_id,c.tenancy_id,c.currency) = (a.account_id,a.tenancy_id,a.currency)
        and c.deleted_at is null and c.voided_at is null),0)
      - coalesce((select sum(p.amount_cents) from public.payments p
        where (p.account_id,p.tenancy_id,p.currency) = (a.account_id,a.tenancy_id,a.currency)
        and p.deleted_at is null and p.voided_at is null),0)
      into before_cents;
    perform public._materialize_opening_balance(a);
    select coalesce((select sum(c.amount_cents) from public.charges c
        where (c.account_id,c.tenancy_id,c.currency) = (a.account_id,a.tenancy_id,a.currency)
        and c.deleted_at is null and c.voided_at is null),0)
      - coalesce((select sum(p.amount_cents) from public.payments p
        where (p.account_id,p.tenancy_id,p.currency) = (a.account_id,a.tenancy_id,a.currency)
        and p.deleted_at is null and p.voided_at is null),0)
      into after_cents;
    if before_cents + a.opening_balance_cents <> after_cents then
      raise exception 'Opening balance reconciliation failed for tenancy %', a.tenancy_id;
    end if;
    select coalesce((select sum(p.amount_cents) from public.payments p
        where (p.account_id,p.tenancy_id,p.currency) = (a.account_id,a.tenancy_id,a.currency)
        and p.deleted_at is null and p.voided_at is null),0)
      - coalesce((select sum(al.amount_cents) from public.payment_allocations al
        join public.payments p on p.account_id = al.account_id and p.id = al.payment_id
        join public.charges c on c.account_id = al.account_id and c.id = al.charge_id
        where (p.account_id,p.tenancy_id,p.currency) = (a.account_id,a.tenancy_id,a.currency)
        and al.voided_at is null and al.deleted_at is null and p.voided_at is null and p.deleted_at is null
        and c.voided_at is null and c.deleted_at is null),0)
      into credit_cents;
    insert into opening_balance_report values
      (a.tenancy_id, a.id, a.currency, before_cents, a.opening_balance_cents, after_cents, credit_cents);
  end loop;
end $$;
table opening_balance_report;
\if :apply
commit;
\else
rollback;
\endif
