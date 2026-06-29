-- ----------------------------------------------------------------------------
-- Phase 27 follow-up: tenant capture-path photo upload + batch item edit
-- (SECURITY DEFINER).
--
-- Extends the tenant magic-link capture flow (20260628000007) with the two
-- pieces the FE asked for: (1) attach a photo to a draft item, reusing the
-- exact attachment/HEIC-derivative machinery as the landlord/intake paths so
-- tenant photos are byte-identical downstream (report PDF, checkout-diff,
-- evidence-export need zero change); (2) a capture-side bulk "mark all good".
--
-- Same trust model as 20260628000007: the tenant has no JWT and no membership.
-- The API verifies the hashed token (Node), then calls these DEFINER functions
-- with the token's account_id / inspection_id. DEFINER lets them (a) stamp the
-- audit actor as 'tenant:<token>' (mirrors submit_intake_with_attachment) and
-- (b) write rows the tenant has no RLS grant for.
--
-- SECURITY: because DEFINER bypasses RLS, both are REVOKEd from public and
-- granted ONLY to service_role (the verified magic-link path). Each re-checks
-- the inspection is in a tenant-editable state before any write, copying the
-- guard from tenant_update_inspection_item verbatim:
--   P0002           -> 404 (inspection / item not found)
--   check_violation -> 409 (not editable by tenant)
-- ----------------------------------------------------------------------------

-- tenant_attach_inspection_item_photo ----------------------------------------
-- Insert an attachment (+ optional server-derived JPEG) against a draft item.
-- uploaded_by=null + audit actor 'tenant:<token>' attribute it to the tenant.
-- Idempotent on the original bytes' content_hash: a re-upload of identical
-- bytes returns the existing attachment (and its derivative) without inserting.
create or replace function public.tenant_attach_inspection_item_photo(
  p_account_id      uuid,
  p_token_id        uuid,
  p_inspection_id   uuid,
  p_item_id         uuid,
  p_attachment_hash text,
  p_attachment_mime text,
  p_attachment_size bigint,
  p_attachment_path text,
  p_derivative_hash text   default null,
  p_derivative_mime text   default null,
  p_derivative_size bigint default null,
  p_derivative_path text   default null
)
returns table (
  attachment_id uuid,
  derivative_id uuid
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status        text;
  v_capture_mode  text;
  v_completed     timestamptz;
  v_attachment_id uuid;
  v_derivative_id uuid;
begin
  perform set_config('audit.actor', 'tenant:' || p_token_id::text, true);

  -- re-check the inspection is tenant-editable (verbatim from
  -- tenant_update_inspection_item).
  select status, capture_mode, completed_at
    into v_status, v_capture_mode, v_completed
    from public.inspections
    where account_id = p_account_id and id = p_inspection_id and deleted_at is null;
  if not found then
    raise exception 'inspection_not_found' using errcode = 'P0002';
  end if;
  if v_completed is not null or v_status <> 'draft'
     or v_capture_mode not in ('tenant', 'collaborative') then
    raise exception 'not_editable_by_tenant' using errcode = 'check_violation';
  end if;

  -- the item must belong to this inspection.
  perform 1
    from public.inspection_items
    where account_id = p_account_id and inspection_id = p_inspection_id
      and id = p_item_id and deleted_at is null;
  if not found then
    raise exception 'item_not_found' using errcode = 'P0002';
  end if;

  -- idempotency: identical bytes already attached to this item -> return the
  -- existing attachment (and its derivative, if any) without inserting.
  select id into v_attachment_id
    from public.attachments
    where account_id = p_account_id and entity_type = 'inspection_items'
      and entity_id = p_item_id and content_hash = p_attachment_hash
      and deleted_at is null
    limit 1;
  if found then
    select id into v_derivative_id
      from public.attachments
      where account_id = p_account_id and derived_from = v_attachment_id
        and deleted_at is null
      limit 1;
    attachment_id := v_attachment_id;
    derivative_id := v_derivative_id;
    return next;
    return;
  end if;

  insert into public.attachments
    (account_id, entity_type, entity_id, storage_path, content_hash,
     mime_type, size_bytes, uploaded_by)
  values
    (p_account_id, 'inspection_items', p_item_id, p_attachment_path,
     p_attachment_hash, p_attachment_mime, p_attachment_size, null)
  returning id into v_attachment_id;

  if p_derivative_hash is not null then
    insert into public.attachments
      (account_id, entity_type, entity_id, storage_path, content_hash,
       mime_type, size_bytes, uploaded_by, derived_from)
    values
      (p_account_id, 'inspection_items', p_item_id, p_derivative_path,
       p_derivative_hash, p_derivative_mime, p_derivative_size, null,
       v_attachment_id)
    returning id into v_derivative_id;
  end if;

  attachment_id := v_attachment_id;
  derivative_id := v_derivative_id;
  return next;
end;
$$;

-- tenant_upsert_inspection_items ----------------------------------------------
-- Capture-side bulk edit ("mark all good"). UPDATE-ONLY by item_key: a tenant
-- must NOT be able to add line items (deliberate divergence from the landlord
-- upsert_inspection_items, which also inserts). Tenant writes are limited to
-- condition + notes -- the same fields as the single-item tenant PATCH
-- (tenant_update_inspection_item). change_type is the deduction-driving damage
-- verdict and is the landlord's call, never the tenant's, so it is NOT settable
-- here. Key-exists guards keep absent fields from clobbering existing values; an
-- unknown item_key is a no-op. Returns the rows that were updated.
create or replace function public.tenant_upsert_inspection_items(
  p_account_id    uuid,
  p_token_id      uuid,
  p_inspection_id uuid,
  p_items         jsonb
)
returns setof public.inspection_items
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status       text;
  v_capture_mode text;
  v_completed    timestamptz;
begin
  perform set_config('audit.actor', 'tenant:' || p_token_id::text, true);

  -- re-check the inspection is tenant-editable (verbatim from
  -- tenant_update_inspection_item).
  select status, capture_mode, completed_at
    into v_status, v_capture_mode, v_completed
    from public.inspections
    where account_id = p_account_id and id = p_inspection_id and deleted_at is null;
  if not found then
    raise exception 'inspection_not_found' using errcode = 'P0002';
  end if;
  if v_completed is not null or v_status <> 'draft'
     or v_capture_mode not in ('tenant', 'collaborative') then
    raise exception 'not_editable_by_tenant' using errcode = 'check_violation';
  end if;

  return query
  update public.inspection_items it
     set condition   = case when e ? 'condition'   then e->>'condition'   else it.condition   end,
         notes       = case when e ? 'notes'       then e->>'notes'       else it.notes       end,
         updated_at  = now()
    from jsonb_array_elements(p_items) as e
   where it.account_id    = p_account_id
     and it.inspection_id = p_inspection_id
     and it.item_key      = e->>'item_key'
     and coalesce(e->>'item_key', '') <> ''
     and it.deleted_at is null
  returning it.*;
end;
$$;

-- Lock these DEFINER functions to service_role (the verified magic-link path)
-- only. NOTE: `revoke ... from public` alone is INSUFFICIENT on Supabase: this
-- project's default privileges (pg_default_acl, owners postgres + supabase_admin)
-- EXECUTE-grant every new public function to anon + authenticated EXPLICITLY, so
-- a bare `revoke from public` is a no-op and the function stays callable by anon/
-- authenticated directly via PostgREST (/rest/v1/rpc/...) with the public anon
-- key -- bypassing the token check on a SECURITY DEFINER (RLS-bypassing) function.
-- We must revoke from anon + authenticated explicitly.
revoke execute on function public.tenant_attach_inspection_item_photo(uuid, uuid, uuid, uuid, text, text, bigint, text, text, text, bigint, text) from public, anon, authenticated;
revoke execute on function public.tenant_upsert_inspection_items(uuid, uuid, uuid, jsonb) from public, anon, authenticated;

grant execute on function public.tenant_attach_inspection_item_photo(uuid, uuid, uuid, uuid, text, text, bigint, text, text, text, bigint, text) to service_role;
grant execute on function public.tenant_upsert_inspection_items(uuid, uuid, uuid, jsonb) to service_role;
