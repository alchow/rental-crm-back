-- Property is a derived interaction scope; area_id remains the canonical
-- stored foreign key. This prevents two independently mutable place columns
-- from drifting while still giving clients a property-level read/filter.

create or replace view public.interactions_with_chain
  with (security_invoker = true) as
  select i.*,
         c.id as superseded_by_id,
         (c.id is null) as is_head,
         o.id          as outbox_id,
         o.status      as delivery_status,
         o.delivered_at,
         a.property_id
  from public.interactions i
  left join public.interactions c on c.corrects_id = i.id
  left join public.comm_outbox o
         on o.interaction_id = i.id
        and o.relay_of_interaction_id is null
  left join public.areas a
         on a.account_id = i.account_id
        and a.id = i.area_id;

grant select on public.interactions_with_chain to authenticated, service_role;

-- Property filtering joins property -> its areas -> journal rows. Without an
-- area-keyed journal index, a small property's page can scan a large account's
-- entire chronological feed before finding 50 matches. The live-row partial
-- index keeps that path proportional to the selected property's activity.
create index if not exists interactions_account_area_occurred_idx
  on public.interactions (account_id, area_id, occurred_at, id)
  where deleted_at is null and area_id is not null;

-- Add property_id to the cast-backed person filter without materializing a
-- property-sized area-id list in the API. The SQL semi-join and keyset remain
-- one bounded query even for large properties. Keep the prior 11-argument
-- overload from 20260716000001: migrations deploy before code, so the live old
-- API must remain callable until the property-aware release is running.

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

notify pgrst, 'reload schema';
