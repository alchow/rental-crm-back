-- ----------------------------------------------------------------------------
-- Automatic rent charging becomes the DEFAULT: opt-out, not opt-in.
--
-- WHAT CHANGED SINCE 20260704000002
-- That migration made auto_charge_enabled default FALSE for one concrete
-- reason, stated in its own header: bulk import had already written
-- rent_schedules rows for accounts that never asked to be billed, so a
-- fleet-wide cron would have surprise-billed them. The safeguard was correct
-- for that moment and is now the wrong default:
--
--   * The bulk-import cohort it protected no longer exists. Every live account
--     that has a rent schedule today created it deliberately in the product,
--     and both of them already have auto_charge_enabled = true. Every account
--     still carrying the false default has ZERO live rent schedules -- so this
--     backfill changes no billing behaviour for anyone today. It only changes
--     what happens the next time somebody records a schedule.
--   * Default-false made the money surface lie by omission. A landlord records
--     "rent is $2,000 on the 1st" and reasonably expects the rent to be billed;
--     instead the ledger stayed empty until they found a settings switch they
--     had no reason to look for. Recording the schedule IS the instruction to
--     bill; declining to bill is the deliberate act, so declining is what needs
--     the explicit flip.
--
-- WHAT THIS MIGRATION DOES NOT CHANGE
-- The flag still gates billing in both places that can trigger it (the cron
-- runner's enumeration and generate_rent_charges' own re-check), the generator
-- still only mints a charge where a LIVE rent schedule covers the period, and
-- it still never backfills past periods. A flag-on account with no schedule is
-- billed exactly nothing. Turning the default on widens WHO the generator will
-- consider; it does not widen WHAT it will bill.
--
-- ORDER IS LOAD-BEARING
-- The backfill runs BEFORE the default flip and is guarded on the column
-- default not yet reading 'true'. That makes the statement safe to re-run (a
-- second application is a no-op) and, more importantly, correct whenever prod
-- applies it: an account created between merge and apply still gets the old
-- default false and is swept by the same pass. A hard-coded created_at cutoff
-- would have silently stranded exactly those accounts.
--
-- AUDIT
-- accounts is an audited table (trigger accounts_audit -> _emit_event), so the
-- backfill emits one 'updated' event per touched account. auth.uid() is null in
-- a migration session, so _emit_event falls back to current_setting('audit.actor')
-- -- we set it explicitly rather than let it default to the bare 'system', so
-- the chain names WHICH mechanical writer flipped the flag. Chain integrity is
-- unaffected: the trigger hashes the row snapshot at write time (ADR-0008).
-- ----------------------------------------------------------------------------

-- ============================================================================
-- (1) Backfill the existing fleet -- guarded, so re-application is a no-op
-- ============================================================================
--
-- Guard: only sweep while the column default is NOT yet the new 'true'. On a
-- second run step (2) below has already set it, so this block does nothing --
-- a landlord who deliberately opted OUT after the first application is never
-- silently re-enabled. The comparison is written "not yet true" rather than
-- "still false" so an unexpected rendering of the old default can only make
-- the first-run backfill happen, never make it silently skip.
do $$
declare
  v_default text;
  v_touched bigint;
begin
  select c.column_default
    into v_default
    from information_schema.columns c
   where c.table_schema = 'public'
     and c.table_name   = 'accounts'
     and c.column_name  = 'auto_charge_enabled';

  if v_default is distinct from 'true' then
    -- Honest mechanical actor on the emitted audit events (transaction-local).
    -- accounts is audited; auth.uid() is null here, so _emit_event falls back
    -- to this instead of the bare 'system'.
    perform set_config('audit.actor', 'system:migration:20260801000001_auto_charge_default_on', true);

    update public.accounts
       set auto_charge_enabled = true,
           updated_at          = now()
     where auto_charge_enabled = false
       and deleted_at is null;

    get diagnostics v_touched = row_count;

    -- Clear the override again: if the migration runner shares one transaction
    -- across several files, a leftover audit.actor would misattribute the NEXT
    -- migration's audited writes to this one. _emit_event reads it with
    -- nullif(..., ''), so an empty string falls back to the generic 'system'.
    perform set_config('audit.actor', '', true);

    raise notice 'auto_charge_default_on: switched % account(s) on', v_touched;
  else
    raise notice 'auto_charge_default_on: default already true, backfill skipped';
  end if;
end
$$;

-- ============================================================================
-- (2) The new default for every account created from here on
-- ============================================================================
--
-- Catalog-only change (no table rewrite). create_account_for_new_user does not
-- name this column in its INSERT, so the column DEFAULT is what governs every
-- signup -- no API change is needed to make new accounts bill.
alter table public.accounts
  alter column auto_charge_enabled set default true;

-- ============================================================================
-- (3) Rewrite the column comment -- the old one documents the old default
-- ============================================================================
comment on column public.accounts.auto_charge_enabled is
  'Automatic rent-charge switch. Default TRUE since 2026-08-01 (amendment to '
  'ADR-0011): a landlord who records a rent schedule expects the rent to be '
  'billed, so billing is the default and opting OUT is the deliberate act. A '
  'charge is still only minted where a live rent schedule covers the period, so '
  'a flag-on account with no schedule is billed nothing. Per-account opt-out '
  'via PATCH /v1/accounts/{accountId}/settings (owner/manager only: RLS policy '
  'accounts_manager_update + the column-level UPDATE grant); '
  'generate_rent_charges returns the empty set for any account where this is '
  'false.';
