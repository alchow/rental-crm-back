-- ----------------------------------------------------------------------------
-- Phase 27 (6/6): condition-report RPCs.
--
-- All SECURITY INVOKER (RLS in force; auth.uid() drives the audit actor),
-- modelled on create_tenancy_document. Error contract (mapped by the API):
--   P0002          -> 404   (not found / not in a valid state)
--   check_violation -> 409  (wrong kind / not completed / completed-and-locked)
--   23514          -> 400   (bad enum value, e.g. change_type)
--   42501          -> 403   (RLS denial)
-- ----------------------------------------------------------------------------

-- seed_inspection_items_from_template -----------------------------------------
-- Expand a template's schema (sections[].items[] / sections[].checks[]) into
-- concrete inspection_items + inspection_checks. Idempotent (on-conflict do
-- nothing on the live keyed rows). Returns the full current item/check set.
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
        (account_id, inspection_id, field_key, label, group_label, sort_order)
      values
        (p_account_id, p_inspection_id,
         v_section_key || '/' || (v_check->>'key'),
         coalesce(v_check->>'label', v_check->>'key'),
         v_section_label,
         nullif(v_check->>'sort', '')::int)
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

-- emit_inspection_report_document ---------------------------------------------
-- Point a tenant document at the rendered, content-hashed inspection report.
-- Idempotent on content_hash; a changed renderer bumps version_no on the same
-- (one-per-inspection) document.
create or replace function public.emit_inspection_report_document(
  p_account_id    uuid,
  p_inspection_id uuid,
  p_attachment_id uuid,
  p_content_hash  text,
  p_size_bytes    bigint,
  p_title         text,
  p_requires_ack  boolean default true
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_kind          text;
  v_tenancy       uuid;
  v_completed     timestamptz;
  v_doc           public.documents;
  v_ver           public.document_versions;
  v_existing_doc  uuid;
  v_next_ver      int;
begin
  select kind, tenancy_id, completed_at into v_kind, v_tenancy, v_completed
    from public.inspections
    where account_id = p_account_id and id = p_inspection_id and deleted_at is null;
  if not found then
    raise exception 'inspection_not_found' using errcode = 'P0002';
  end if;
  if v_completed is null then
    raise exception 'inspection_not_completed' using errcode = 'P0002';
  end if;
  if v_kind not in ('move_in', 'move_out') then
    raise exception 'kind % does not emit a tenant document', v_kind using errcode = 'check_violation';
  end if;
  if v_tenancy is null then
    raise exception 'inspection has no tenancy' using errcode = 'check_violation';
  end if;

  select id into v_existing_doc
    from public.documents
    where account_id = p_account_id and inspection_id = p_inspection_id and deleted_at is null;

  if v_existing_doc is not null then
    -- same bytes already published -> return as-is (true idempotent re-run).
    select * into v_ver
      from public.document_versions
      where account_id = p_account_id and document_id = v_existing_doc
        and content_hash = p_content_hash and deleted_at is null
      order by version_no desc limit 1;
    if found then
      select * into v_doc from public.documents where id = v_existing_doc;
      return jsonb_build_object('document', to_jsonb(v_doc), 'version', to_jsonb(v_ver));
    end if;
    -- renderer changed -> new version on the same document.
    select coalesce(max(version_no), 0) + 1 into v_next_ver
      from public.document_versions
      where account_id = p_account_id and document_id = v_existing_doc;
    insert into public.document_versions
      (account_id, document_id, version_no, source, attachment_id, content_hash,
       mime_type, size_bytes, created_by)
    values
      (p_account_id, v_existing_doc, v_next_ver, 'inspection_report', p_attachment_id,
       p_content_hash, 'application/pdf', p_size_bytes, (select auth.uid()))
    returning * into v_ver;
    select * into v_doc from public.documents where id = v_existing_doc;
    return jsonb_build_object('document', to_jsonb(v_doc), 'version', to_jsonb(v_ver));
  end if;

  insert into public.documents
    (account_id, tenancy_id, document_type, title, requires_ack, published_at, created_by, inspection_id)
  values
    (p_account_id, v_tenancy, v_kind, p_title, coalesce(p_requires_ack, true), now(),
     (select auth.uid()), p_inspection_id)
  returning * into v_doc;

  insert into public.document_versions
    (account_id, document_id, version_no, source, attachment_id, content_hash,
     mime_type, size_bytes, created_by)
  values
    (p_account_id, v_doc.id, 1, 'inspection_report', p_attachment_id, p_content_hash,
     'application/pdf', p_size_bytes, (select auth.uid()))
  returning * into v_ver;

  return jsonb_build_object('document', to_jsonb(v_doc), 'version', to_jsonb(v_ver));
end;
$$;

-- start_checkout_from_checkin -------------------------------------------------
-- Create a move_out inspection pre-keyed from a completed move-in: copies the
-- item + check SKELETON (keys/labels) but resets captured values -- the
-- check-out condition must be observed fresh, never inherited.
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
    (account_id, inspection_id, field_key, label, group_label, sort_order)
  select p_account_id, v_new.id, ck.field_key, ck.label, ck.group_label, ck.sort_order
    from public.inspection_checks ck
    where ck.account_id = p_account_id and ck.inspection_id = v_base.id
      and ck.deleted_at is null;

  return v_new;
end;
$$;

-- inspection_checkout_diff ----------------------------------------------------
-- Pair a move_out against its baseline move_in: items by item_key, checks by
-- field_key (FULL OUTER JOIN). Drives the itemized deduction statement.
create or replace function public.inspection_checkout_diff(
  p_account_id             uuid,
  p_checkout_inspection_id uuid
)
returns table (
  row_type             text,
  key                  text,
  group_label          text,
  label                text,
  baseline_id          uuid,
  checkout_id          uuid,
  baseline_value       text,
  checkout_value       text,
  change_type          text,
  status               text,
  baseline_photo_count int,
  checkout_photo_count int
)
language plpgsql
stable
security invoker
set search_path = public
as $$
-- The RETURNS TABLE output columns (key, group_label, label, change_type,
-- status) share names with columns referenced in the subqueries below; tell
-- PL/pgSQL to resolve unqualified identifiers to the COLUMN, not the OUT var.
#variable_conflict use_column
declare
  v_kind     text;
  v_baseline uuid;
begin
  select kind, baseline_inspection_id into v_kind, v_baseline
    from public.inspections
    where account_id = p_account_id and id = p_checkout_inspection_id and deleted_at is null;
  if not found then
    raise exception 'inspection_not_found' using errcode = 'P0002';
  end if;
  if v_kind <> 'move_out' then
    raise exception 'not a move_out inspection' using errcode = 'check_violation';
  end if;
  if v_baseline is null then
    raise exception 'no baseline to compare' using errcode = 'check_violation';
  end if;

  return query
  with
  base_items as (
    select it.id, it.item_key, it.group_label, it.label, it.condition
      from public.inspection_items it
      where it.account_id = p_account_id and it.inspection_id = v_baseline
        and it.deleted_at is null and it.item_key is not null
  ),
  co_items as (
    select it.id, it.item_key, it.group_label, it.label, it.condition, it.change_type
      from public.inspection_items it
      where it.account_id = p_account_id and it.inspection_id = p_checkout_inspection_id
        and it.deleted_at is null and it.item_key is not null
  ),
  item_photos as (
    select a.entity_id as item_id, count(*)::int as n
      from public.attachments a
      where a.account_id = p_account_id and a.entity_type = 'inspection_items'
        and a.deleted_at is null and a.derived_from is null
      group by a.entity_id
  )
  select
    'item'::text,
    coalesce(b.item_key, c.item_key),
    coalesce(c.group_label, b.group_label),
    coalesce(c.label, b.label),
    b.id, c.id,
    b.condition, c.condition,
    c.change_type,
    case when b.id is null then 'added_at_checkout'
         when c.id is null then 'missing_at_checkout'
         else 'matched' end,
    coalesce(bp.n, 0), coalesce(cp.n, 0)
  from base_items b
  full outer join co_items c on c.item_key = b.item_key
  left join item_photos bp on bp.item_id = b.id
  left join item_photos cp on cp.item_id = c.id

  union all

  select
    'check'::text,
    coalesce(b.field_key, c.field_key),
    coalesce(c.group_label, b.group_label),
    coalesce(c.label, b.label),
    b.id, c.id,
    b.value #>> '{}', c.value #>> '{}',
    null::text,
    case when b.id is null then 'added_at_checkout'
         when c.id is null then 'missing_at_checkout'
         else 'matched' end,
    0, 0
  from (
    select id, field_key, group_label, label, value
      from public.inspection_checks
      where account_id = p_account_id and inspection_id = v_baseline and deleted_at is null
  ) b
  full outer join (
    select id, field_key, group_label, label, value
      from public.inspection_checks
      where account_id = p_account_id and inspection_id = p_checkout_inspection_id and deleted_at is null
  ) c on c.field_key = b.field_key;
end;
$$;

-- upsert_inspection_items -----------------------------------------------------
-- Batch upsert by item_key (offline/field re-sync where request-level
-- Idempotency-Key is too coarse). Rejected once the parent is completed.
create or replace function public.upsert_inspection_items(
  p_account_id    uuid,
  p_inspection_id uuid,
  p_items         jsonb
)
returns setof public.inspection_items
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
  insert into public.inspection_items
    (account_id, inspection_id, label, item_key, group_label, condition, notes, change_type, sort_order)
  select
    p_account_id, p_inspection_id,
    coalesce(e->>'label', e->>'item_key'),
    e->>'item_key',
    e->>'group_label',
    e->>'condition',
    e->>'notes',
    e->>'change_type',
    nullif(e->>'sort_order', '')::int
  from jsonb_array_elements(p_items) as e
  where coalesce(e->>'item_key', '') <> ''
  on conflict (inspection_id, item_key) where item_key is not null and deleted_at is null
  do update set
    label       = excluded.label,
    group_label = excluded.group_label,
    condition   = excluded.condition,
    notes       = excluded.notes,
    change_type = excluded.change_type,
    sort_order  = excluded.sort_order,
    updated_at  = now()
  returning *;
end;
$$;

-- void_inspection -------------------------------------------------------------
-- Mark an inspection void (a correction path). On a completed inspection this
-- is one of the only two permitted post-completion transitions (the other is
-- soft-delete); it never mutates report data. The corrected replacement is a
-- new inspection created with supersedes_inspection_id = this one.
create or replace function public.void_inspection(
  p_account_id    uuid,
  p_inspection_id uuid,
  p_reason        text
)
returns public.inspections
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_row public.inspections;
begin
  update public.inspections
     set status      = 'voided',
         voided_at   = now(),
         void_reason = p_reason,
         updated_at  = now()
   where account_id = p_account_id and id = p_inspection_id
     and deleted_at is null and status <> 'voided'
  returning * into v_row;
  if not found then
    raise exception 'inspection_not_found_or_already_voided' using errcode = 'P0002';
  end if;
  return v_row;
end;
$$;

-- upsert_inspection_checks ----------------------------------------------------
-- Batch upsert typed checks by field_key (member path). Sets answered_by/at to
-- the caller. value stays jsonb (boolean / number / string). Rejected once the
-- parent is completed.
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
    (account_id, inspection_id, field_key, label, group_label, value, sort_order, answered_by, answered_at)
  select
    p_account_id, p_inspection_id,
    e->>'field_key',
    coalesce(e->>'label', e->>'field_key'),
    e->>'group_label',
    e->'value',
    nullif(e->>'sort_order', '')::int,
    (select auth.uid()),
    now()
  from jsonb_array_elements(p_checks) as e
  where coalesce(e->>'field_key', '') <> ''
  on conflict (inspection_id, field_key) where deleted_at is null
  do update set
    label       = excluded.label,
    group_label = excluded.group_label,
    value       = excluded.value,
    sort_order  = excluded.sort_order,
    answered_by = excluded.answered_by,
    answered_at = excluded.answered_at,
    updated_at  = now()
  returning *;
end;
$$;

grant execute on function public.seed_inspection_items_from_template(uuid, uuid, uuid) to authenticated;
grant execute on function public.emit_inspection_report_document(uuid, uuid, uuid, text, bigint, text, boolean) to authenticated;
grant execute on function public.start_checkout_from_checkin(uuid, uuid, timestamptz, uuid, text) to authenticated;
grant execute on function public.inspection_checkout_diff(uuid, uuid) to authenticated;
grant execute on function public.upsert_inspection_items(uuid, uuid, jsonb) to authenticated;
grant execute on function public.upsert_inspection_checks(uuid, uuid, jsonb) to authenticated;
grant execute on function public.void_inspection(uuid, uuid, text) to authenticated;
