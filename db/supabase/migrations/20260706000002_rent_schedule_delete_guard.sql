-- ----------------------------------------------------------------------------
-- Rent-schedule soft-delete guard: a schedule with LIVE charges cannot be
-- deleted. (ADR-0012 corrections-policy follow-up; companion of the API's new
-- DELETE /rent-schedules/{id} endpoint.)
--
-- WHY
-- ---
-- ADR-0012's corrections policy says a never-billed mistaken schedule is fixed
-- by "soft-delete and recreate" -- but until now nothing could soft-delete a
-- rent_schedule: the API had no DELETE route, and change_tenancy_rent's
-- future-schedule 409 ("resolve it first") therefore had no client-reachable
-- resolution. The API gains that DELETE route in this change.
--
-- The DB half is this guard. Two reasons it must live here and not only in the
-- API pre-check:
--
--   (1) RACE: the API checks "no live charges" and then soft-deletes in a
--       second statement. A charge can land between the two (manual create, or
--       the daily generator). The BEFORE trigger re-checks at write time inside
--       the deleting transaction, which shrinks that window from
--       two-HTTP-round-trips to the trigger-to-commit instant. It cannot close
--       it entirely against the GENERATOR specifically (the generator
--       serializes per ACCOUNT, this table's guard per TENANCY -- different
--       advisory keys), but the residue is benign: an orphaned live charge
--       stays payable, and the drift sweep flags the tenancy loudly on the
--       next run.
--   (2) DIRECT PATH: rent_schedules carries the FOR ALL member policy
--       (rent_schedules_member_all, phase 2), so an authenticated member can
--       UPDATE deleted_at straight through PostgREST without touching the API.
--       Until this migration NOTHING blocked that write; a member could orphan
--       live charges (billed rows whose schedule provenance points at a
--       deleted-looking era) with one direct PATCH. Same layering argument as
--       _rent_schedules_guard: enforce at the layer that catches every path.
--
-- WHAT counts as live: a charge referencing the schedule with voided_at null
-- and deleted_at null. Voided charges do NOT block deletion -- the corrections
-- flow is precisely "void the advance charges, then delete the schedule".
-- History-preserving deletes of a billed era are refused; a billed era is
-- ended (end_date), never deleted, exactly as ADR-0012's already-billed
-- correction path prescribes.
--
-- errcode check_violation (23514) + a "cannot be deleted" message, following
-- the _reject_anchored_* idiom from 20260706000001: the API tells this apart
-- from coherence 23514s (which map to 400) by matching the message, and maps
-- it to 409 conflict.
--
-- Chain compatibility (ADR-0008): no schema change, no new columns -- a
-- BEFORE trigger that only ever aborts. Nothing to re-hash or backfill.
-- ----------------------------------------------------------------------------

create or replace function public._reject_schedule_delete_with_live_charges()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  -- Only the soft-delete transition is guarded. end_date edits, re-opens
  -- (end_date -> null), amount-preserving column writes and the RPC's own era
  -- rotation all pass through untouched.
  if OLD.deleted_at is null and NEW.deleted_at is not null then
    if exists (
      select 1
        from public.charges ch
       where ch.account_id         = OLD.account_id
         and ch.source_schedule_id = OLD.id
         and ch.voided_at is null
         and ch.deleted_at is null
    ) then
      raise exception 'rent schedule % has live charges and cannot be deleted; void them first', OLD.id
        using errcode = 'check_violation';
    end if;
  end if;
  return NEW;
end;
$$;

-- SECURITY INVOKER (default): the member's own RLS shows them their account's
-- charges, so the existence check resolves for the PostgREST path;
-- service_role bypasses RLS and sees everything -- same note as
-- _rent_schedules_guard (20260706000001).
--
-- BEFORE-row triggers fire in name order: rent_schedules_guard sorts before
-- rent_schedules_reject_delete_with_live_charges ('guard' < 'reject'), so the
-- per-tenancy advisory lock is already held when this fires -- the live-charge
-- check is serialized against any in-flight change_tenancy_rent (and any other
-- schedule write) for the same tenancy.
drop trigger if exists rent_schedules_reject_delete_with_live_charges on public.rent_schedules;
create trigger rent_schedules_reject_delete_with_live_charges
  before update on public.rent_schedules
  for each row execute function public._reject_schedule_delete_with_live_charges();
