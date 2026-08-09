-- notice class
-- Forward-only migration. Add scope, invariants, grants, and verification notes.
--
-- SCOPE: one nullable column + one lookback index on public.notices, and the
-- anchored-notice freeze trigger extended to cover the new column. No data
-- change, no RLS change.
--
-- WHY (frontend BACKEND_ASKS #25): notice_type is the landlord's VERBATIM
-- words (1-100 chars, rendered as typed into the evidence-export PDF) and
-- nothing may ever rewrite it. But words cannot be queried: "was a written
-- warning served on this tenancy in the last 12 months?" is a statutory
-- precondition (Fla. Stat. 83.56(2)(a) recurrence route; Cal. Civ. Code
-- 1946.2(c) cure-first), and `noise warning 8/5` vs `Written warning — noise`
-- are opaque strings. notice_class is the machine-readable functional class
-- BESIDE the words — never a replacement, never displayed or exported in
-- their place.
--
-- NULLABLE BY DESIGN: the class is derived by the client from the exact
-- canonical label the landlord committed (one label -> one class); free text
-- and out-of-app writers yield null. Null is always legitimate — a guessed
-- class would be worse than none on an evidence record. No backfill: nulls
-- stay null.
--
-- MEMBERS: the functional acts, never statutory names (the same instrument is
-- "notice to vacate" in TX, "notice to quit" in MA, unnamed in FL) and never
-- per-state grounds. Grow the list only when a flow ships a label that mints
-- the new member; 'other' is reserved for a future surface that asks the
-- landlord explicitly and must not be minted by inference.
--
-- The check constraint (not an enum type) follows incidents.category
-- (20260801000002): adding a member later is a one-line constraint swap, not
-- a type migration.

alter table public.notices
  add column notice_class text
    check (notice_class in ('rent_change', 'written_warning', 'cure_or_quit', 'other'));

comment on column public.notices.notice_class is
  'Machine-readable functional class beside the verbatim notice_type. '
  'Derived from the exact canonical label at create time; null for free text '
  'and out-of-app writers. Never displayed or exported in place of the words.';

-- Serves the statutory lookback ("class X served in the trailing window") and
-- the tenancy-scoped list filter. Columns mirror incidents_recurrence_idx
-- (account_id, tenancy_id, category, occurred_at) from 20260801000002;
-- partial on live rows like the notices list indexes (20260712000001), since
-- every shipped read excludes deleted rows.
create index notices_class_lookback_idx
  on public.notices (account_id, tenancy_id, notice_class, served_at)
  where deleted_at is null;

-- The anchored-notice freeze must cover the new column. The 20260706000001
-- trigger enumerates frozen columns (fail-open to columns it predates —
-- unlike the incidents freeze, which diffs jsonb minus an allowlist and is
-- fail-closed), so without this a PATCH racing the route pre-check, or any
-- direct writer, could re-class an anchored evidence record. Same function
-- name and trigger; the body adds one line for notice_class.
create or replace function public._reject_anchored_notice_mutation()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if exists (
    select 1
      from public.rent_schedules s
     where s.account_id       = OLD.account_id
       and s.source_notice_id = OLD.id
       and s.deleted_at is null
  ) then
    if (OLD.deleted_at is null and NEW.deleted_at is not null)
       or NEW.served_at     is distinct from OLD.served_at
       or NEW.served_method is distinct from OLD.served_method
       or NEW.body          is distinct from OLD.body
       or NEW.document      is distinct from OLD.document
       or NEW.notice_type   is distinct from OLD.notice_type
       or NEW.notice_class  is distinct from OLD.notice_class
    then
      raise exception 'notice % is anchored to a rent schedule and cannot be modified', OLD.id
        using errcode = 'check_violation';
    end if;
  end if;
  return NEW;
end;
$$;

-- PostgREST must see the new column without a manual restart.
notify pgrst, 'reload schema';

-- VERIFICATION (scripts/apply-notice-class-migration.sh runs this):
--   column exists, is nullable, check constraint present, index present:
--   select is_nullable from information_schema.columns
--     where table_name = 'notices' and column_name = 'notice_class';  -- YES
--   select conname from pg_constraint
--     where conrelid = 'public.notices'::regclass
--       and conname = 'notices_notice_class_check';                   -- 1 row
--   select indexname from pg_indexes
--     where tablename = 'notices'
--       and indexname = 'notices_class_lookback_idx';                 -- 1 row
--   freeze covers the new column:
--   select prosrc like '%notice_class%' from pg_proc
--     where proname = '_reject_anchored_notice_mutation';             -- true
