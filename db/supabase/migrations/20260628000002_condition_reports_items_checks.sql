-- ----------------------------------------------------------------------------
-- Phase 27 (2/6): condition-report items, typed checks, template metadata.
--
-- (A) inspection_items gains the fields that make a move-out deterministically
--     comparable to its move-in baseline: item_key (the stable diff/upsert
--     key), group_label (the room/section), change_type (the move-out verdict),
--     and sort_order (canonical A->R rendering order).
--
-- (B) inspection_checks is a NEW typed child for the form's non-condition
--     fields -- yes/no toggles ("smoke alarm tested?"), scalars, and key counts
--     ("Number of Keys: Received/Returned"). value is jsonb so a boolean, a
--     number, or a string all fit; the diff pairs checks by field_key, so a
--     key's Received (move-in) and Returned (move-out) line up automatically.
--
-- (C) inspection_templates gains jurisdiction + version (US is state-by-state).
-- ----------------------------------------------------------------------------

-- (A) ------------------------------------------------------------------------
alter table public.inspection_items
  add column item_key text
    check (item_key is null or length(item_key) between 1 and 200),
  add column group_label text
    check (group_label is null or length(group_label) between 1 and 200),
  add column change_type text
    check (change_type is null or change_type in
      ('unchanged', 'normal_wear', 'damage', 'not_present_at_baseline', 'new_at_checkout')),
  add column sort_order int;

-- Stable key per inspection: the join key for the checkout diff and the
-- convergent key for offline batch upserts. Partial (live rows, keyed rows).
create unique index inspection_items_inspection_item_key_uniq
  on public.inspection_items (inspection_id, item_key)
  where item_key is not null and deleted_at is null;

-- (C) ------------------------------------------------------------------------
alter table public.inspection_templates
  add column jurisdiction text
    check (jurisdiction is null or length(jurisdiction) between 1 and 100),
  add column version text
    check (version is null or length(version) between 1 and 50);

-- (B) ------------------------------------------------------------------------
create table public.inspection_checks (
  id             uuid primary key default gen_random_uuid(),
  account_id     uuid not null,
  inspection_id  uuid not null,
  field_key      text not null check (length(field_key) between 1 and 200),
  label          text not null check (length(label) between 1 and 200),
  group_label    text check (group_label is null or length(group_label) between 1 and 200),
  -- typed answer: boolean / number / string all serialize into jsonb.
  value          jsonb,
  sort_order     int,
  answered_by    uuid references auth.users(id) on delete set null,
  answered_at    timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  deleted_at     timestamptz,
  foreign key (account_id, inspection_id) references public.inspections(account_id, id) on delete cascade,
  unique (account_id, id)
);
create index inspection_checks_account_id_idx    on public.inspection_checks (account_id);
create index inspection_checks_inspection_id_idx on public.inspection_checks (inspection_id);
-- One live check per field per inspection: the diff-join + upsert key.
create unique index inspection_checks_inspection_field_key_uniq
  on public.inspection_checks (inspection_id, field_key)
  where deleted_at is null;

-- RLS: ADR-0003 form B (initplan IN-subquery), NOT the is_account_member
-- helper -- a per-row helper call re-introduces the cost ADR-0003 removed.
alter table public.inspection_checks enable row level security;
alter table public.inspection_checks force  row level security;
create policy inspection_checks_member_all on public.inspection_checks
  for all
  using (account_id in (
    select m.account_id from public.account_members m
     where m.user_id = (select auth.uid()) and m.deleted_at is null))
  with check (account_id in (
    select m.account_id from public.account_members m
     where m.user_id = (select auth.uid()) and m.deleted_at is null));

-- Audit: the phase-3 trigger loop predates this table, so attach explicitly
-- (same as documents.sql).
create trigger inspection_checks_audit
  after insert or update or delete on public.inspection_checks
  for each row execute function public._emit_event();

-- Immutable once the parent inspection is completed -- mirrors
-- _reject_item_update_on_completed_inspection (Phase 8) for items.
create or replace function public._reject_check_update_on_completed_inspection()
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
    raise exception 'parent inspection % is completed; checks are immutable', v_inspection_id
      using errcode = 'check_violation';
  end if;
  return case TG_OP when 'DELETE' then OLD else NEW end;
end;
$$;

create trigger inspection_checks_immutable_when_parent_completed
  before insert or update or delete on public.inspection_checks
  for each row execute function public._reject_check_update_on_completed_inspection();
