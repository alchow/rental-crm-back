-- notice label rename
-- Forward-only migration. Add scope, invariants, grants, and verification notes.
--
-- SCOPE: rename public.notices.notice_type -> notice_label, plus the renames
-- that must follow it (check constraint name, freeze-trigger body, column
-- comments). No data change, no RLS change, no semantic change.
--
-- WHY: the name lied. The field is the landlord's VERBATIM WORDS for the
-- instrument — display title, search text, the PDF line — and nothing anywhere
-- branches on it; the machine-readable type is notice_class (20260801000005).
-- Calling the words "type" repeatedly misled maintainers into treating them as
-- identity (enumeration debates, "the KIND is written once" write-blocks).
-- notice_class + notice_label mirrors the established party_type + party_label
-- split. Renamed now because the table is effectively empty — the last moment
-- this is a rename instead of a data migration.
--
-- DEPLOY WINDOW (breaking, deliberately accepted at current usage): old API
-- code inserts notice_type -> 500 after this applies; new API code inserts
-- notice_label -> 500 until this applies. Merge-then-apply-promptly, the
-- incidents precedent. The old deployed frontend 400s on notice creates
-- against the new API until its own rename deploys; reads render blank
-- titles. Sequence: backend merge -> apply this -> frontend merge.

alter table public.notices rename column notice_type to notice_label;

-- The length check followed the column automatically but kept its old name.
alter table public.notices
  rename constraint notices_notice_type_check to notices_notice_label_check;

-- Trigger function bodies are text and do NOT follow a column rename: without
-- this replacement the anchored-notice freeze raises "record NEW has no field
-- notice_type" on every update of an anchored notice. Same function, same
-- trigger; only the column reference moves.
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
       or NEW.notice_label  is distinct from OLD.notice_label
       or NEW.notice_class  is distinct from OLD.notice_class
    then
      raise exception 'notice % is anchored to a rent schedule and cannot be modified', OLD.id
        using errcode = 'check_violation';
    end if;
  end if;
  return NEW;
end;
$$;

comment on column public.notices.notice_label is
  'The landlord''s verbatim words for the instrument — display title, search '
  'text, and the evidence-export PDF line. Never rewritten, never branched '
  'on; the machine-readable type is notice_class.';

comment on column public.notices.notice_class is
  'Machine-readable functional class beside the verbatim notice_label. '
  'Derived from the exact canonical label at create time; null for free text '
  'and out-of-app writers. Never displayed or exported in place of the words.';

-- PostgREST must see the rename without a manual restart.
notify pgrst, 'reload schema';

-- VERIFICATION (scripts/apply-notice-label-rename-migration.sh runs this):
--   select count(*) from information_schema.columns
--     where table_name = 'notices' and column_name = 'notice_label';  -- 1
--   select count(*) from information_schema.columns
--     where table_name = 'notices' and column_name = 'notice_type';   -- 0
--   select conname from pg_constraint
--     where conrelid = 'public.notices'::regclass
--       and conname = 'notices_notice_label_check';                   -- 1 row
--   select prosrc like '%notice_label%' from pg_proc
--     where proname = '_reject_anchored_notice_mutation';             -- true
