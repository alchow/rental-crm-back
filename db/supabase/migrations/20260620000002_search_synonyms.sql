-- ----------------------------------------------------------------------------
-- Entity search: domain synonym normalization (so "apt 1" matches "unit 1").
--
-- v1 (20260620000001) was purely lexical: a query only matched candidates that
-- shared the literal characters. A landlord searching "apt 1" got nothing for a
-- unit named "Unit 1" because the substring "apt 1" isn't in "unit 1".
--
-- This adds a small, curated, DETERMINISTIC synonym layer for the
-- property-management vocabulary. Both the indexed text and the query are run
-- through public.normalize_search_text(), which collapses synonyms to a single
-- canonical token before the trigram/ILIKE match. So "apt 1", "apartment 1",
-- "ste 1", "suite 1" and "unit 1" all normalize to "unit 1" and inter-match --
-- while the NUMBER is preserved, so "unit 1" still never matches "unit 2".
--
-- Deliberately NOT semantic/embedding-based (see the search assessment): for a
-- short identifier where the digit is the discriminator, an embedding model
-- conflates "Unit 1" and "Unit 2" -- precision loss exactly where it matters.
-- A curated map is cheaper, explainable, and number-safe.
--
-- SCOPE / SAFETY: only the unambiguous "rentable unit + building" vocabulary is
-- normalized. The address-direction abbreviations (st->street, dr->drive,
-- ave->avenue) are intentionally EXCLUDED: they collide with person names
-- ("St. John", "Dr" as a title) and the same normalize function is applied
-- uniformly across all entity kinds, including tenant names.
--
-- The contract is unchanged: same search_entities() signature, same route, same
-- OpenAPI/SDK. This is a purely internal precision improvement.
-- ----------------------------------------------------------------------------

-- ============================================================================
-- 1. normalize_search_text(): IMMUTABLE lowercase + synonym canonicalization
-- ============================================================================
--
-- IMMUTABLE (lower/regexp_replace are immutable) so it is legal in the index
-- expressions below. The index and search_entities() both call it, keeping the
-- expressions byte-identical so the planner still uses the GIN index.
--
-- `\y` is a Postgres regex word boundary, so only whole tokens are rewritten
-- ("apt" the word, never the "apt" inside "chapter"). Order within the
-- alternation is irrelevant under \y. Whitespace is collapsed last so
-- "apt   1" and "unit 1" share one space.
create or replace function public.normalize_search_text(p_text text)
returns text
language sql
immutable
as $$
  select btrim(
    regexp_replace(
      regexp_replace(
        regexp_replace(lower(coalesce(p_text, '')),
          '\y(apartment|apt|suite|ste)\y', 'unit', 'g'),
          '\y(bldg)\y', 'building', 'g'),
          '\s+', ' ', 'g')
  );
$$;

-- ============================================================================
-- 2. Rebuild the trigram indexes over the NORMALIZED text
-- ============================================================================
--
-- The v1 indexes are on the raw expression; the new WHERE/word_similarity wrap
-- it in normalize_search_text(), so the planner needs indexes on that exact
-- expression. Drop the old, create the normalized. (Small pre-launch tables --
-- a plain, non-concurrent rebuild is fine; comment kept for the day it isn't.)

drop index if exists public.tenants_search_trgm_idx;
create index if not exists tenants_search_trgm_idx
  on public.tenants
  using gin (public.normalize_search_text(public.tenant_search_text(full_name, emails)) gin_trgm_ops)
  where deleted_at is null;

drop index if exists public.vendors_search_trgm_idx;
create index if not exists vendors_search_trgm_idx
  on public.vendors
  using gin (public.normalize_search_text(name || ' ' || coalesce(contact->>'email','') || ' ' || coalesce(contact->>'phone','')) gin_trgm_ops)
  where deleted_at is null;

drop index if exists public.properties_search_trgm_idx;
create index if not exists properties_search_trgm_idx
  on public.properties
  using gin (public.normalize_search_text(name || ' ' || coalesce(address->>'line1','')) gin_trgm_ops)
  where deleted_at is null;

drop index if exists public.areas_search_trgm_idx;
create index if not exists areas_search_trgm_idx
  on public.areas
  using gin (public.normalize_search_text(name) gin_trgm_ops)
  where deleted_at is null;

drop index if exists public.maintenance_requests_search_trgm_idx;
create index if not exists maintenance_requests_search_trgm_idx
  on public.maintenance_requests
  using gin (public.normalize_search_text(title) gin_trgm_ops)
  where deleted_at is null;

-- ============================================================================
-- 3. search_entities(): normalize the query + every candidate before matching
-- ============================================================================
--
-- Signature, returns, ranking and isolation are UNCHANGED from v1 -- the only
-- change is that the ILIKE substring gate and word_similarity ranking run over
-- normalize_search_text(<expr>) on both sides. title/subtitle/context still
-- return the ORIGINAL (un-normalized) values for display.

create or replace function public.search_entities(
  p_account_id uuid,
  p_q          text,
  p_types      text[],
  p_exclude    text[],
  p_limit      int
) returns table (
  entity_type text,
  entity_id   uuid,
  title       text,
  subtitle    text,
  score       real,
  context     jsonb
)
language plpgsql
stable
security invoker
set search_path = public
as $$
declare
  v_q       text;
  v_pattern text;
begin
  if char_length(btrim(p_q)) < 2 then
    return;
  end if;

  -- Normalize the query through the SAME synonym map as the indexed text, then
  -- escape LIKE metacharacters once (backslash first) for use with `escape '\'`.
  v_q := public.normalize_search_text(p_q);
  if char_length(v_q) < 1 then
    return;
  end if;
  v_pattern := '%' || replace(replace(replace(v_q, '\', '\\'), '%', '\%'), '_', '\_') || '%';

  return query
  select
    s.entity_type, s.entity_id, s.title, s.subtitle, s.score,
    -- Structured disambiguation context (tenants only; see v1 migration). One
    -- lookup per RETURNED row, not per match. RLS still applies.
    case when s.entity_type = 'tenant' then (
      select jsonb_build_object(
        'unit_name',      ar.name,
        'property_name',  pr.name,
        'area_id',        ar.id,
        'tenancy_id',     tn.id,
        'tenancy_status', tn.status
      )
      from public.tenancy_tenants tt
      join public.tenancies  tn on tn.id = tt.tenancy_id  and tn.account_id = p_account_id and tn.deleted_at is null
      join public.areas      ar on ar.id = tn.area_id     and ar.account_id = p_account_id and ar.deleted_at is null
      join public.properties pr on pr.id = ar.property_id and pr.account_id = p_account_id and pr.deleted_at is null
      where tt.tenant_id  = s.entity_id
        and tt.account_id = p_account_id
        and tt.deleted_at is null
      order by (tn.status in ('active','holdover')) desc, tn.start_date desc, tn.id desc
      limit 1
    ) end as context
  from (
    -- ---- tenants ---------------------------------------------------------
    select
      'tenant'::text as entity_type,
      t.id           as entity_id,
      t.full_name    as title,
      nullif(array_to_string(t.emails, ', '), '') as subtitle,
      word_similarity(v_q, public.normalize_search_text(public.tenant_search_text(t.full_name, t.emails)))::real as score
    from public.tenants t
    where t.deleted_at is null
      and t.account_id = p_account_id
      and (p_types   is null or 'tenant' = any(p_types))
      and (p_exclude is null or 'tenant' <> all(p_exclude))
      and public.normalize_search_text(public.tenant_search_text(t.full_name, t.emails)) ilike v_pattern escape '\'

    union all

    -- ---- vendors ---------------------------------------------------------
    select
      'vendor'::text as entity_type,
      v.id           as entity_id,
      v.name         as title,
      nullif(coalesce(v.contact->>'email', v.contact->>'phone'), '') as subtitle,
      word_similarity(v_q, public.normalize_search_text(v.name || ' ' || coalesce(v.contact->>'email','') || ' ' || coalesce(v.contact->>'phone','')))::real as score
    from public.vendors v
    where v.deleted_at is null
      and v.account_id = p_account_id
      and (p_types   is null or 'vendor' = any(p_types))
      and (p_exclude is null or 'vendor' <> all(p_exclude))
      and public.normalize_search_text(v.name || ' ' || coalesce(v.contact->>'email','') || ' ' || coalesce(v.contact->>'phone','')) ilike v_pattern escape '\'

    union all

    -- ---- properties ------------------------------------------------------
    select
      'property'::text as entity_type,
      p.id             as entity_id,
      p.name           as title,
      nullif(p.address->>'line1', '') as subtitle,
      word_similarity(v_q, public.normalize_search_text(p.name || ' ' || coalesce(p.address->>'line1','')))::real as score
    from public.properties p
    where p.deleted_at is null
      and p.account_id = p_account_id
      and (p_types   is null or 'property' = any(p_types))
      and (p_exclude is null or 'property' <> all(p_exclude))
      and public.normalize_search_text(p.name || ' ' || coalesce(p.address->>'line1','')) ilike v_pattern escape '\'

    union all

    -- ---- areas -----------------------------------------------------------
    select
      'area'::text as entity_type,
      a.id         as entity_id,
      a.name       as title,
      a.kind       as subtitle,
      word_similarity(v_q, public.normalize_search_text(a.name))::real as score
    from public.areas a
    where a.deleted_at is null
      and a.account_id = p_account_id
      and (p_types   is null or 'area' = any(p_types))
      and (p_exclude is null or 'area' <> all(p_exclude))
      and public.normalize_search_text(a.name) ilike v_pattern escape '\'

    union all

    -- ---- maintenance_requests --------------------------------------------
    select
      'maintenance_request'::text as entity_type,
      m.id                        as entity_id,
      m.title                     as title,
      m.status                    as subtitle,
      word_similarity(v_q, public.normalize_search_text(m.title))::real as score
    from public.maintenance_requests m
    where m.deleted_at is null
      and m.account_id = p_account_id
      and (p_types   is null or 'maintenance_request' = any(p_types))
      and (p_exclude is null or 'maintenance_request' <> all(p_exclude))
      and public.normalize_search_text(m.title) ilike v_pattern escape '\'
  ) s
  order by s.score desc, s.title asc, s.entity_type asc
  limit greatest(p_limit, 0);
end;
$$;
