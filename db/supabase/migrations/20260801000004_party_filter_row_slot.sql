-- ----------------------------------------------------------------------------
-- list_interactions_for_party: match the ROW-SLOT party as well as the cast.
--
-- WHY. "Everything involving <person>" resolved people ONLY through
-- interaction_participants. Two shapes never write a cast, so both were
-- silently invisible to GET /interactions?party_id=<id>:
--   - kind='note' takes the plain-insert note branch by design (there is no
--     wire cast to record for a dated observation), yet a note MAY name a
--     counterparty since 20260717000001;
--   - a correction row inherits the corrected row's party slot but carries no
--     cast of its own (the cast belongs to the chain's root entry), so a
--     classify that ADDS the who produced a head no party query could find.
-- One OR arm on the row's own party fields fixes both, retroactively for every
-- existing row — no backfill, no new write path, no new column.
--
-- RESIDUAL (deliberate). A person named ONLY in a superseded row's cast (a cc,
-- a witness, a group-message member who is not the headline slot) still does
-- not match under latest_only=true when the chain head is a castless
-- correction: the correction inherits the ROOT's slot, which names someone
-- else. Resolving that means walking the chain's casts — a read-model change,
-- not another predicate arm. Until then the full set (latest_only omitted) is
-- the complete answer for "everything involving <person>", and the route
-- description states this caveat.
--
-- NARROWING SEMANTICS. p_party_type narrows whichever leg matches: the cast leg
-- by the cast vocabulary (which includes wire-only roles like landlord_user),
-- the slot leg by the journal vocabulary. The four roles a note can carry
-- (tenant/vendor/inspector/other) exist in both, so a caller's party_type means
-- the same thing on either leg. After 20260801000003 a slot holding a party_id
-- can only carry a concrete role, so the slot leg never matches a sentinel
-- ('none'/'unspecified') value.
--
-- NO DUPLICATES. The OR is a filter inside the single keyset scan, not a join:
-- a row matching BOTH legs (e.g. a hand-logged communication whose derived
-- one-person cast mirrors its slot) is still exactly one row.
--
-- PERFORMANCE. The slot leg is a same-row comparison on the existing
-- (account_id, occurred_at) keyset walk — strictly cheaper than the EXISTS it
-- sits beside, and evaluated on rows that walk is already visiting. No new
-- index; interactions stays the highest-write table.
--
-- RLS. security invoker is unchanged. The slot leg reads the same invoker view
-- as the rest of the predicate, so a cross-account party_id still returns zero
-- rows exactly as a direct table read would.
--
-- create or replace preserves the 12-argument function's existing grants; they
-- are restated below anyway so this migration is self-contained.
-- ----------------------------------------------------------------------------

create or replace function public.list_interactions_for_party(
  p_account_id             uuid,
  p_party_type             text,
  p_party_id               uuid,
  p_tenancy_id             uuid,
  p_maintenance_request_id uuid,
  p_area_id                uuid,
  p_property_id            uuid,
  p_direction              text,
  p_latest_only            boolean,
  p_before_occurred_at     timestamptz,
  p_before_id              uuid,
  p_limit                  int
)
returns setof public.interactions_with_chain
language sql
stable
security invoker
set search_path = public
as $$
  select v.*
  from public.interactions_with_chain v
  where v.account_id = p_account_id
    and v.deleted_at is null
    and (
      exists (
        select 1
          from public.interaction_participants ip
         where ip.account_id = v.account_id
           and ip.interaction_id = v.id
           and ip.party_id = p_party_id
           and (p_party_type is null or ip.party_type = p_party_type)
      )
      or (
        v.party_id = p_party_id
        and (p_party_type is null or v.party_type = p_party_type)
      )
    )
    and (p_tenancy_id is null or v.tenancy_id = p_tenancy_id)
    and (p_maintenance_request_id is null or v.maintenance_request_id = p_maintenance_request_id)
    and (p_area_id is null or v.area_id = p_area_id)
    and (p_property_id is null or v.property_id = p_property_id)
    and (p_direction is null or v.direction = p_direction)
    and (not coalesce(p_latest_only, false) or v.is_head)
    and (
      p_before_occurred_at is null
      or v.occurred_at > p_before_occurred_at
      or (v.occurred_at = p_before_occurred_at and v.id > p_before_id)
    )
  order by v.occurred_at asc, v.id asc
  limit p_limit;
$$;

revoke execute on function public.list_interactions_for_party(
  uuid, text, uuid, uuid, uuid, uuid, uuid, text, boolean, timestamptz, uuid, int
) from public, anon;
grant execute on function public.list_interactions_for_party(
  uuid, text, uuid, uuid, uuid, uuid, uuid, text, boolean, timestamptz, uuid, int
) to authenticated, service_role;

-- Drop the legacy 11-argument overload from 20260716000001. 20260718000003 kept
-- it only for the migrate-before-deploy window ("the live old API must remain
-- callable until the property-aware release is running"); that release has been
-- live for weeks and the handler has passed 12 arguments since. Removing it
-- also removes the risk that a stale caller silently gets cast-only semantics
-- after this change.
drop function public.list_interactions_for_party(
  uuid, text, uuid, uuid, uuid, uuid, text, boolean, timestamptz, uuid, int
);

notify pgrst, 'reload schema';
