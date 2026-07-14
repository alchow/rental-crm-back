-- ----------------------------------------------------------------------------
-- Inspection checks: presence-merge upserts + honest answered_* stamping.
--
-- The original upsert RPCs (20260628000006 landlord, 20260701000001 tenant)
-- had two defects, both reported by the field frontend and confirmed here:
--
--   (1) DO UPDATE replaced EVERY column from `excluded`, so a payload that
--       omitted a key erased it: a value-only offline sync wiped group_label
--       and sort_order and reset label to the raw field_key (corrupting PDF
--       grouping and the checkout diff), and a Build-step metadata re-save
--       erased previously captured values.
--   (2) answered_by/answered_at were stamped unconditionally, so re-saving an
--       UNANSWERED check recorded it as answered by the caller.
--
-- Fix: presence-merge. The INSERT's SELECT left-joins the existing live row
-- and resolves each column BEFORE insertion (payload key present -> new
-- value; absent -> preserve existing), so `excluded` already carries the
-- merged row and the DO UPDATE can stay a plain column copy. The SELECT reads
-- the pre-statement snapshot; the tiny read-merge window is the same
-- last-write-wins the old code had.
--
-- `value` semantics (drives the answered_* stamp):
--   * key absent           -> preserve value AND answered_by/answered_at
--   * present, non-null    -> set value; stamp answered_by/answered_at
--   * present, JSON null   -> explicit un-answer: value = SQL NULL and
--                             answered_by/answered_at cleared
--
-- NOTE: payload rows must be unique by field_key (a duplicate raises 21000,
-- "ON CONFLICT DO UPDATE cannot affect row a second time" -- pre-existing
-- behavior; clients dedupe before POST).
--
-- Also heals rows the old stamping already mislabeled: draft inspections only
-- (completed ones are trigger-immutable and their reports already rendered).
-- ----------------------------------------------------------------------------

-- upsert_inspection_checks (landlord/member path) -----------------------------
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
    case when e ? 'label' then coalesce(e->>'label', e->>'field_key')
         else coalesce(ex.label, e->>'field_key') end,
    case when e ? 'group_label' then e->>'group_label' else ex.group_label end,
    case when not (e ? 'value')                 then ex.value
         when jsonb_typeof(e->'value') = 'null' then null::jsonb
         else e->'value' end,
    case when e ? 'sort_order' then nullif(e->>'sort_order', '')::int else ex.sort_order end,
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
    answered_by = excluded.answered_by,
    answered_at = excluded.answered_at,
    updated_at  = now()
  returning *;
end;
$$;

grant execute on function public.upsert_inspection_checks(uuid, uuid, jsonb) to authenticated;

-- tenant_upsert_inspection_checks (capture magic-link path) --------------------
-- Same merge; tenant rows never carry answered_by EXCEPT that an explicit
-- JSON-null un-answer clears it (a tenant clearing a value must not leave a
-- stale landlord attribution behind).
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
    (account_id, inspection_id, field_key, label, group_label, value, sort_order, answered_by, answered_at)
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
    answered_by = excluded.answered_by,
    answered_at = excluded.answered_at,
    updated_at  = now()
  returning *;
end;
$$;

-- SECURITY DEFINER ACL re-assertion (see 20260628000009 + the CI guard
-- db/test/check_definer_grants.sql): Supabase default ACLs make functions
-- anon/authenticated-callable, and a future drop+recreate would re-acquire
-- them. This function is capture-token brokered and service_role-only.
revoke execute on function public.tenant_upsert_inspection_checks(uuid, uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.tenant_upsert_inspection_checks(uuid, uuid, uuid, jsonb) to service_role;

-- Heal: un-answer rows the old stamp mislabeled --------------------------------
-- Both null encodings occur in the wild: SQL NULL (payload omitted `value`)
-- and jsonb 'null' (payload sent "value": null). Draft inspections only:
-- completed ones are trigger-immutable and their reports already rendered --
-- rewriting their rows would falsify emitted evidence.
update public.inspection_checks c
   set answered_by = null,
       answered_at = null,
       updated_at  = now()
  from public.inspections i
 where i.account_id = c.account_id
   and i.id = c.inspection_id
   and c.deleted_at is null
   and c.answered_at is not null
   and (c.value is null or jsonb_typeof(c.value) = 'null')
   and i.completed_at is null;
