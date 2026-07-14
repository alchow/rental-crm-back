-- ----------------------------------------------------------------------------
-- inspection_checks.input_kind: carry the catalog's field typing to the row.
--
-- The bundled catalog already types every check ('boolean' "Smoke alarms
-- tested?" vs 'count' "Door keys") but seed-from-template dropped it (no
-- column), so every surface could only render Yes/No -- a landlord/tenant
-- could not record HOW MANY keys changed hands (FE ask §20a).
--
-- input_kind is a rendering/semantic HINT, not a validation contract: value
-- stays free-form jsonb and is never checked against it (offline field syncs
-- must not brick on a stale hint). Nullable; null = legacy/unknown, clients
-- fall back to Yes/No. 'text' is reserved for future free-text checks; the
-- catalog's 'condition_text' kind is items-only and never lands on a check.
--
-- Carried at every point a check row is minted or synced:
--   * seed_inspection_items_from_template  (template schema -> row; values
--     sanitized -- template schema is client-editable free-form JSON, and an
--     unrecognized kind must not make seeding raise)
--   * start_checkout_from_checkin          (baseline row -> move-out row;
--     without this the move-out form regresses to Yes/No exactly when the
--     handover counts matter)
--   * both upsert RPCs                     (presence-merge like every other
--     column: present -> set, absent -> preserve)
-- ----------------------------------------------------------------------------

alter table public.inspection_checks
  add column input_kind text
    check (input_kind is null or input_kind in ('boolean', 'count', 'text'));

-- seed_inspection_items_from_template: carry input_kind from the template ----
create or replace function public.seed_inspection_items_from_template(
  p_account_id    uuid,
  p_inspection_id uuid,
  p_template_id   uuid default null
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_completed     timestamptz;
  v_template_id   uuid;
  v_schema        jsonb;
  v_section       jsonb;
  v_item          jsonb;
  v_check         jsonb;
  v_section_key   text;
  v_section_label text;
  v_items         jsonb;
  v_checks        jsonb;
begin
  select completed_at, template_id into v_completed, v_template_id
    from public.inspections
    where account_id = p_account_id and id = p_inspection_id and deleted_at is null;
  if not found then
    raise exception 'inspection_not_found' using errcode = 'P0002';
  end if;
  if v_completed is not null then
    raise exception 'inspection is completed' using errcode = 'check_violation';
  end if;

  v_template_id := coalesce(p_template_id, v_template_id);
  if v_template_id is null then
    raise exception 'no template to seed from' using errcode = 'check_violation';
  end if;

  select schema into v_schema
    from public.inspection_templates
    where account_id = p_account_id and id = v_template_id and deleted_at is null;
  if v_schema is null then
    raise exception 'template_not_found' using errcode = 'P0002';
  end if;

  for v_section in select * from jsonb_array_elements(coalesce(v_schema->'sections', '[]'::jsonb))
  loop
    v_section_key   := v_section->>'key';
    v_section_label := v_section->>'label';

    for v_item in select * from jsonb_array_elements(coalesce(v_section->'items', '[]'::jsonb))
    loop
      insert into public.inspection_items
        (account_id, inspection_id, label, item_key, group_label, sort_order)
      values
        (p_account_id, p_inspection_id,
         coalesce(v_item->>'label', v_item->>'key'),
         v_section_key || '/' || (v_item->>'key'),
         v_section_label,
         nullif(v_item->>'sort', '')::int)
      on conflict (inspection_id, item_key) where item_key is not null and deleted_at is null
      do nothing;
    end loop;

    for v_check in select * from jsonb_array_elements(coalesce(v_section->'checks', '[]'::jsonb))
    loop
      insert into public.inspection_checks
        (account_id, inspection_id, field_key, label, group_label, sort_order, input_kind)
      values
        (p_account_id, p_inspection_id,
         v_section_key || '/' || (v_check->>'key'),
         coalesce(v_check->>'label', v_check->>'key'),
         v_section_label,
         nullif(v_check->>'sort', '')::int,
         case when v_check->>'input_kind' in ('boolean', 'count', 'text')
              then v_check->>'input_kind' else null end)
      on conflict (inspection_id, field_key) where deleted_at is null
      do nothing;
    end loop;
  end loop;

  select coalesce(jsonb_agg(to_jsonb(it) order by it.sort_order nulls last, it.created_at, it.id), '[]'::jsonb)
    into v_items
    from public.inspection_items it
    where it.account_id = p_account_id and it.inspection_id = p_inspection_id and it.deleted_at is null;

  select coalesce(jsonb_agg(to_jsonb(ck) order by ck.sort_order nulls last, ck.created_at, ck.id), '[]'::jsonb)
    into v_checks
    from public.inspection_checks ck
    where ck.account_id = p_account_id and ck.inspection_id = p_inspection_id and ck.deleted_at is null;

  return jsonb_build_object('items', v_items, 'checks', v_checks);
end;
$$;

-- start_checkout_from_checkin: the move-out skeleton keeps the typing ---------
create or replace function public.start_checkout_from_checkin(
  p_account_id             uuid,
  p_baseline_inspection_id uuid,
  p_performed_at           timestamptz default null,
  p_template_id            uuid default null,
  p_notes                  text default null
)
returns public.inspections
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_base public.inspections;
  v_new  public.inspections;
begin
  select * into v_base
    from public.inspections
    where account_id = p_account_id and id = p_baseline_inspection_id and deleted_at is null;
  if not found then
    raise exception 'baseline_not_found' using errcode = 'P0002';
  end if;
  if v_base.completed_at is null then
    raise exception 'baseline inspection must be completed' using errcode = 'check_violation';
  end if;
  if v_base.tenancy_id is null then
    raise exception 'baseline inspection has no tenancy' using errcode = 'check_violation';
  end if;

  insert into public.inspections
    (account_id, area_id, template_id, kind, tenancy_id, baseline_inspection_id,
     capture_mode, performed_by, performed_at, notes, status)
  values
    (p_account_id, v_base.area_id, coalesce(p_template_id, v_base.template_id),
     'move_out', v_base.tenancy_id, v_base.id, v_base.capture_mode,
     (select auth.uid()), p_performed_at, p_notes, 'draft')
  returning * into v_new;

  insert into public.inspection_items
    (account_id, inspection_id, label, item_key, group_label, sort_order)
  select p_account_id, v_new.id, it.label, it.item_key, it.group_label, it.sort_order
    from public.inspection_items it
    where it.account_id = p_account_id and it.inspection_id = v_base.id
      and it.deleted_at is null and it.item_key is not null;

  insert into public.inspection_checks
    (account_id, inspection_id, field_key, label, group_label, sort_order, input_kind)
  select p_account_id, v_new.id, ck.field_key, ck.label, ck.group_label, ck.sort_order, ck.input_kind
    from public.inspection_checks ck
    where ck.account_id = p_account_id and ck.inspection_id = v_base.id
      and ck.deleted_at is null;

  return v_new;
end;
$$;

-- upsert_inspection_checks: input_kind presence-merges like every column ------
create or replace function public.upsert_inspection_checks(
  p_account_id    uuid,
  p_inspection_id uuid,
  p_checks        jsonb
)
returns setof public.inspection_checks
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_completed timestamptz;
begin
  select completed_at into v_completed
    from public.inspections
    where account_id = p_account_id and id = p_inspection_id and deleted_at is null;
  if not found then
    raise exception 'inspection_not_found' using errcode = 'P0002';
  end if;
  if v_completed is not null then
    raise exception 'inspection is completed' using errcode = 'check_violation';
  end if;

  return query
  insert into public.inspection_checks
    (account_id, inspection_id, field_key, label, group_label, value, sort_order, input_kind, answered_by, answered_at)
  select
    p_account_id, p_inspection_id,
    e->>'field_key',
    case when e ? 'label' then coalesce(e->>'label', e->>'field_key')
         else coalesce(ex.label, e->>'field_key') end,
    case when e ? 'group_label' then e->>'group_label' else ex.group_label end,
    case when not (e ? 'value')                 then ex.value
         when jsonb_typeof(e->'value') = 'null' then null::jsonb
         else e->'value' end,
    case when e ? 'sort_order' then nullif(e->>'sort_order', '')::int else ex.sort_order end,
    case when e ? 'input_kind' then e->>'input_kind' else ex.input_kind end,
    case when not (e ? 'value')                 then ex.answered_by
         when jsonb_typeof(e->'value') = 'null' then null
         else (select auth.uid()) end,
    case when not (e ? 'value')                 then ex.answered_at
         when jsonb_typeof(e->'value') = 'null' then null
         else now() end
  from jsonb_array_elements(p_checks) as e
  left join public.inspection_checks ex
    on ex.inspection_id = p_inspection_id
   and ex.field_key = e->>'field_key'
   and ex.deleted_at is null
  where coalesce(e->>'field_key', '') <> ''
  on conflict (inspection_id, field_key) where deleted_at is null
  do update set
    label       = excluded.label,
    group_label = excluded.group_label,
    value       = excluded.value,
    sort_order  = excluded.sort_order,
    input_kind  = excluded.input_kind,
    answered_by = excluded.answered_by,
    answered_at = excluded.answered_at,
    updated_at  = now()
  returning *;
end;
$$;

grant execute on function public.upsert_inspection_checks(uuid, uuid, jsonb) to authenticated;

-- tenant_upsert_inspection_checks: same, tenant stamping rules unchanged ------
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

  perform public._tenant_stamp_form_started(p_account_id, p_inspection_id);

  return query
  insert into public.inspection_checks
    (account_id, inspection_id, field_key, label, group_label, value, sort_order, input_kind, answered_by, answered_at)
  select
    p_account_id, p_inspection_id,
    e->>'field_key',
    case when e ? 'label' then coalesce(e->>'label', e->>'field_key')
         else coalesce(ex.label, e->>'field_key') end,
    case when e ? 'group_label' then e->>'group_label' else ex.group_label end,
    case when not (e ? 'value')                 then ex.value
         when jsonb_typeof(e->'value') = 'null' then null::jsonb
         else e->'value' end,
    case when e ? 'sort_order' then nullif(e->>'sort_order', '')::int else ex.sort_order end,
    case when e ? 'input_kind' then e->>'input_kind' else ex.input_kind end,
    case when not (e ? 'value')                 then ex.answered_by
         when jsonb_typeof(e->'value') = 'null' then null
         else ex.answered_by end,
    case when not (e ? 'value')                 then ex.answered_at
         when jsonb_typeof(e->'value') = 'null' then null
         else now() end
  from jsonb_array_elements(p_checks) as e
  left join public.inspection_checks ex
    on ex.inspection_id = p_inspection_id
   and ex.field_key = e->>'field_key'
   and ex.deleted_at is null
  where coalesce(e->>'field_key', '') <> ''
  on conflict (inspection_id, field_key) where deleted_at is null
  do update set
    label       = excluded.label,
    group_label = excluded.group_label,
    value       = excluded.value,
    sort_order  = excluded.sort_order,
    input_kind  = excluded.input_kind,
    answered_by = excluded.answered_by,
    answered_at = excluded.answered_at,
    updated_at  = now()
  returning *;
end;
$$;

-- SECURITY DEFINER ACL re-assertion (see 20260628000009 + CI guard).
revoke execute on function public.tenant_upsert_inspection_checks(uuid, uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.tenant_upsert_inspection_checks(uuid, uuid, uuid, jsonb) to service_role;
