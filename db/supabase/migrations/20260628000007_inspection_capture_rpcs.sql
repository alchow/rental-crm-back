-- ----------------------------------------------------------------------------
-- Phase 27 (7/7): tenant capture-path RPCs (SECURITY DEFINER).
--
-- The tenant fills a move-in/out form via a magic link -- no JWT, no
-- membership. The API verifies the hashed token (Node), then calls these
-- DEFINER functions with the token's account_id / inspection_id. DEFINER lets
-- them (a) stamp the audit actor as 'tenant:<token>' (mirrors
-- submit_intake_with_attachment) so the chain attributes the write to the
-- tenant, and (b) write rows the tenant has no RLS grant for.
--
-- SECURITY: because DEFINER bypasses RLS, these are REVOKEd from public and
-- granted ONLY to service_role. An authenticated user must NOT be able to
-- invoke them directly with a forged account/inspection id -- only the
-- service-role path (which has already verified the secret) may call them.
-- Each function also re-checks the inspection is in a tenant-editable state.
-- ----------------------------------------------------------------------------

-- tenant_update_inspection_item ----------------------------------------------
create or replace function public.tenant_update_inspection_item(
  p_account_id    uuid,
  p_token_id      uuid,
  p_inspection_id uuid,
  p_item_id       uuid,
  p_condition     text,
  p_notes         text
)
returns public.inspection_items
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status       text;
  v_capture_mode text;
  v_completed    timestamptz;
  v_row          public.inspection_items;
begin
  perform set_config('audit.actor', 'tenant:' || p_token_id::text, true);

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

  update public.inspection_items
     set condition = p_condition, notes = p_notes, updated_at = now()
   where account_id = p_account_id and inspection_id = p_inspection_id
     and id = p_item_id and deleted_at is null
  returning * into v_row;
  if not found then
    raise exception 'item_not_found' using errcode = 'P0002';
  end if;
  return v_row;
end;
$$;

-- tenant_upsert_inspection_checks --------------------------------------------
create or replace function public.tenant_upsert_inspection_checks(
  p_account_id    uuid,
  p_token_id      uuid,
  p_inspection_id uuid,
  p_checks        jsonb
)
returns setof public.inspection_checks
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
  insert into public.inspection_checks
    (account_id, inspection_id, field_key, label, group_label, value, sort_order, answered_at)
  select
    p_account_id, p_inspection_id,
    e->>'field_key',
    coalesce(e->>'label', e->>'field_key'),
    e->>'group_label',
    e->'value',
    nullif(e->>'sort_order', '')::int,
    now()
  from jsonb_array_elements(p_checks) as e
  where coalesce(e->>'field_key', '') <> ''
  on conflict (inspection_id, field_key) where deleted_at is null
  do update set
    label       = excluded.label,
    group_label = excluded.group_label,
    value       = excluded.value,
    sort_order  = excluded.sort_order,
    answered_at = excluded.answered_at,
    updated_at  = now()
  returning *;
end;
$$;

-- tenant_submit_inspection ----------------------------------------------------
-- Tenant attestation point: draft -> tenant_submitted (audit actor = tenant).
-- Idempotent: a second submit on an already-submitted inspection returns it.
create or replace function public.tenant_submit_inspection(
  p_account_id    uuid,
  p_token_id      uuid,
  p_inspection_id uuid
)
returns public.inspections
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.inspections;
begin
  perform set_config('audit.actor', 'tenant:' || p_token_id::text, true);

  update public.inspections
     set status = 'tenant_submitted', updated_at = now()
   where account_id = p_account_id and id = p_inspection_id and deleted_at is null
     and completed_at is null and status = 'draft'
     and capture_mode in ('tenant', 'collaborative')
  returning * into v_row;
  if found then
    return v_row;
  end if;

  -- Not draft: re-fetch for idempotency / a precise error.
  select * into v_row
    from public.inspections
    where account_id = p_account_id and id = p_inspection_id and deleted_at is null;
  if not found then
    raise exception 'inspection_not_found' using errcode = 'P0002';
  end if;
  if v_row.status = 'tenant_submitted' then
    return v_row; -- already submitted: idempotent
  end if;
  raise exception 'not_submittable' using errcode = 'check_violation';
end;
$$;

-- DEFINER functions default to EXECUTE for PUBLIC; that would let an
-- authenticated user invoke them with a forged account/inspection id and
-- bypass RLS. Lock them to service_role (the verified magic-link path) only.
revoke execute on function public.tenant_update_inspection_item(uuid, uuid, uuid, uuid, text, text) from public;
revoke execute on function public.tenant_upsert_inspection_checks(uuid, uuid, uuid, jsonb) from public;
revoke execute on function public.tenant_submit_inspection(uuid, uuid, uuid) from public;

grant execute on function public.tenant_update_inspection_item(uuid, uuid, uuid, uuid, text, text) to service_role;
grant execute on function public.tenant_upsert_inspection_checks(uuid, uuid, uuid, jsonb) to service_role;
grant execute on function public.tenant_submit_inspection(uuid, uuid, uuid) to service_role;
