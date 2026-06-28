-- ----------------------------------------------------------------------------
-- Phase 27 (1/6): condition reports -- extend inspections into tenancy-bound
-- move-in / move-out condition forms.
--
-- The inspections subsystem (Phase 8) already captures area/items/photos,
-- locks on completion, and renders a deterministic content-hashed PDF. This
-- migration extends it -- ALL additive / nullable / defaulted, so existing
-- area inspections are untouched -- with:
--   * kind                    -- move_in | move_out | periodic | general
--   * tenancy_id              -- links a report to its tenancy (composite FK)
--   * baseline_inspection_id  -- checkout -> the checkin it is compared against
--   * status                  -- capture lifecycle (draft .. completed .. voided)
--   * capture_mode            -- who fills it (landlord | tenant | collaborative)
--   * supersedes_inspection_id, voided_at, void_reason -- correction path
--   * template_snapshot, subject_snapshot -- self-contained evidence
--
-- It also (a) widens the completion-lock trigger so the ONLY permitted
-- post-completion changes are soft-delete and voiding (neither mutates report
-- data), and (b) adds a coherence trigger so a tenancy-bound inspection sits
-- on the tenancy's unit area and a checkout's baseline is a completed move-in
-- of the same tenancy.
-- ----------------------------------------------------------------------------

alter table public.inspections
  add column kind text not null default 'general'
    check (kind in ('move_in', 'move_out', 'periodic', 'general')),
  add column tenancy_id uuid,
  add column baseline_inspection_id uuid,
  add column status text not null default 'draft'
    check (status in ('draft', 'tenant_submitted', 'landlord_reviewed', 'completed', 'voided')),
  add column capture_mode text not null default 'landlord'
    check (capture_mode in ('landlord', 'tenant', 'collaborative')),
  add column supersedes_inspection_id uuid,
  add column voided_at timestamptz,
  add column void_reason text
    check (void_reason is null or length(void_reason) between 1 and 2000),
  add column template_snapshot jsonb,
  add column subject_snapshot jsonb;

-- Same-account composite FKs: a row can never point across accounts.
alter table public.inspections
  add constraint inspections_tenancy_fk
    foreign key (account_id, tenancy_id)
    references public.tenancies(account_id, id) on delete restrict,
  add constraint inspections_baseline_fk
    foreign key (account_id, baseline_inspection_id)
    references public.inspections(account_id, id) on delete restrict,
  add constraint inspections_supersedes_fk
    foreign key (account_id, supersedes_inspection_id)
    references public.inspections(account_id, id) on delete restrict;

create index inspections_kind_idx   on public.inspections (kind);
create index inspections_status_idx on public.inspections (status);
create index inspections_tenancy_id_idx
  on public.inspections (tenancy_id) where tenancy_id is not null;
create index inspections_baseline_idx
  on public.inspections (baseline_inspection_id) where baseline_inspection_id is not null;

-- Widen the completion lock BEFORE the status backfill below (which touches
-- already-completed rows this trigger guards). A completed inspection's report
-- data stays immutable; the only permitted post-completion changes are
-- soft-delete (deleted_at) and the void transition (status->'voided' plus
-- voided_at / void_reason / supersedes_inspection_id). Everything probative is
-- locked. The trigger fn is replaced in place; the Phase-8 trigger keeps using it.
create or replace function public._reject_completed_inspection_update()
returns trigger
language plpgsql
as $$
begin
  if OLD.completed_at is not null then
    if NEW.completed_at               =                  OLD.completed_at
       and NEW.area_id                =                  OLD.area_id
       and NEW.kind                   =                  OLD.kind
       and NEW.capture_mode           =                  OLD.capture_mode
       and NEW.tenancy_id             is not distinct from OLD.tenancy_id
       and NEW.baseline_inspection_id is not distinct from OLD.baseline_inspection_id
       and NEW.template_id            is not distinct from OLD.template_id
       and NEW.performed_by           is not distinct from OLD.performed_by
       and NEW.performed_at           is not distinct from OLD.performed_at
       and NEW.notes                  is not distinct from OLD.notes
       and NEW.template_snapshot      is not distinct from OLD.template_snapshot
       and NEW.subject_snapshot       is not distinct from OLD.subject_snapshot
       and NEW.status                 in ('completed', 'voided')
    then
      -- Only deleted_at / status->voided / voided_at / void_reason /
      -- supersedes_inspection_id / updated_at may differ.
      return NEW;
    end if;
    raise exception 'inspection % is completed and cannot be modified', OLD.id
      using errcode = 'check_violation';
  end if;
  return NEW;
end;
$$;

-- Backfill existing completed inspections to status='completed'. The column
-- default 'draft' was applied as DDL metadata (fires no row triggers); this
-- UPDATE only touches the small set of already-completed rows. If the
-- inspections table is ever large in prod, run this UPDATE operationally
-- instead (one audit event per row), per the tenancy-status-advance precedent.
update public.inspections
   set status = 'completed', updated_at = now()
 where completed_at is not null;

-- Coherence: tenancy-bound inspections sit on the tenancy's unit area;
-- move-in/out must name a tenancy; a checkout baseline must be a completed
-- move-in of the same tenancy. Point-in-time validation -- a later edit to the
-- tenancy's area cannot retro-break a written inspection, and the frozen PDF
-- preserves the area name/kind regardless. SECURITY INVOKER (default), mirroring
-- _assert_area_is_unit: RLS lets a member read their own tenancy/inspection rows.
create or replace function public._assert_inspection_coherence()
returns trigger
language plpgsql
as $$
declare
  v_area           uuid;
  v_base_tenancy   uuid;
  v_base_completed timestamptz;
begin
  if NEW.kind in ('move_in', 'move_out') and NEW.tenancy_id is null then
    raise exception 'kind % requires a tenancy_id', NEW.kind
      using errcode = 'check_violation';
  end if;

  if NEW.tenancy_id is not null then
    select area_id into v_area
      from public.tenancies
      where account_id = NEW.account_id and id = NEW.tenancy_id and deleted_at is null;
    if v_area is null then
      raise exception 'tenancy % not found in account', NEW.tenancy_id
        using errcode = 'check_violation';
    end if;
    if v_area <> NEW.area_id then
      raise exception 'inspection area % does not match tenancy unit area %', NEW.area_id, v_area
        using errcode = 'check_violation';
    end if;
  end if;

  if NEW.baseline_inspection_id is not null then
    if NEW.kind <> 'move_out' then
      raise exception 'baseline_inspection_id is only valid for kind=move_out'
        using errcode = 'check_violation';
    end if;
    select tenancy_id, completed_at
      into v_base_tenancy, v_base_completed
      from public.inspections
      where account_id = NEW.account_id and id = NEW.baseline_inspection_id;
    if v_base_completed is null then
      raise exception 'baseline inspection must exist and be completed'
        using errcode = 'check_violation';
    end if;
    if v_base_tenancy is distinct from NEW.tenancy_id then
      raise exception 'baseline inspection belongs to a different tenancy'
        using errcode = 'check_violation';
    end if;
  end if;

  return NEW;
end;
$$;

create trigger inspections_coherence
  before insert or update of kind, tenancy_id, area_id, baseline_inspection_id
  on public.inspections
  for each row execute function public._assert_inspection_coherence();
