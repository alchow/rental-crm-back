-- Report-only (WP-12): how many properties carry each address part. The only certain
-- source of a city is a picked place (address.provider_id with its city); free-text
-- addresses are not parsed, so this script changes nothing.
-- psql -f db/scripts/report-property-addresses.sql
\set ON_ERROR_STOP on
select count(*) as properties,
  count(*) filter (where nullif(btrim(address->>'line1'), '') is not null) as with_line1,
  count(*) filter (where nullif(btrim(address->>'city'), '') is not null) as with_city,
  count(*) filter (where nullif(btrim(address->>'state'), '') is not null) as with_region,
  count(*) filter (where nullif(btrim(address->>'zip'), '') is not null) as with_postcode,
  count(*) filter (where nullif(btrim(address->>'provider_id'), '') is not null) as with_provider_id,
  count(*) filter (where nullif(btrim(address->>'provider_id'), '') is not null
    and nullif(btrim(address->>'city'), '') is null) as provider_id_without_city
from public.properties where deleted_at is null;
