-- ----------------------------------------------------------------------------
-- Interactions: 'classify' correction kind + 'unspecified' party_type sentinel.
--
-- Product context: one-tap Log drops the required "Who" at capture; attribution
-- is completed later. Forcing that completion through 'amend' is wrong -- an
-- amend means "the content/account changed" and re-states the body, so attaching
-- a tenant after the fact makes an honest record read as edited. 'classify' is
-- the metadata-completion correction: append-only like amend, but body- and
-- occurred_at-immutable, and FILL-ONLY (it may populate an empty field, never
-- overwrite a recorded one -- overwriting a stated fact stays an amend).
--
-- Two pieces:
--   1. correction_kind gains 'classify'.
--   2. party_type gains 'unspecified' -- the capture sentinel for "a real
--      counterparty whose ROLE is not yet known" (tenant vs vendor). This is
--      distinct from "role known, person unknown", which is already expressible
--      as party_type='tenant', party_id=null. 'unspecified' is communication-
--      only and cannot carry a resolved party_id (you can't know the id of
--      someone whose role you don't know). classify later fills it to a concrete
--      role, resolving party_type + party_id atomically.
--
-- The append-only guarantee is untouched: a classify row is just another
-- immutable INSERT, sealed by the events hash-chain (phase3_audit) like any
-- other. The fill-only rule is DB-enforced (trigger below) so it holds even
-- under a direct write -- the same evidence-grade bar as the linear-chain index
-- and the composite FK on this table.
-- ----------------------------------------------------------------------------

-- 1. the new correction kind ------------------------------------------------
alter table public.interactions drop constraint interactions_correction_kind_check;
alter table public.interactions add constraint interactions_correction_kind_check
  check (correction_kind in ('amend', 'retract', 'classify'));

-- 2. the capture sentinel ----------------------------------------------------
alter table public.interactions drop constraint interactions_party_type_check;
alter table public.interactions add constraint interactions_party_type_check
  check (party_type in ('tenant', 'vendor', 'inspector', 'other', 'none', 'unspecified'));

-- 2a. coherence: an unknown role cannot carry a resolved id. Holds for EVERY
--     row (capture AND classify), so it is a table CHECK, not just the trigger.
alter table public.interactions add constraint interactions_unspecified_party_no_id
  check (party_type <> 'unspecified' or party_id is null);

-- 2b. 'unspecified' is communication-only. Notes/agent_events keep party_type
--     'none' (interactions_note_fields already pins channel='note' to 'none';
--     the agent firewall + handler pin agent_events to 'none').
alter table public.interactions add constraint interactions_unspecified_comm_only
  check (party_type <> 'unspecified' or kind = 'communication');

-- 3. fill-only backstop for classify ----------------------------------------
-- Rejects, at write time, any classify row that (a) changes body/occurred_at
-- (substantive -> amend), (b) overwrites a context field already set on the
-- corrected row, or (c) attaches a party_id without resolving the role. The API
-- validates the same rules first and returns a clean 400; this trigger is the
-- guarantee for direct writes (where it surfaces as a check_violation).
--
-- 'unspecified' (party_type) and 'unspecified'/'none' (direction) and NULL all
-- count as EMPTY = fillable. A concrete value is locked.
create or replace function public._reject_classify_overwrite()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  orig public.interactions;
begin
  if NEW.correction_kind is distinct from 'classify' then
    return NEW;
  end if;

  select * into orig from public.interactions where id = NEW.corrects_id;
  if not found then
    -- The composite FK guarantees the target exists in-account; nothing to
    -- compare against if it somehow does not.
    return NEW;
  end if;

  -- body + occurred_at are inherited, never changed.
  if NEW.body is distinct from orig.body then
    raise exception 'classify cannot change body (use amend)' using errcode = 'check_violation';
  end if;
  if NEW.occurred_at is distinct from orig.occurred_at then
    raise exception 'classify cannot change occurred_at (use amend)' using errcode = 'check_violation';
  end if;

  -- nullable context fields: fill an empty original, never overwrite a set one.
  if orig.party_id is not null and NEW.party_id is distinct from orig.party_id then
    raise exception 'classify cannot overwrite party_id (use amend)' using errcode = 'check_violation';
  end if;
  if orig.party_label is not null and NEW.party_label is distinct from orig.party_label then
    raise exception 'classify cannot overwrite party_label (use amend)' using errcode = 'check_violation';
  end if;
  if orig.tenancy_id is not null and NEW.tenancy_id is distinct from orig.tenancy_id then
    raise exception 'classify cannot overwrite tenancy_id (use amend)' using errcode = 'check_violation';
  end if;
  if orig.maintenance_request_id is not null and NEW.maintenance_request_id is distinct from orig.maintenance_request_id then
    raise exception 'classify cannot overwrite maintenance_request_id (use amend)' using errcode = 'check_violation';
  end if;
  if orig.area_id is not null and NEW.area_id is distinct from orig.area_id then
    raise exception 'classify cannot overwrite area_id (use amend)' using errcode = 'check_violation';
  end if;
  if orig.work_order_id is not null and NEW.work_order_id is distinct from orig.work_order_id then
    raise exception 'classify cannot overwrite work_order_id (use amend)' using errcode = 'check_violation';
  end if;
  if orig.vendor_id is not null and NEW.vendor_id is distinct from orig.vendor_id then
    raise exception 'classify cannot overwrite vendor_id (use amend)' using errcode = 'check_violation';
  end if;
  if orig.references_interaction_id is not null and NEW.references_interaction_id is distinct from orig.references_interaction_id then
    raise exception 'classify cannot overwrite references_interaction_id (use amend)' using errcode = 'check_violation';
  end if;

  -- party_type: 'unspecified'/'none' are empty (fillable); a concrete role is locked.
  if orig.party_type not in ('unspecified', 'none') and NEW.party_type is distinct from orig.party_type then
    raise exception 'classify cannot overwrite party_type (use amend)' using errcode = 'check_violation';
  end if;
  -- direction: 'unspecified'/'none' are empty (fillable); a stated direction is locked.
  if orig.direction not in ('unspecified', 'none') and NEW.direction is distinct from orig.direction then
    raise exception 'classify cannot overwrite direction (use amend)' using errcode = 'check_violation';
  end if;
  -- channel is never empty on a communication => effectively immutable here.
  if NEW.channel is distinct from orig.channel then
    raise exception 'classify cannot change channel (use amend)' using errcode = 'check_violation';
  end if;

  -- atomic resolve: naming a party_id requires resolving the role too
  -- (the table CHECK backstops the inverse: unspecified => party_id IS NULL).
  if NEW.party_id is not null and NEW.party_type = 'unspecified' then
    raise exception 'classify must resolve party_type when setting party_id' using errcode = 'check_violation';
  end if;

  return NEW;
end;
$$;

create trigger interactions_classify_fill_only
  before insert on public.interactions
  for each row
  when (NEW.correction_kind = 'classify')
  execute function public._reject_classify_overwrite();
