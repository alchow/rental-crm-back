-- ----------------------------------------------------------------------------
-- list_interactions_for_party: keyset-paginated "everything involving <person>"
-- (Field Log ask #5 — the party_id interactions filter).
--
-- WHY A FUNCTION AND NOT A POSTGREST EMBED. The intended mechanism was a
-- PostgREST embedded semi-join on the read view:
--   interactions_with_chain?select=*,interaction_participants!inner(party_id)
--     &interaction_participants.party_id=eq.<id>
-- which would prune parents by construction and keep keyset pagination correct
-- with no id-set materialization. It does NOT work here: interactions_with_chain
-- is a self-left-join of interactions that exposes BOTH `id` and
-- `superseded_by_id` (aliased from the joined `c.id`), so PostgREST finds TWO
-- candidate relationships for interaction_participants(account_id, interaction_id)
--   -> interactions_with_chain(account_id, id)              [wanted]
--   -> interactions_with_chain(account_id, superseded_by_id) [spurious]
-- and answers PGRST201 (ambiguous). Both candidates carry the SAME constraint
-- name (interaction_participants_account_id_interaction_id_fkey), so the
-- `!<constraint>`, `!<column>` and `!inner` hint forms cannot disambiguate —
-- the ambiguity is on which VIEW column is the referenced key, which the hint
-- syntax cannot express. Proven against the local stack before shipping.
--
-- So this filtered read path reimplements the (occurred_at, id) ascending
-- keyset in SQL. It resolves the party through the CAST
-- (interaction_participants — the payoff index interaction_participants_party_idx
-- (account_id, party_type, party_id)), never the legacy single-slot party_id, so
-- it matches the backfill's end state: everything involving a person is ONE
-- indexed cast query.
--
-- SECURITY INVOKER: the body runs as the caller, so the security_invoker view
-- and interaction_participants member-read RLS both apply — a cross-account
-- party_id returns zero rows exactly as a direct table read would. The keyset,
-- deleted_at, and is_head filters mirror the handler's non-party path so a
-- single-page walk stays byte-compatible. All row filters are nullable = "not
-- applied", so the handler can combine party_id with the existing
-- tenancy_id / maintenance_request_id / area_id / direction / latest_only
-- filters without dropping any of them.
-- Data-model note: NO index is added on interactions.area_id (highest-write
-- table); the area_id filter rides the existing account scan. If it ever needs
-- one, the ready-made partial index lives as a comment beside the handler.
-- ----------------------------------------------------------------------------

create or replace function public.list_interactions_for_party(
  p_account_id             uuid,
  p_party_type             text,
  p_party_id               uuid,
  p_tenancy_id             uuid,
  p_maintenance_request_id uuid,
  p_area_id                uuid,
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
    -- Resolve the person through the cast (semi-join), pruning parents that
    -- carry no matching participant. party_type, when supplied, narrows the
    -- SAME participant (a tenant leg vs. a vendor leg), never the row slot.
    and exists (
      select 1
        from public.interaction_participants ip
       where ip.account_id = v.account_id
         and ip.interaction_id = v.id
         and ip.party_id = p_party_id
         and (p_party_type is null or ip.party_type = p_party_type)
    )
    and (p_tenancy_id is null or v.tenancy_id = p_tenancy_id)
    and (p_maintenance_request_id is null or v.maintenance_request_id = p_maintenance_request_id)
    and (p_area_id is null or v.area_id = p_area_id)
    and (p_direction is null or v.direction = p_direction)
    and (not coalesce(p_latest_only, false) or v.is_head)
    -- Ascending (occurred_at, id) keyset: strictly after the last-seen row.
    and (
      p_before_occurred_at is null
      or v.occurred_at > p_before_occurred_at
      or (v.occurred_at = p_before_occurred_at and v.id > p_before_id)
    )
  order by v.occurred_at asc, v.id asc
  limit p_limit;
$$;

revoke execute on function public.list_interactions_for_party(
  uuid, text, uuid, uuid, uuid, uuid, text, boolean, timestamptz, uuid, int
) from public, anon;
grant execute on function public.list_interactions_for_party(
  uuid, text, uuid, uuid, uuid, uuid, text, boolean, timestamptz, uuid, int
) to authenticated, service_role;
