-- ----------------------------------------------------------------------------
-- Interactions -> evidentiary journal: append-only corrections, notes,
-- retractions.
--
-- The append-only guarantee stays absolute: a "correction", a "retraction"
-- and a "note" are all just NEW immutable interactions. The original row is
-- never mutated -- supersession is derived from the forward corrects_id link
-- only (no superseded_by column on the original, no UPDATE path anywhere).
--
--   kind            'communication' (default; today's rows) | 'note'
--                   A note is a dated observation with no counterparty
--                   ("inspected roof, cracked tile").
--   corrects_id     set on a CORRECTING entry; points at the entry it
--                   supersedes. Lives only on the new row.
--   correction_kind 'amend' (body carries the corrected content) |
--                   'retract' (body carries the reason). Required iff
--                   corrects_id is set.
--
-- Two invariants are deliberately DB-enforced rather than app-checked,
-- because evidence-grade guarantees must hold even under racing requests
-- or a direct write:
--
--   1. Linear chains: a partial UNIQUE index on corrects_id means at most
--      one corrector per row. Two concurrent corrections of the same head
--      cannot branch the chain -- the loser gets a unique violation, which
--      the API maps to 409 invalid_correction_target.
--   2. Same-account: corrects_id is a composite (account_id, corrects_id)
--      FK -- the same pattern the table already uses for tenancy_id etc.
--      A cross-account correction is impossible at the storage layer.
--
-- kind='note' follows the import-channel precedent (20260611000001): rather
-- than relaxing NOT NULL on channel/direction/party_type (a breaking,
-- nullable contract change), a note stores sentinel values -- channel='note',
-- direction='none', party_type='none' -- valid ONLY in that combination.
-- ----------------------------------------------------------------------------

alter table public.interactions
  add column kind text not null default 'communication'
    constraint interactions_kind_check check (kind in ('communication', 'note')),
  add column corrects_id uuid,
  add column correction_kind text
    constraint interactions_correction_kind_check
    check (correction_kind in ('amend', 'retract'));

-- correction_kind is required iff corrects_id is set.
alter table public.interactions add constraint interactions_correction_pairing
  check ((corrects_id is null) = (correction_kind is null));

-- Same-account, DB-enforced (matches the composite-FK pattern used by
-- tenancy_id / area_id / ... on this table; backed by unique(account_id,id)).
alter table public.interactions add constraint interactions_corrects_id_fkey
  foreign key (account_id, corrects_id)
  references public.interactions (account_id, id);

-- Linear chains even under race: at most one corrector per row. Doubles as
-- the index for the derived superseded_by lookup.
create unique index interactions_corrects_id_uniq
  on public.interactions (corrects_id) where corrects_id is not null;

-- ---------------------------------------------------------------------------
-- kind='note' sentinels.
-- ---------------------------------------------------------------------------

alter table public.interactions drop constraint interactions_channel_check;
alter table public.interactions add constraint interactions_channel_check
  check (channel in (
    'in_person', 'phone', 'voicemail',
    'sms', 'email', 'letter', 'in_app',
    'import', 'note'
  ));

alter table public.interactions drop constraint interactions_party_type_check;
alter table public.interactions add constraint interactions_party_type_check
  check (party_type in ('tenant', 'vendor', 'inspector', 'other', 'none'));

alter table public.interactions drop constraint interactions_direction_none_import_only;
alter table public.interactions add constraint interactions_direction_none_check
  check (direction <> 'none' or channel in ('import', 'note'));

-- A note IS the 'note' channel and vice versa; and a note row is fully
-- note-shaped: no direction, no counterparty of any kind.
alter table public.interactions add constraint interactions_note_shape
  check ((kind = 'note') = (channel = 'note'));
alter table public.interactions add constraint interactions_note_fields
  check (
    channel <> 'note'
    or (direction = 'none' and party_type = 'none'
        and party_id is null and party_label is null)
  );

-- ---------------------------------------------------------------------------
-- Derived chain state, in one place.
--
-- superseded_by_id / is_head are DERIVED from the forward corrects_id link;
-- they are not stored on the original (storing them would mean mutating it).
-- security_invoker: the caller's own RLS on public.interactions applies, so
-- the view adds no read surface and no mutation path.
-- ---------------------------------------------------------------------------

create view public.interactions_with_chain
  with (security_invoker = true) as
  select i.*,
         c.id as superseded_by_id,
         (c.id is null) as is_head
  from public.interactions i
  left join public.interactions c on c.corrects_id = i.id;

grant select on public.interactions_with_chain to authenticated, service_role;
