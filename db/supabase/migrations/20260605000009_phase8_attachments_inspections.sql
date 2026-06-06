-- ----------------------------------------------------------------------------
-- Phase 8: attachments storage + inspection immutability.
--
-- Two concerns:
--
-- (A) Storage. A private bucket called 'attachments' holds binary data
-- (photos, PDFs). Object paths are account-scoped:
--   <account_id>/<entity_type>/<entity_id>/<sha256-of-bytes>.<ext>
-- Storage policies key off the first 36 chars of the path (the account_id
-- UUID) and require account_members membership. Writes go through the API
-- (admin client) -- never directly from clients -- so we can compute the
-- sha256 server-side from the actual stored bytes. A client-supplied hash
-- would be worthless for tamper evidence.
--
-- (B) Inspection completion locks the record. Once inspections.completed_at
-- is set, neither the inspection nor any of its items can be modified or
-- deleted -- corrections happen via NEW events under the audit spine. This
-- is the Phase 10 evidence-export pattern in miniature: a completed
-- inspection's PDF is itself stored as a content-hashed attachment so the
-- report bytes are tamper-evident too.
-- ----------------------------------------------------------------------------

-- ============================================================================
-- (A) Storage bucket + policies
--
-- The `storage` schema is part of Supabase's stack (GoTrue / Storage). In
-- the ephemeral-postgres test tier (vanilla postgres + db/test/supabase_
-- compat.sql) the schema doesn't exist, so the bucket creation and the
-- policy on storage.objects are conditional. The path-account helper is
-- created either way -- it's a pure SQL function the storage policy
-- references when it can.
-- ============================================================================

-- Helper: extract the account_id (first path segment) and check membership.
-- substr-based to avoid storing a generated column; the bucket only holds
-- our content so the assumption "first 36 chars are a UUID" is safe.
-- Defensive cast: if some non-UUID name landed (shouldn't), the cast fails
-- silently and the policy denies.
create or replace function public._storage_path_account_id(p_name text)
returns uuid
language sql
immutable
as $$
  select
    case
      when length(p_name) >= 37 and substr(p_name, 37, 1) = '/'
      then (
        case
          when substr(p_name, 1, 36) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          then substr(p_name, 1, 36)::uuid
          else null
        end
      )
      else null
    end;
$$;

do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'storage') then
    -- Private 'attachments' bucket. No-op if it already exists.
    execute
      $sql$ insert into storage.buckets (id, name, public)
            values ('attachments', 'attachments', false)
            on conflict (id) do nothing $sql$;

    -- Read: account members SELECT objects under their account_id prefix.
    -- Writes (INSERT / UPDATE / DELETE) are NOT granted to authenticated;
    -- all uploads / deletes route through the API + service-role client,
    -- which has already verified the entity belongs to the caller's account.
    execute
      $sql$ drop policy if exists "attachments_member_read" on storage.objects $sql$;
    execute
      $sql$ create policy "attachments_member_read"
              on storage.objects
              for select
              to authenticated
              using (
                bucket_id = 'attachments'
                and public._storage_path_account_id(name) is not null
                and public.is_account_member(public._storage_path_account_id(name))
              ) $sql$;
  end if;
end $$;

-- ============================================================================
-- (B) Inspection completion lock
-- ============================================================================

alter table public.inspections
  add column completed_at timestamptz;

-- A completed inspection (and its items) is immutable. Trigger raises on
-- any UPDATE that touches a completed parent, AND on any UPDATE / DELETE
-- of an inspection_item whose parent is completed. Corrections are recorded
-- as new events under the audit spine -- never by editing the report.

create or replace function public._reject_completed_inspection_update()
returns trigger
language plpgsql
as $$
begin
  if OLD.completed_at is not null then
    -- The ONLY allowed UPDATE on a completed inspection is the soft-delete
    -- (setting deleted_at). Even that should usually go via a new event,
    -- but a delete is at least non-mutating to the report data itself.
    -- Allow it; block everything else.
    if NEW.deleted_at is distinct from OLD.deleted_at
       and NEW.completed_at = OLD.completed_at
       and NEW.area_id = OLD.area_id
       and NEW.template_id is not distinct from OLD.template_id
       and NEW.performed_by is not distinct from OLD.performed_by
       and NEW.performed_at is not distinct from OLD.performed_at
       and NEW.notes is not distinct from OLD.notes then
      return NEW;
    end if;
    raise exception 'inspection % is completed and cannot be modified', OLD.id
      using errcode = 'check_violation';
  end if;
  return NEW;
end;
$$;

create trigger inspections_immutable_when_completed
  before update on public.inspections
  for each row execute function public._reject_completed_inspection_update();

create or replace function public._reject_item_update_on_completed_inspection()
returns trigger
language plpgsql
as $$
declare
  v_inspection_id uuid;
  v_completed     timestamptz;
begin
  v_inspection_id := case TG_OP when 'DELETE' then OLD.inspection_id else NEW.inspection_id end;
  select completed_at into v_completed
    from public.inspections where id = v_inspection_id;
  if v_completed is not null then
    raise exception 'parent inspection % is completed; items are immutable', v_inspection_id
      using errcode = 'check_violation';
  end if;
  return case TG_OP when 'DELETE' then OLD else NEW end;
end;
$$;

create trigger inspection_items_immutable_when_parent_completed
  before insert or update or delete on public.inspection_items
  for each row execute function public._reject_item_update_on_completed_inspection();
