begin;

-- Starting-balance correction fixes (ADR-0013 amendment):
-- 1. corrected_at is the insert time, not the transaction start. The insert follows the
--    tenancy's rent_change advisory lock, so "latest correction" is strictly ordered even
--    for several corrections in one transaction.
-- 2. A live (unvoided) opening entry that was soft-deleted is refused with
--    opening_entry_deleted instead of failing on the live-entry unique index: re-entering
--    it would restore money someone removed.
-- 3. With no live entry, a starting amount of 0 (typed 0 with itemize_from, or corrected
--    to 0) can be corrected; the new entry replaces nothing. A non-zero amount with no
--    live entry (a legacy statement, or an entry voided by hand) stays opening_not_in_ledger.
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

alter table public.opening_balance_corrections alter column corrected_at set default clock_timestamp();

do $migration$
declare body text;
begin
  body := pg_get_functiondef('public._apply_opening_correction(uuid,uuid,jsonb)'::regprocedure);
  body := pg_temp.patched(body,
    $old$  select * into old_charge from public.charges where account_id = p_account_id and opening_adoption_id = a.id
    and voided_at is null and deleted_at is null;$old$,
    $new$  if exists (select 1 from public.charges where account_id = p_account_id and opening_adoption_id = a.id
      and voided_at is null and deleted_at is not null)
    or exists (select 1 from public.payments where account_id = p_account_id and opening_adoption_id = a.id
      and voided_at is null and deleted_at is not null) then
    raise exception 'conflict: opening_entry_deleted';
  end if;
  select * into old_charge from public.charges where account_id = p_account_id and opening_adoption_id = a.id
    and voided_at is null and deleted_at is null;$new$);
  body := pg_temp.patched(body,
    $old$  if old_charge.id is null and old_payment.id is null and not exists (
    select 1 from public.opening_balance_corrections c where c.account_id = p_account_id and c.adoption_id = a.id) then
    raise exception 'conflict: opening_not_in_ledger';
  end if;
  select * into cur from public._current_opening(a);$old$,
    $new$  select * into cur from public._current_opening(a);
  if old_charge.id is null and old_payment.id is null and cur.opening_cents <> 0 then
    raise exception 'conflict: opening_not_in_ledger';
  end if;$new$);
  execute body;
end;
$migration$;

notify pgrst, 'reload schema';
commit;
