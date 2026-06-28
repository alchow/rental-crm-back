-- ----------------------------------------------------------------------------
-- Phase 27 (3/6): freeze inspection photos at completion.
--
-- inspection_items / inspections are locked at completion by Phase-8 triggers,
-- but attachments are a SEPARATE table those triggers don't cover. Without this
-- guard, a photo could be attached to a completed (and signed) inspection AFTER
-- the fact -- absent from the frozen, content-hashed PDF yet present in the
-- attachments list. That is dispute poison ("photos added after sign-off").
--
-- This BEFORE INSERT/UPDATE trigger rejects writes to attachments that target a
-- COMPLETED inspection. It is deliberately scoped to entity_type in
-- ('inspections','inspection_items'): the report generator writes
-- entity_type='inspection_report' with entity_id = the completed inspection,
-- and a naive "anything referencing a completed inspection" rule would block
-- the report write itself. Contract: photos attach during draft; completion
-- freezes items AND their photos together.
-- ----------------------------------------------------------------------------

create or replace function public._reject_attachment_on_completed_inspection()
returns trigger
language plpgsql
as $$
declare
  v_completed timestamptz;
begin
  if NEW.entity_type = 'inspections' then
    select completed_at into v_completed
      from public.inspections
      where account_id = NEW.account_id and id = NEW.entity_id;
  elsif NEW.entity_type = 'inspection_items' then
    select i.completed_at into v_completed
      from public.inspection_items it
      join public.inspections i
        on i.account_id = it.account_id and i.id = it.inspection_id
      where it.account_id = NEW.account_id and it.id = NEW.entity_id;
  else
    -- not an inspection-capture attachment (incl. 'inspection_report'): unaffected.
    return NEW;
  end if;

  if v_completed is not null then
    raise exception 'parent inspection is completed; attachments are immutable (%, %)',
      NEW.entity_type, NEW.entity_id
      using errcode = 'check_violation';
  end if;
  return NEW;
end;
$$;

create trigger attachments_reject_on_completed_inspection
  before insert or update on public.attachments
  for each row execute function public._reject_attachment_on_completed_inspection();
