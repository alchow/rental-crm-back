-- ----------------------------------------------------------------------------
-- Per-unit inspection layout: an INERT template-trim delta store.
--
-- Landlords start from a base inspection template and trim it per unit ("this
-- unit has no garage; add a second balcony"). The frontend stores that trim as
-- a delta DOCUMENT keyed by (area_id x template_id) -- NOT a forked template.
-- One physical row per unit+template records which sections/items/checks the
-- landlord removed and which loose items/checks they added on top of the base.
--
-- The backend is deliberately DUMB about the document's contents: `layout` is
-- opaque jsonb, and no key here is validated against the template's schema. The
-- frontend recomputes effective membership on every apply (a removed key that
-- no longer exists in a re-published base template is simply a no-op there), so
-- the store never needs to know the template's shape. GET 404 means "no memory
-- for this pair" (render the standard form); PUT is an idempotent whole-document
-- upsert; DELETE resets the unit back to the standard form.
--
-- New-table checklist (mirrors 20260628000002_condition_reports_items_checks):
--   composite FKs on (account_id, area_id)/(account_id, template_id) so a
--   cross-account area/template dies on the FK, not just under RLS;
--   (account_id) + (area_id) indexes; RLS enable+force with the ADR-0003 form B
--   member-all policy (initplan IN-subquery, not a per-row helper call); and an
--   explicit _emit_event audit trigger (the Phase 3 trigger loop predates this
--   table, so it must be attached by name).
-- ----------------------------------------------------------------------------

create table public.area_inspection_layouts (
  id                    uuid primary key default gen_random_uuid(),
  account_id            uuid not null,
  area_id               uuid not null,
  template_id           uuid not null,
  base_template_version text check (base_template_version is null or length(base_template_version) between 1 and 100),
  layout                jsonb not null default '{}'::jsonb,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  deleted_at            timestamptz,
  foreign key (account_id, area_id)     references public.areas(account_id, id)                on delete cascade,
  foreign key (account_id, template_id) references public.inspection_templates(account_id, id) on delete cascade,
  -- TOTAL unique (not partial-on-deleted_at): PostgREST on_conflict cannot
  -- express a partial arbiter, and totality is what lets a re-PUT after
  -- DELETE revive the tombstone (one physical row per area+template, ever).
  constraint area_inspection_layouts_area_template_uniq unique (area_id, template_id),
  unique (account_id, id)
);

create index area_inspection_layouts_account_id_idx on public.area_inspection_layouts (account_id);
create index area_inspection_layouts_area_id_idx    on public.area_inspection_layouts (area_id);

-- RLS: ADR-0003 form B (initplan IN-subquery), NOT the is_account_member
-- helper -- a per-row helper call re-introduces the cost ADR-0003 removed.
alter table public.area_inspection_layouts enable row level security;
alter table public.area_inspection_layouts force  row level security;
create policy area_inspection_layouts_member_all on public.area_inspection_layouts
  for all
  using (account_id in (
    select m.account_id from public.account_members m
     where m.user_id = (select auth.uid()) and m.deleted_at is null))
  with check (account_id in (
    select m.account_id from public.account_members m
     where m.user_id = (select auth.uid()) and m.deleted_at is null));

-- Grants: newer Supabase stacks no longer hand anon/authenticated DML on new
-- tables via default privileges (same reason 20260718000007 grants
-- explicitly), so RLS alone leaves members with "permission denied". Members
-- get row-level CRUD minus hard DELETE (delete is a softDeleteStamp UPDATE;
-- cascades run as the table owner); RLS scopes every statement.
revoke all on public.area_inspection_layouts from public, anon, authenticated;
grant select, insert, update on public.area_inspection_layouts to authenticated;
grant all on public.area_inspection_layouts to service_role;

-- Audit: the phase-3 trigger loop predates this table, so attach explicitly
-- (same as documents.sql / inspection_checks).
create trigger area_inspection_layouts_audit
  after insert or update or delete on public.area_inspection_layouts
  for each row execute function public._emit_event();
