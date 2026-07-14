-- ----------------------------------------------------------------------------
-- Atomic inspection creation from a template.
--
-- The legacy client choreography creates an inspection, seeds every template
-- row, rewrites those rows with the final scratchpad, and then DELETEs trimmed
-- items one request at a time. Besides the request waterfall, a failure between
-- those calls leaves a partially prepared inspection.
--
-- This RPC moves only the preparation boundary into one transaction:
--
--   claimed idempotency row -> validate template hash -> inspection insert
--     -> authoritative item/check inserts -> cache InspectionDetail -> commit
--
-- Capture-link creation deliberately remains a later, independent operation.
-- The function is SECURITY INVOKER: the caller's JWT, table grants, RLS
-- policies, coherence triggers, completion locks, and audit triggers all remain
-- in force. Any error rolls back the inspection, its children, their audit
-- events, and the in-transaction idempotency completion together.
-- ----------------------------------------------------------------------------

create or replace function public.create_inspection_from_template(
  p_account_id         uuid,
  p_idempotency_key    text,
  p_request_fingerprint text,
  p_payload            jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_idempotency       record;
  v_template_id       uuid;
  v_template_hash     text;
  v_template_schema   jsonb;
  v_setup             jsonb;
  v_setup_mode        text;
  v_items             jsonb;
  v_checks            jsonb;
  v_inspection        public.inspections;
  v_rooms_done        int := 0;
  v_rooms_total       int := 0;
  v_result            jsonb;
begin
  -- The HTTP idempotency middleware must have won the claim before calling
  -- this RPC. Lock that exact placeholder through the domain transaction so a
  -- same-key operation can neither reclaim nor complete it concurrently.
  select k.request_fingerprint, k.status_code, k.body, k.completed_at
    into v_idempotency
    from public.idempotency_keys k
   where k.account_id = p_account_id
     and k.key = p_idempotency_key
   for update;

  if not found then
    raise exception 'idempotency_key_not_claimed' using errcode = 'P0002';
  end if;
  if v_idempotency.request_fingerprint is distinct from p_request_fingerprint then
    raise exception 'idempotency_fingerprint_mismatch' using errcode = 'check_violation';
  end if;
  if v_idempotency.completed_at is not null
     or v_idempotency.status_code is not null
     or v_idempotency.body is not null
  then
    raise exception 'idempotency_key_not_in_flight' using errcode = 'check_violation';
  end if;

  if p_payload is null or jsonb_typeof(p_payload) is distinct from 'object' then
    raise exception 'payload must be a JSON object' using errcode = 'check_violation';
  end if;
  if p_payload - array[
    'area_id', 'tenancy_id', 'kind', 'capture_mode', 'template_id',
    'template_schema_hash', 'performed_at', 'notes', 'setup'
  ] <> '{}'::jsonb then
    raise exception 'payload contains unsupported fields' using errcode = 'check_violation';
  end if;
  if jsonb_typeof(p_payload->'area_id') is distinct from 'string'
     or jsonb_typeof(p_payload->'template_id') is distinct from 'string'
     or jsonb_typeof(p_payload->'template_schema_hash') is distinct from 'string'
     or (p_payload->>'template_schema_hash') !~ '^[a-f0-9]{32}$'
     or jsonb_typeof(p_payload->'kind') is distinct from 'string'
     or jsonb_typeof(p_payload->'capture_mode') is distinct from 'string'
  then
    raise exception 'area_id, template_id, template_schema_hash, kind and capture_mode are required'
      using errcode = 'check_violation';
  end if;
  if (p_payload->>'kind') not in ('move_in', 'move_out', 'periodic', 'general')
     or (p_payload->>'capture_mode') not in ('landlord', 'tenant', 'collaborative')
     or (p_payload ? 'tenancy_id' and jsonb_typeof(p_payload->'tenancy_id') is distinct from 'string')
     or (p_payload ? 'performed_at' and jsonb_typeof(p_payload->'performed_at') is distinct from 'string')
     or (p_payload ? 'notes' and jsonb_typeof(p_payload->'notes') is distinct from 'string')
     or char_length(coalesce(p_payload->>'notes', '')) > 20000
  then
    raise exception 'invalid inspection metadata' using errcode = 'check_violation';
  end if;

  v_template_id := nullif(p_payload->>'template_id', '')::uuid;
  select t.schema_hash, t.schema
    into v_template_hash, v_template_schema
    from public.inspection_templates t
   where t.account_id = p_account_id
     and t.id = v_template_id
     and t.deleted_at is null;

  if not found then
    raise exception 'template_not_found' using errcode = 'P0002';
  end if;
  -- A scratchpad is based on one exact schema revision. Refuse to reinterpret
  -- it against an edited template; the caller can reload and rebuild instead.
  if nullif(p_payload->>'template_schema_hash', '') is distinct from v_template_hash then
    raise exception 'template_schema_mismatch' using errcode = 'check_violation';
  end if;

  v_setup := p_payload->'setup';
  if v_setup is null or jsonb_typeof(v_setup) is distinct from 'object' then
    raise exception 'setup must be a JSON object' using errcode = 'check_violation';
  end if;
  v_setup_mode := v_setup->>'mode';
  if v_setup_mode not in ('final', 'template') or v_setup_mode is null then
    raise exception 'setup.mode must be final or template' using errcode = 'check_violation';
  end if;

  if v_setup_mode = 'final' then
    if v_setup - array['mode', 'items', 'checks'] <> '{}'::jsonb then
      raise exception 'final setup contains unsupported fields' using errcode = 'check_violation';
    end if;
    v_items  := v_setup->'items';
    v_checks := v_setup->'checks';
    if jsonb_typeof(v_items) is distinct from 'array'
       or jsonb_typeof(v_checks) is distinct from 'array'
    then
      raise exception 'final setup requires items and checks arrays'
        using errcode = 'check_violation';
    end if;
    if jsonb_array_length(v_items) not between 1 and 1000
       or jsonb_array_length(v_checks) > 1000
    then
      raise exception 'final setup requires 1-1000 items and at most 1000 checks'
        using errcode = 'check_violation';
    end if;

    -- The stable keys and labels are required even though legacy item rows may
    -- have a null item_key. Reject hidden answer/evidence fields as well as bad
    -- scalar types so direct RPC callers get the same setup-only contract as
    -- the HTTP route.
    if exists (
      select 1
        from jsonb_array_elements(v_items) item
       where jsonb_typeof(item) is distinct from 'object'
          or item - array['item_key', 'label', 'group_label', 'sort_order'] <> '{}'::jsonb
          or jsonb_typeof(item->'item_key') is distinct from 'string'
          or jsonb_typeof(item->'label') is distinct from 'string'
          or coalesce(item->>'item_key', '') = ''
          or coalesce(item->>'label', '') = ''
          or char_length(item->>'item_key') > 200
          or char_length(item->>'label') > 200
          or (item ? 'group_label' and jsonb_typeof(item->'group_label') is distinct from 'string')
          or (item ? 'group_label' and coalesce(item->>'group_label', '') = '')
          or char_length(coalesce(item->>'group_label', '')) > 200
          or (item ? 'sort_order' and jsonb_typeof(item->'sort_order') is distinct from 'number')
          or (jsonb_typeof(item->'sort_order') = 'number' and (item->>'sort_order') !~ '^-?[0-9]+$')
    ) then
      raise exception 'invalid final inspection item' using errcode = 'check_violation';
    end if;

    if exists (
      select 1
        from jsonb_array_elements(v_checks) check_row
       where jsonb_typeof(check_row) is distinct from 'object'
          or check_row - array['field_key', 'label', 'group_label', 'sort_order', 'input_kind'] <> '{}'::jsonb
          or jsonb_typeof(check_row->'field_key') is distinct from 'string'
          or jsonb_typeof(check_row->'label') is distinct from 'string'
          or coalesce(check_row->>'field_key', '') = ''
          or coalesce(check_row->>'label', '') = ''
          or char_length(check_row->>'field_key') > 200
          or char_length(check_row->>'label') > 200
          or (check_row ? 'group_label' and jsonb_typeof(check_row->'group_label') is distinct from 'string')
          or (check_row ? 'group_label' and coalesce(check_row->>'group_label', '') = '')
          or char_length(coalesce(check_row->>'group_label', '')) > 200
          or (check_row ? 'sort_order' and jsonb_typeof(check_row->'sort_order') is distinct from 'number')
          or (jsonb_typeof(check_row->'sort_order') = 'number' and (check_row->>'sort_order') !~ '^-?[0-9]+$')
          or (check_row ? 'input_kind' and jsonb_typeof(check_row->'input_kind') is distinct from 'string')
          or (check_row->>'input_kind' is not null and check_row->>'input_kind' not in ('boolean', 'count', 'text'))
    ) then
      raise exception 'invalid final inspection check' using errcode = 'check_violation';
    end if;
  elsif v_setup - 'mode' <> '{}'::jsonb then
    raise exception 'template setup contains unsupported fields' using errcode = 'check_violation';
  end if;

  insert into public.inspections (
    account_id, area_id, template_id, kind, tenancy_id,
    capture_mode, performed_by, performed_at, notes
  ) values (
    p_account_id,
    nullif(p_payload->>'area_id', '')::uuid,
    v_template_id,
    coalesce(nullif(p_payload->>'kind', ''), 'general'),
    nullif(p_payload->>'tenancy_id', '')::uuid,
    coalesce(nullif(p_payload->>'capture_mode', ''), 'landlord'),
    (select auth.uid()),
    nullif(p_payload->>'performed_at', '')::timestamptz,
    p_payload->>'notes'
  )
  returning * into v_inspection;

  if v_setup_mode = 'final' then
    -- The arrays are authoritative for this brand-new inspection. Insert each
    -- final row once: no seed/update/delete churn and no false audit updates.
    insert into public.inspection_items (
      account_id, inspection_id, item_key, label, group_label, sort_order
    )
    select
      p_account_id,
      v_inspection.id,
      item->>'item_key',
      item->>'label',
      item->>'group_label',
      nullif(item->>'sort_order', '')::int
    from jsonb_array_elements(v_items) item;

    insert into public.inspection_checks (
      account_id, inspection_id, field_key, label, group_label,
      sort_order, input_kind
    )
    select
      p_account_id,
      v_inspection.id,
      check_row->>'field_key',
      check_row->>'label',
      check_row->>'group_label',
      nullif(check_row->>'sort_order', '')::int,
      check_row->>'input_kind'
    from jsonb_array_elements(v_checks) check_row;
  else
    -- Expand sections set-wise. Triggers still emit one truthful audit event
    -- per inserted domain row, but PostgreSQL executes one INSERT per table
    -- instead of one PL/pgSQL statement per JSON element.
    insert into public.inspection_items (
      account_id, inspection_id, item_key, label, group_label, sort_order
    )
    select
      p_account_id,
      v_inspection.id,
      (section->>'key') || '/' || (item->>'key'),
      coalesce(item->>'label', item->>'key'),
      section->>'label',
      nullif(item->>'sort', '')::int
    from jsonb_array_elements(
      case when jsonb_typeof(v_template_schema->'sections') = 'array'
        then v_template_schema->'sections' else '[]'::jsonb end
    ) section
    cross join lateral jsonb_array_elements(
      case when jsonb_typeof(section->'items') = 'array'
        then section->'items' else '[]'::jsonb end
    ) item;

    insert into public.inspection_checks (
      account_id, inspection_id, field_key, label, group_label,
      sort_order, input_kind
    )
    select
      p_account_id,
      v_inspection.id,
      (section->>'key') || '/' || (check_row->>'key'),
      coalesce(check_row->>'label', check_row->>'key'),
      section->>'label',
      nullif(check_row->>'sort', '')::int,
      case when check_row->>'input_kind' in ('boolean', 'count', 'text')
        then check_row->>'input_kind' else null end
    from jsonb_array_elements(
      case when jsonb_typeof(v_template_schema->'sections') = 'array'
        then v_template_schema->'sections' else '[]'::jsonb end
    ) section
    cross join lateral jsonb_array_elements(
      case when jsonb_typeof(section->'checks') = 'array'
        then section->'checks' else '[]'::jsonb end
    ) check_row;
  end if;

  -- Match GET /inspections/:id exactly: null/empty group labels share the one
  -- ungrouped room, and a room is done when any live item has a condition.
  select count(*)::int,
         count(*) filter (where room.has_content)::int
    into v_rooms_total, v_rooms_done
    from (
      select nullif(it.group_label, '') as group_label,
             bool_or(it.condition is not null) as has_content
        from public.inspection_items it
       where it.account_id = p_account_id
         and it.inspection_id = v_inspection.id
         and it.deleted_at is null
       group by nullif(it.group_label, '')
    ) room;

  v_result := to_jsonb(v_inspection) || jsonb_build_object(
    'engagement', jsonb_build_object(
      'link_delivered_at', v_inspection.link_delivered_at,
      'form_opened_at', v_inspection.form_opened_at,
      'form_started_at', v_inspection.form_started_at,
      'submitted_at', v_inspection.submitted_at,
      'rooms_done', v_rooms_done,
      'rooms_total', v_rooms_total
    )
  );

  -- This completion is part of the same commit as the domain rows. Therefore
  -- a process crash after commit but before the HTTP response cannot leave a
  -- reclaimable in-flight key that would create a second inspection.
  update public.idempotency_keys
     set status_code = 201,
         body = v_result,
         completed_at = now()
   where account_id = p_account_id
     and key = p_idempotency_key
     and request_fingerprint = p_request_fingerprint
     and completed_at is null;
  if not found then
    raise exception 'idempotency_completion_lost' using errcode = 'check_violation';
  end if;

  return v_result;
end;
$$;

comment on function public.create_inspection_from_template(uuid, text, text, jsonb) is
  'Atomically creates a fully prepared inspection from an exact template revision and completes its claimed idempotency row.';

-- Reassert the complete ACL: this is a caller-JWT/RLS operation, never an anon
-- endpoint or a service-role escape hatch.
revoke all on function public.create_inspection_from_template(uuid, text, text, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.create_inspection_from_template(uuid, text, text, jsonb)
  to authenticated;

notify pgrst, 'reload schema';
