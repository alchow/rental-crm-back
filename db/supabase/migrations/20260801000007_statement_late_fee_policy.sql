-- statement late fee policy
-- Forward-only migration. Add scope, invariants, grants, and verification notes.
--
-- SCOPE: two nullable policy columns on public.rent_schedules, one nullable
-- self-reference plus its uniqueness key on public.charges, and
-- change_tenancy_rent extended to carry the policy across an era fork. No data
-- change, no RLS change, no generator/cron change.
--
-- WHY: the bill-centric Statement surface needs two facts the database cannot
-- currently hold. (1) The landlord's own lease terms -- "rent is late after N
-- days, and the fee is $X" -- which today live only in a PDF, so the product
-- cannot tell a landlord that today is the day. (2) WHICH rent charge a late
-- fee belongs to, so a fee can be shown under its bill, counted once, and
-- undone.
--
-- One thing here DOES void charges: a rent change already voids the advance rent
-- charges the successor era takes over, and step (4) extends that sweep to the
-- charges DERIVED from them, so a backdated change cannot strand a live late fee
-- pointing at a bill that no longer exists. That is the system unwinding its own
-- act, never the system second-guessing a landlord's -- see step (4).
--
-- NOTHING HERE MINTS A CHARGE. The grace window makes the UI able to PROPOSE
-- ("add the $85 late fee from the lease?"); a real late_fee charge appears only
-- when a human taps confirm, through the ordinary POST /charges. There is no
-- generator change, no cron change, and no trigger that creates money. This is
-- deliberate: asserting a fee is a legal act with jurisdiction-specific
-- preconditions, and a server that mints it silently would be asserting
-- something the landlord never said.
--
-- NO TIMEZONE COLUMN, ON PURPOSE. A server that decided "the grace window has
-- expired" would need to know the property's local midnight. Because the fee is
-- only ever asserted by a human tap, no server-side clock decision exists to
-- get wrong: the client renders the window from due_date + grace_days in the
-- viewer's own local time, and the landlord is the one who judges that the day
-- has arrived. Add a timezone column when (and only when) something automatic
-- starts depending on that boundary.
--
-- NULL MEANS "NOT SET", NEVER A DEFAULT. Both policy columns are nullable with
-- no DEFAULT and no backfill. A guessed grace period or a guessed fee would be
-- read back as the lease's terms and could end up in a demand letter, so an
-- unset policy stays visibly unset and the UI proposes nothing.

-- ============================================================================
-- (1) rent_schedules: the landlord-configured late-fee policy
-- ============================================================================
--
-- The policy lives on the SCHEDULE, not the tenancy or the account, because it
-- is a term of the rent era: a renewal that raises the rent commonly raises the
-- fee with it, and the era that billed a period must still describe how that
-- period's lateness was judged. Step (4) carries the policy forward across a
-- rent change so this granularity costs nothing in the common case.
--
-- Bounds: grace_days 0-30 (0 is meaningful -- "late the day after it is due");
-- late_fee_cents strictly > 0, mirroring charges_amount_cents_positive, since a
-- zero fee is the absence of a fee and is spelled null.
--
-- Every statement in this file is written to survive re-application (the
-- precedent is 20260723000007 for constraints, 20260629000002 for indexes). A
-- production apply is a manual step that can be interrupted part-way; a bare
-- ADD COLUMN would then abort the retry on the half it already did, leaving an
-- operator to hand-edit around a migration. Constraints get an explicit name
-- plus drop-if-exists rather than the inline form, because ADD CONSTRAINT has
-- no IF NOT EXISTS -- the names are the ones Postgres would have generated, so
-- the schema snapshot is byte-identical either way.
alter table public.rent_schedules
  add column if not exists grace_days     int,
  add column if not exists late_fee_cents bigint;

alter table public.rent_schedules
  drop constraint if exists rent_schedules_grace_days_check,
  drop constraint if exists rent_schedules_late_fee_cents_check;

alter table public.rent_schedules
  add constraint rent_schedules_grace_days_check
    check (grace_days >= 0 and grace_days <= 30),
  add constraint rent_schedules_late_fee_cents_check
    check (late_fee_cents > 0);

comment on column public.rent_schedules.grace_days is
  'Days after due_date before rent counts late under the lease. Null = not set '
  '(no default is invented). Read by the client to render the status hero and '
  'to offer the late-fee proposal; nothing server-side acts on it.';

comment on column public.rent_schedules.late_fee_cents is
  'Late fee from the lease, in minor units of the schedule currency. Null = not '
  'set. Only ever proposed to a human, never auto-charged.';

-- ============================================================================
-- (2) charges.parent_charge_id: which bill a fee belongs to
-- ============================================================================
--
-- Account-safe composite FK (account_id, parent_charge_id) -> (account_id, id),
-- the same shape as charges_account_id_source_schedule_id_fkey: it makes a
-- cross-ACCOUNT parent impossible at the database, not merely unlikely at the
-- route. Cross-TENANCY parents are still the API's job -- the pair is inside
-- one account, so no key can express it.
--
-- ON DELETE RESTRICT (payment_allocations' rule, not source_schedule_id's SET
-- NULL): charges are corrected by VOIDING, never by deletion, so a hard delete
-- that silently orphaned a fee from the bill it justifies would be destroying
-- evidence rather than tidying a pointer.
alter table public.charges
  add column if not exists parent_charge_id uuid;

alter table public.charges
  drop constraint if exists charges_parent_charge_fk,
  drop constraint if exists charges_parent_not_self;

alter table public.charges
  add constraint charges_parent_charge_fk
    foreign key (account_id, parent_charge_id)
    references public.charges (account_id, id) on delete restrict,
  add constraint charges_parent_not_self
    check (parent_charge_id is null or parent_charge_id <> id);

comment on column public.charges.parent_charge_id is
  'The charge this one derives from -- today, the rent charge a late_fee was '
  'asserted against. Null for a standalone charge. Same account (FK) and, by '
  'route validation, the same tenancy.';

-- The propose-confirm idempotency key. A landlord who taps "add the late fee"
-- twice -- double tap, retry, a second device -- must end up with ONE fee, and
-- the second attempt must fail loudly (409) rather than quietly double-bill.
--
-- The predicate is scoped to LIVE late fees so the constraint expresses the
-- product rule exactly: voiding a mistaken fee frees the slot, and the landlord
-- can re-assert it (a corrected amount, say) without deleting evidence. Every
-- other charge type, and every charge with no parent, is outside the index --
-- null parent_charge_id values are distinct to a unique index anyway, so an
-- ordinary charge can never collide here.
create unique index if not exists charges_one_live_late_fee_per_parent
  on public.charges (parent_charge_id)
  where type = 'late_fee' and voided_at is null and deleted_at is null;

-- ============================================================================
-- (3) change_tenancy_rent: the policy forks with the era
-- ============================================================================
--
-- ADR-0012 makes a rent change a FORWARD FORK: the open era is ended at
-- effective_date-1 and a successor era is appended. Everything the predecessor
-- described about how rent is billed already travels across that seam -- due_day
-- and a bounded end_date are inherited (steps 7-9) -- and the late-fee policy is
-- the same class of fact. Dropping it would silently switch a tenancy from "late
-- after 5 days, $85" to "no policy at all" the moment the landlord recorded a
-- rent increase, and the Statement would stop offering the fee with nothing on
-- screen explaining why.
--
-- Explicit override follows the p_due_day idiom exactly: pass a value to set it,
-- omit it to inherit. Like p_due_day, this cannot express "clear it" -- null is
-- the omitted-parameter signal. CLEARING a policy is
-- PATCH /v1/accounts/{a}/rent-schedules/{id} { "late_fee_cents": null }, which
-- is the surface that owns policy edits.
--
-- DROP-then-CREATE (not a bare CREATE OR REPLACE): two IN parameters are added,
-- which is a NEW signature. Left alone, the 10-argument definition would survive
-- alongside the 12-argument one and a named-argument call could resolve to
-- either, so the old overload is dropped and the grants are re-issued against
-- the new signature (an ACL does not survive DROP).
--
-- DEPLOY WINDOW: the added parameters have defaults, so API code that predates
-- this migration -- which names only the original ten -- keeps resolving and
-- behaving identically, and simply inherits the policy it never knew about.
drop function if exists public.change_tenancy_rent(uuid, uuid, bigint, text, date, int, uuid, uuid, text, text);
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
    select id, status
      into v_lease
      from public.leases
     where account_id = p_account_id
       and id         = p_source_lease_id
       and tenancy_id = p_tenancy_id
       and deleted_at is null;
    if v_lease.id is null then
      raise exception 'not_found: source lease';
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

-- SECURITY INVOKER (the default) is retained deliberately: every read/write
-- above runs under the CALLER's RLS, so a non-member's tenancy lookup returns
-- nothing and they get `not_found: tenancy`, never a cross-account write.
-- The ACL does not survive the DROP above, so re-issue it: no public/anon
-- execute, authenticated + service_role only.
revoke all on function public.change_tenancy_rent(uuid, uuid, bigint, text, date, int, uuid, uuid, text, text, int, bigint) from public, anon;
grant  execute on function public.change_tenancy_rent(uuid, uuid, bigint, text, date, int, uuid, uuid, text, text, int, bigint) to authenticated, service_role;

-- PostgREST must see the new columns and the new function signature without a
-- manual restart.
notify pgrst, 'reload schema';

-- VERIFICATION:
--   policy columns exist, nullable, no default:
--   select column_name, is_nullable, column_default
--     from information_schema.columns
--    where table_name = 'rent_schedules'
--      and column_name in ('grace_days', 'late_fee_cents');   -- 2 rows, YES, null
--   one live late fee per parent:
--   select indexdef from pg_indexes
--    where indexname = 'charges_one_live_late_fee_per_parent'; -- partial UNIQUE
--   account-safe parent FK:
--   select conname from pg_constraint
--    where conrelid = 'public.charges'::regclass
--      and conname in ('charges_parent_charge_fk', 'charges_parent_not_self'); -- 2 rows
--   exactly one change_tenancy_rent, taking 12 arguments:
--   select pronargs from pg_proc where proname = 'change_tenancy_rent'; -- one row, 12
--   carry-forward is in the body:
--   select prosrc like '%v_inherit_grace%' from pg_proc
--    where proname = 'change_tenancy_rent';                    -- true
