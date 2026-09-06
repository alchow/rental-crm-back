-- Lease lifecycle (ADR-0014).
--
-- SCOPE: three nullable columns on public.leases (voided_at, void_reason,
-- corrects_lease_id) with their constraints and index; the lease guard
-- rewritten around lifecycle status; the rent-schedule anchor guard and
-- change_tenancy_rent refuse draft/voided leases; a replace_lease RPC that
-- voids a lease, creates its correction and re-points live schedules in one
-- transaction. No RLS change.
--
-- WHY (frontend BACKEND_ASKS #26; ADR-0014 supersedes ADR-0012 rule 4): what a
-- lease may change follows its lifecycle status, not whether a schedule
-- happens to anchor it. Removal is a void with a reason (there is no delete);
-- a correction is a new lease that names the voided one.
--
-- INVARIANT: an executed (active/expired) lease never changes term_start,
-- rent_amount_cents or rent_currency, and status only moves forward.
-- INVARIANT: a voided lease never changes again; a lease that anchors a live
-- rent schedule cannot be voided.
-- INVARIANT: corrects_lease_id is set at most once and names a voided lease
-- of the same tenancy.
-- INVARIANT: a live rent schedule anchors only a non-draft, non-voided lease.
--
-- No data migration.

-- ============================================================================
-- (1) Lifecycle columns
-- ============================================================================

alter table public.leases
  add column voided_at        timestamptz,
  add column void_reason      text,
  add column corrects_lease_id uuid,
  add constraint leases_void_reason_pairs_check
    check ((voided_at is null) = (void_reason is null)),
  add constraint leases_corrects_self_check
    check (corrects_lease_id is null or corrects_lease_id <> id),
  add constraint leases_corrects_lease_fk
    foreign key (account_id, corrects_lease_id)
    references public.leases (account_id, id) on delete restrict;

create index leases_corrects_lease_id_idx
  on public.leases (corrects_lease_id)
  where corrects_lease_id is not null;

comment on column public.leases.voided_at is
  'When the lease was voided; a voided lease is read-only history and is still listed.';
comment on column public.leases.void_reason is
  'The landlord''s reason for voiding; required exactly when voided_at is set.';
comment on column public.leases.corrects_lease_id is
  'The voided lease of the same tenancy this one corrects; set once, by replace_lease or at create.';

-- ============================================================================
-- (2) Lifecycle guard replaces the anchoring trigger
-- ============================================================================
--
-- Diffs NEW against OLD, so re-sending an unchanged value is a no-op and only a
-- differing value on a frozen field raises. `conflict:` / `invalid:` prefixes
-- are the ones the API maps to 409 / 400.

drop trigger if exists leases_reject_anchored_mutation on public.leases;
drop function if exists public._reject_anchored_lease_mutation();

create or replace function public._leases_guard()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_old     jsonb;
  v_new     jsonb   := to_jsonb(NEW);
  v_changed text[]  := '{}';
  v_col     text;
begin
  if TG_OP = 'INSERT' and NEW.voided_at is not null then
    raise exception 'invalid: a lease cannot be created voided'
      using errcode = 'check_violation';
  end if;

  if TG_OP = 'UPDATE' then
    v_old := to_jsonb(OLD);
    select coalesce(array_agg(k), '{}')
      into v_changed
      from jsonb_object_keys(v_new) as k
     where k not in ('updated_at', 'deleted_at')
       and v_new -> k is distinct from v_old -> k;

    foreach v_col in array array['id', 'account_id', 'tenancy_id', 'created_at'] loop
      if v_col = any(v_changed) then
        raise exception 'invalid: lease % cannot change', v_col
          using errcode = 'check_violation';
      end if;
    end loop;
    if 'corrects_lease_id' = any(v_changed) and OLD.corrects_lease_id is not null then
      raise exception 'invalid: lease corrects_lease_id cannot change'
        using errcode = 'check_violation';
    end if;
  end if;

  if NEW.corrects_lease_id is not null
     and (TG_OP = 'INSERT' or 'corrects_lease_id' = any(v_changed))
     and not exists (
       select 1
         from public.leases t
        where t.account_id = NEW.account_id
          and t.id         = NEW.corrects_lease_id
          and t.tenancy_id = NEW.tenancy_id
          and t.voided_at is not null
          and t.deleted_at is null
     )
  then
    raise exception 'invalid: corrects_lease_id must reference a voided lease of the same tenancy'
      using errcode = 'check_violation';
  end if;

  if TG_OP = 'INSERT' then
    return NEW;
  end if;

  if OLD.voided_at is not null and cardinality(v_changed) > 0 then
    raise exception 'conflict: lease is voided'
      using errcode = 'check_violation';
  end if;

  if OLD.status = 'superseded' and exists (
    select 1
      from unnest(v_changed) as c
     where c not in ('voided_at', 'void_reason', 'corrects_lease_id')
  ) then
    raise exception 'conflict: lease is superseded'
      using errcode = 'check_violation';
  end if;

  if 'status' = any(v_changed)
     and (OLD.status, NEW.status) not in
         (('draft', 'active'), ('draft', 'expired'), ('draft', 'superseded'),
          ('active', 'expired'), ('active', 'superseded'))
  then
    raise exception 'conflict: lease is executed; status cannot change from % to %', OLD.status, NEW.status
      using errcode = 'check_violation';
  end if;

  if OLD.status in ('active', 'expired') then
    foreach v_col in array array['term_start', 'rent_amount_cents', 'rent_currency'] loop
      if v_col = any(v_changed) then
        raise exception 'conflict: lease is executed; % is frozen', v_col
          using errcode = 'check_violation';
      end if;
    end loop;
  end if;

  -- Voiding takes the tenancy's schedule-writer lock so an anchor cannot race in.
  if OLD.voided_at is null and NEW.voided_at is not null then
    perform pg_advisory_xact_lock(hashtextextended('rent_change:' || OLD.tenancy_id::text, 0));
    if exists (
      select 1
        from public.rent_schedules s
       where s.account_id      = OLD.account_id
         and s.source_lease_id = OLD.id
         and s.deleted_at is null
    ) then
      raise exception 'conflict: lease anchors a rent schedule'
        using errcode = 'check_violation';
    end if;
  end if;

  return NEW;
end;
$$;

create trigger leases_guard
  before insert or update on public.leases
  for each row execute function public._leases_guard();

-- ============================================================================
-- (3) A schedule anchors only a non-draft, non-voided lease
-- ============================================================================

create or replace function public._rent_schedules_guard()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  -- (1) serialize every schedule write for this tenancy with the RPC.
  perform pg_advisory_xact_lock(hashtextextended('rent_change:' || NEW.tenancy_id::text, 0));

  -- (2a) lease anchor must belong to the SAME tenancy (composite FK only proves
  --      same account) and be in force. check_violation -> route maps to 400.
  if NEW.source_lease_id is not null then
    if not exists (
      select 1
        from public.leases l
       where l.account_id = NEW.account_id
         and l.id         = NEW.source_lease_id
         and l.tenancy_id = NEW.tenancy_id
         and l.status    <> 'draft'
         and l.voided_at is null
         and l.deleted_at is null
    ) then
      raise exception 'source_lease_id must reference a non-draft, non-voided lease of the same tenancy'
        using errcode = 'check_violation';
    end if;
  end if;

  -- (2b) notice anchor must belong to the SAME tenancy.
  if NEW.source_notice_id is not null then
    if not exists (
      select 1
        from public.notices n
       where n.account_id = NEW.account_id
         and n.id         = NEW.source_notice_id
         and n.tenancy_id = NEW.tenancy_id
         and n.deleted_at is null
    ) then
      raise exception 'source_notice_id must reference a notice of the same tenancy'
        using errcode = 'check_violation';
    end if;
  end if;

  return NEW;
end;
$$;

-- ============================================================================
-- (4) change_tenancy_rent refuses a voided source lease
-- ============================================================================
--
-- Same signature and body as before; step 5 now also reads voided_at.

create or replace function public.change_tenancy_rent(
  p_account_id       uuid,
  p_tenancy_id       uuid,
  p_amount_cents     bigint,
  p_currency         text,
  p_effective_date   date,
  p_due_day          int    default null,
  p_source_lease_id  uuid   default null,
  p_source_notice_id uuid   default null,
  p_change_reason    text   default null,
  p_kind             text   default 'rent',
  p_grace_days       int    default null,
  p_late_fee_cents   bigint default null
)
returns table (
  o_schedule_id          uuid,
  o_ended_schedule_ids   uuid[],
  o_superseded_lease_ids uuid[],
  o_voided_charge_ids    uuid[]
)
language plpgsql
set search_path to 'public'
as $$
declare
  v_tenancy       record;
  v_lease         record;
  v_notice        record;
  v_rec           record;
  v_ended         uuid[] := '{}';
  v_superseded    uuid[] := '{}';
  v_voided        uuid[] := '{}';
  v_cascaded      uuid[] := '{}';
  v_inherit_due   int;
  v_inherit_end   date;
  v_inherit_grace int;
  v_inherit_fee   bigint;
  v_due_day       int;
  v_schedule_id   uuid;
begin
  -- 1. Serialize concurrent rent changes for this tenancy. Two racing changes
  --    would otherwise both read the same "open" schedule set and each end it /
  --    insert a successor, producing overlapping eras.
  perform pg_advisory_xact_lock(hashtextextended('rent_change:' || p_tenancy_id::text, 0));

  -- 2. Input validation (stable `invalid:` prefix).
  if p_amount_cents is null or p_amount_cents < 0 then
    raise exception 'invalid: amount_cents must be >= 0';
  end if;
  if p_currency is null or length(p_currency) <> 3 then
    raise exception 'invalid: currency must be a 3-letter code';
  end if;
  if p_kind is null or length(p_kind) = 0 or length(p_kind) > 50 then
    raise exception 'invalid: kind must be a non-empty string of at most 50 characters';
  end if;
  if p_effective_date is null then
    raise exception 'invalid: effective_date is required';
  end if;
  -- Policy bounds are checked here as well as by the column CHECKs so the
  -- caller gets the stable `invalid:` prefix (-> 400) instead of a raw
  -- constraint violation surfacing as a 500 through the RPC error mapping.
  if p_grace_days is not null and (p_grace_days < 0 or p_grace_days > 30) then
    raise exception 'invalid: grace_days must be between 0 and 30';
  end if;
  if p_late_fee_cents is not null and p_late_fee_cents <= 0 then
    raise exception 'invalid: late_fee_cents must be greater than 0';
  end if;

  -- 3. Tenancy must exist (account match, not soft-deleted) and not be ended.
  select id, status
    into v_tenancy
    from public.tenancies
   where account_id = p_account_id
     and id         = p_tenancy_id
     and deleted_at is null;
  if v_tenancy.id is null then
    raise exception 'not_found: tenancy';
  end if;
  if v_tenancy.status = 'ended' then
    raise exception 'conflict: tenancy already ended';
  end if;

  -- 4. A rent change must be anchored to an instrument. Both non-null is
  --    allowed (a renewal lease following a rent-increase notice).
  if p_source_lease_id is null and p_source_notice_id is null then
    raise exception 'invalid: a rent change must be anchored to a lease (source_lease_id) or a served notice (source_notice_id)';
  end if;

  -- 5. Lease anchor: must belong to this account AND this tenancy, not deleted.
  --    A draft lease is ACTIVATED by this call (the change is what puts a
  --    pre-created renewal into force). An expired/superseded lease cannot
  --    anchor a new change.
  if p_source_lease_id is not null then
    select id, status, voided_at
      into v_lease
      from public.leases
     where account_id = p_account_id
       and id         = p_source_lease_id
       and tenancy_id = p_tenancy_id
       and deleted_at is null;
    if v_lease.id is null then
      raise exception 'not_found: source lease';
    end if;
    if v_lease.voided_at is not null then
      raise exception 'conflict: source lease is voided';
    end if;
    if v_lease.status in ('expired', 'superseded') then
      raise exception 'conflict: source lease is %', v_lease.status;
    end if;
    if v_lease.status = 'draft' then
      update public.leases
         set status     = 'active',
             updated_at = now()
       where account_id = p_account_id
         and id         = p_source_lease_id;
    end if;
  end if;

  -- 6. Notice anchor: must belong to this account AND this tenancy, not deleted,
  --    AND be SERVED. An unserved (draft) notice is not yet a legal instrument,
  --    so it cannot authorize a rent change -- served_at must be set first. The
  --    not_found path still covers a missing / cross-tenancy / deleted notice.
  if p_source_notice_id is not null then
    select id, served_at
      into v_notice
      from public.notices
     where account_id = p_account_id
       and id         = p_source_notice_id
       and tenancy_id = p_tenancy_id
       and deleted_at is null;
    if v_notice.id is null then
      raise exception 'not_found: source notice';
    end if;
    if v_notice.served_at is null then
      raise exception 'conflict: source notice has not been served (set served_at first)';
    end if;
  end if;

  -- 7. End the open same-kind schedule era(s). "Open" = kind matches, not
  --    deleted, and still covering periods on/after effective_date. We iterate
  --    most-recently-started first so the FIRST row we see is the one whose
  --    due_day the successor inherits when none is passed (step 8).
  --
  --    A schedule that STARTS on/after effective_date cannot simply be ended at
  --    effective_date-1 (that would invert its date range); it signals an
  --    already-planned future change that must be resolved by a human first.
  for v_rec in
    select id, start_date, due_day, end_date, grace_days, late_fee_cents
      from public.rent_schedules
     where account_id = p_account_id
       and tenancy_id = p_tenancy_id
       and kind       = p_kind
       and deleted_at is null
       and (end_date is null or end_date >= p_effective_date)
     order by start_date desc, created_at desc
  loop
    if v_rec.start_date >= p_effective_date then
      raise exception 'conflict: a schedule of kind % starting % conflicts with effective_date %; resolve it first',
        p_kind, v_rec.start_date, p_effective_date;
    end if;
    update public.rent_schedules
       set end_date   = p_effective_date - 1,
           updated_at = now()
     where account_id = p_account_id
       and id         = v_rec.id;
    v_ended := v_ended || v_rec.id;
    if v_inherit_due is null then
      -- Inherit due_day, the (possibly bounded) end_date AND the late-fee
      -- policy from the SAME most-recently-started ended schedule -- captured
      -- from v_rec here BEFORE the update above overwrites the row's end_date.
      -- Inheriting end_date keeps a bounded predecessor's planned end (e.g. a
      -- fixed-term move-out) from silently becoming open-ended on the
      -- successor. The open-set filter above guarantees v_inherit_end is null
      -- or >= p_effective_date, so the successor's
      -- [effective_date, v_inherit_end] range is always valid. The two policy
      -- fields ride the same "one predecessor, one era" rule so a schedule can
      -- never inherit its terms from two different eras.
      v_inherit_due   := v_rec.due_day;
      v_inherit_end   := v_rec.end_date;
      v_inherit_grace := v_rec.grace_days;
      v_inherit_fee   := v_rec.late_fee_cents;
    end if;
  end loop;

  -- 8. due_day for the successor: explicit override, else inherited from the
  --    schedule we just ended. If neither exists there is nothing to inherit.
  v_due_day := coalesce(p_due_day, v_inherit_due);
  if v_due_day is null then
    raise exception 'invalid: due_day is required when no open schedule exists to inherit it from';
  end if;

  -- 9. Append the successor schedule (start_date = effective_date). end_date is
  --    v_inherit_end: the predecessor's planned end when one was inherited (F2),
  --    else null (open-ended) for a fresh era with an explicit due_day.
  --    currency is stored EXACTLY as passed -- the table only length-checks it
  --    and existing rows come from the API un-folded, so we do not case-fold.
  --    The policy fields follow the due_day rule: explicit value wins, else the
  --    predecessor's, else null (a first era with no policy stays unset).
  insert into public.rent_schedules
    (account_id, tenancy_id, kind, amount_cents, currency, due_day,
     start_date, end_date, source_lease_id, source_notice_id, change_reason,
     grace_days, late_fee_cents)
  values
    (p_account_id, p_tenancy_id, p_kind, p_amount_cents, p_currency, v_due_day,
     p_effective_date, v_inherit_end, p_source_lease_id, p_source_notice_id, p_change_reason,
     coalesce(p_grace_days, v_inherit_grace), coalesce(p_late_fee_cents, v_inherit_fee))
  returning id into v_schedule_id;

  -- 9b. Close the advance-generation double-bill hole across the era seam (see
  --     the GENERATOR COMPATIBILITY note in 20260706000001). generate_rent_charges
  --     bills IN ADVANCE, so periods on/after effective_date may already have a
  --     charge under one of the just-ended schedules' ids. Those charges belong
  --     to the OLD amount for a period the successor now owns, and ON CONFLICT
  --     cannot dedupe them (different source_schedule_id). VOID them (never
  --     delete -- the house rule; a voided charge with allocations falls its
  --     payment back to unapplied credit, per test:ledger) so the next generator
  --     run re-emits exactly one open charge per period at the new amount.
  --     Nothing is voided when no schedule was ended (v_ended is empty).
  with voided as (
    update public.charges
       set voided_at   = now(),
           void_reason = 'superseded by rent change (schedule ' || v_schedule_id || ')',
           updated_at  = now()
     where account_id         = p_account_id
       and source_schedule_id = any(v_ended)
       and period_start      >= p_effective_date
       and voided_at is null
       and deleted_at is null
    returning id
  )
  select coalesce(array_agg(id), '{}') into v_voided from voided;

  -- 9c. CASCADE to charges DERIVED from the bills 9b just voided.
  --
  --     A late fee has no source_schedule_id -- it hangs off parent_charge_id --
  --     so 9b cannot see it, and without this a backdated rent change strands a
  --     LIVE fee pointing at a voided parent. That is not merely untidy: the
  --     landlord re-creates the rent charge manually (the documented backdated
  --     recipe), the statement offers the fee again against the NEW parent, and
  --     the one-live-fee-per-parent index cannot object because the parent
  --     differs. One late month, two live fees, both counted in totals.
  --
  --     THIS CASCADE IS NOT A REVERSAL OF THE HUMAN-VOID DOCTRINE. When a
  --     LANDLORD voids a rent charge, an asserted fee deliberately stays live:
  --     withdrawing a fee they asserted is their call. Here the SYSTEM is
  --     unwinding its OWN act -- the generator's advance charge for a period the
  --     successor era now owns -- so leaving behind a fee derived from a bill
  --     that no longer exists would be the system asserting a debt nobody stands
  --     behind. Both ids come back in o_voided_charge_ids so the caller can
  --     reconcile every row it had emitted.
  --
  --     Recursive because the link is general (any charge may name a parent):
  --     fixing only the first level would leave the identical bug one level
  --     down. UNION (not UNION ALL) dedupes, so even a cyclic chain terminates.
  if array_length(v_voided, 1) is not null then
    with recursive orphaned as (
      select c.id
        from public.charges c
       where c.account_id       = p_account_id
         and c.parent_charge_id = any(v_voided)
         and c.voided_at is null
         and c.deleted_at is null
      union
      select c.id
        from public.charges c
        join orphaned o on c.parent_charge_id = o.id
       where c.account_id = p_account_id
         and c.voided_at is null
         and c.deleted_at is null
    ),
    cascaded as (
      update public.charges
         set voided_at   = now(),
             void_reason = 'parent charge superseded by rent change',
             updated_at  = now()
       where account_id = p_account_id
         and id in (select id from orphaned)
      returning id
    )
    select coalesce(array_agg(id), '{}') into v_cascaded from cascaded;
    v_voided := v_voided || v_cascaded;
  end if;

  -- 10. Lease-anchored change supersedes the OTHER active leases of this
  --     tenancy (the one we anchored to is the new contract of record).
  --     Notice-only changes touch no leases -- v_superseded stays empty.
  if p_source_lease_id is not null then
    with superseded as (
      update public.leases
         set status     = 'superseded',
             updated_at = now()
       where account_id = p_account_id
         and tenancy_id = p_tenancy_id
         and status     = 'active'
         and deleted_at is null
         and id <> p_source_lease_id
      returning id
    )
    select coalesce(array_agg(id), '{}') into v_superseded from superseded;
  end if;

  -- 11. Deliberately NO set_config('audit.actor', ...): this runs inside the
  --     caller's own transaction, so the audit trigger attributes every write
  --     to the calling user's JWT (same rationale as the end-cascade trigger in
  --     20260704000002). Stamping a synthetic actor would misattribute a human
  --     action.

  -- 12. Return exactly one summary row.
  return query select v_schedule_id, v_ended, v_superseded, v_voided;
end;
$$;

-- ============================================================================
-- (5) replace_lease: void + correction + schedule re-point, atomically
-- ============================================================================
--
-- The correction inherits the old lease's status, so an active lease is
-- corrected by an active one and a superseded lease by a superseded one. Live
-- schedules move to the correction only when it states the same rent; a
-- different rent is a rent change (change_tenancy_rent), not a correction.
-- Voiding after the re-point is what lets the old lease's anchor check pass.
create function public.replace_lease(
  p_account_id           uuid,
  p_lease_id             uuid,
  p_void_reason          text,
  p_term_start           date,
  p_term_end             date,
  p_rent_amount_cents    bigint,
  p_rent_currency        text,
  p_deposit_amount_cents bigint,
  p_deposit_currency     text,
  p_document             jsonb
)
returns table (
  o_voided_id              uuid,
  o_replacement_id         uuid,
  o_repointed_schedule_ids uuid[]
)
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_lease          record;
  v_replacement_id uuid;
  v_repointed      uuid[] := '{}';
begin
  -- a. Lock the lease row for the rest of the transaction.
  select id, tenancy_id, status, voided_at
    into v_lease
    from public.leases
   where account_id = p_account_id
     and id         = p_lease_id
     and deleted_at is null
     for update;
  if v_lease.id is null then
    raise exception 'not_found: lease';
  end if;
  if v_lease.voided_at is not null then
    raise exception 'conflict: lease is voided';
  end if;

  -- b. Serialize with every other schedule writer for this tenancy.
  perform pg_advisory_xact_lock(hashtextextended('rent_change:' || v_lease.tenancy_id::text, 0));

  -- c. A correction never changes what an anchored schedule bills.
  if exists (
    select 1
      from public.rent_schedules s
     where s.account_id      = p_account_id
       and s.source_lease_id = p_lease_id
       and s.deleted_at is null
       and (s.amount_cents <> p_rent_amount_cents or s.currency <> p_rent_currency)
  ) then
    raise exception 'conflict: lease anchors a rent schedule with a different rent';
  end if;

  -- d. The correction, in the same lifecycle position as the lease it replaces.
  insert into public.leases
    (account_id, tenancy_id, status, term_start, term_end,
     rent_amount_cents, rent_currency, deposit_amount_cents, deposit_currency, document)
  values
    (p_account_id, v_lease.tenancy_id, v_lease.status, p_term_start, p_term_end,
     p_rent_amount_cents, p_rent_currency, coalesce(p_deposit_amount_cents, 0),
     p_deposit_currency, coalesce(p_document, '{}'::jsonb))
  returning id into v_replacement_id;

  -- e. Live schedules now cite the correction.
  with repointed as (
    update public.rent_schedules
       set source_lease_id = v_replacement_id,
           updated_at      = now()
     where account_id      = p_account_id
       and source_lease_id = p_lease_id
       and deleted_at is null
    returning id
  )
  select coalesce(array_agg(id), '{}') into v_repointed from repointed;

  -- f. Void the old lease (nothing anchors it any more).
  update public.leases
     set voided_at   = now(),
         void_reason = p_void_reason,
         updated_at  = now()
   where account_id = p_account_id
     and id         = p_lease_id;

  -- g. Link the correction to the now-voided lease.
  update public.leases
     set corrects_lease_id = p_lease_id,
         updated_at        = now()
   where account_id = p_account_id
     and id         = v_replacement_id;

  return query select p_lease_id, v_replacement_id, v_repointed;
end;
$$;

-- SECURITY INVOKER: every read/write runs under the caller's RLS, so a
-- non-member gets `not_found: lease`, never a cross-account write.
revoke all on function public.replace_lease(uuid, uuid, text, date, date, bigint, text, bigint, text, jsonb) from public, anon;
grant  execute on function public.replace_lease(uuid, uuid, text, date, date, bigint, text, bigint, text, jsonb) to authenticated, service_role;

-- PostgREST must see the new columns and the new function without a manual
-- restart.
notify pgrst, 'reload schema';

-- VERIFICATION (scripts/apply-lease-lifecycle-migration.sh runs this):
--   three lifecycle columns:
--   select count(*) from information_schema.columns
--    where table_name = 'leases'
--      and column_name in ('voided_at', 'void_reason', 'corrects_lease_id'); -- 3
--   both CHECKs:
--   select pg_get_constraintdef(oid) from pg_constraint
--    where conrelid = 'public.leases'::regclass
--      and conname = 'leases_void_reason_pairs_check';
--                              -- CHECK (((voided_at IS NULL) = (void_reason IS NULL)))
--   select pg_get_constraintdef(oid) from pg_constraint
--    where conrelid = 'public.leases'::regclass
--      and conname = 'leases_corrects_self_check';
--                              -- CHECK (((corrects_lease_id IS NULL) OR (corrects_lease_id <> id)))
--   account-safe self FK and its lookup index:
--   select contype, confrelid::regclass from pg_constraint
--    where conrelid = 'public.leases'::regclass
--      and conname = 'leases_corrects_lease_fk';                  -- f, leases
--   select indexname from pg_indexes
--    where indexname = 'leases_corrects_lease_id_idx';            -- 1 row
--   lifecycle guard on INSERT and UPDATE; anchoring trigger gone:
--   select tgname, (tgtype & 4) > 0 as ins, (tgtype & 16) > 0 as upd
--     from pg_trigger
--    where tgrelid = 'public.leases'::regclass
--      and tgname in ('leases_guard', 'leases_reject_anchored_mutation');
--                                                                 -- leases_guard, true, true
--   select prosrc like '%rent_change:%' and prosrc like '%is frozen%'
--          and prosrc like '%is voided%' and prosrc like '%corrects_lease_id%'
--     from pg_proc where proname = '_leases_guard';                -- true
--   select count(*) from pg_proc
--    where proname = '_reject_anchored_lease_mutation';           -- 0
--   anchors refuse draft/voided leases:
--   select prosrc like '%non-draft%' from pg_proc
--    where proname = '_rent_schedules_guard';                     -- true
--   select count(*), bool_and(prosrc like '%source lease is voided%')
--     from pg_proc where proname = 'change_tenancy_rent';         -- 1, true
--   replace_lease is an invoker RPC for members only:
--   select prosecdef from pg_proc where proname = 'replace_lease'; -- false
--   select has_function_privilege('authenticated',
--     'public.replace_lease(uuid, uuid, text, date, date, bigint, text, bigint, text, jsonb)'::regprocedure,
--     'execute');                                                 -- true
--   select has_function_privilege('anon',
--     'public.replace_lease(uuid, uuid, text, date, date, bigint, text, bigint, text, jsonb)'::regprocedure,
--     'execute');                                                 -- false
