-- Report-only (WP-26): properties in the same account that share a picked place or a
-- normalized address. Nothing is merged; list the groups for the owner.
-- psql -f db/scripts/report-duplicate-properties.sql
\set ON_ERROR_STOP on
select account_id, key, count(*) as properties, jsonb_agg(jsonb_build_object('id', id, 'name', name,
  'doors', (select count(*) from public.areas a where a.account_id = p.account_id and a.property_id = p.id
    and a.kind = 'unit' and a.deleted_at is null)) order by created_at) as members
from (select p.*, coalesce(nullif(btrim(p.address->>'provider_id'), ''),
    public._normalized_address(coalesce(nullif(p.address->>'line1', ''), p.name))) as key
  from public.properties p where p.deleted_at is null) p
where key is not null
group by account_id, key having count(*) > 1
order by account_id, count(*) desc, key;
