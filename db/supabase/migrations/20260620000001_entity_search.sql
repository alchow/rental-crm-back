-- ----------------------------------------------------------------------------
-- Entity search: trigram-backed fuzzy / substring lookup, scoped to ONE account.
--
-- A landlord (or the AI agent -- same API surface) types a fragment like "jon"
-- and gets ranked matches across the principal entity types within their own
-- account. The ranking is Postgres trigram word-similarity; the substring gate
-- is a wildcard-safe ILIKE so even a 2-char fragment short-circuits cheaply.
--
-- Isolation: search_entities() is SECURITY INVOKER. Every SELECT inside it runs
-- as the calling member, so the Phase 2 per-account member-only RLS policies
-- (is_account_member(account_id)) are the account-isolation guarantee -- there
-- is NO definer privilege to leak rows across accounts. The explicit
-- `account_id = p_account_id` predicate in each branch is defense-in-depth and
-- a planner hint; RLS is what actually enforces tenancy.
--
-- No schema change to existing tables: the domain tables carry an AFTER trigger
-- that writes a hash-chained audit event (Phase 3), so a generated/stored
-- search column would bloat every event payload. We use EXPRESSION indexes only
-- -- the index expression and the function's ILIKE / word_similarity candidate
-- expression are kept BYTE-IDENTICAL so the planner can use the GIN index.
-- ----------------------------------------------------------------------------

-- ============================================================================
-- 1. pg_trgm: trigram operator classes + word_similarity()
-- ============================================================================
--
-- Not previously enabled. pg_trgm provides the gin_trgm_ops operator class
-- (so a GIN index can accelerate ILIKE substring/fuzzy matching) and the
-- word_similarity() function used for ranking. Idempotent on a fresh DB.
create extension if not exists pg_trgm;

-- ============================================================================
-- 1b. tenant_search_text(): IMMUTABLE wrapper so the tenant index is legal
-- ============================================================================
--
-- array_to_string() is only STABLE (its text output can in principle depend on
-- an array element type's output function), so Postgres refuses it directly in
-- an index expression (42P17: "functions in index expression must be marked
-- IMMUTABLE"). For a text[] the result is in fact immutable, so we wrap the
-- tenant search-text construction (full_name + emails) in an IMMUTABLE SQL
-- function and index THAT. Both the index and search_entities() call this exact
-- function, so the expressions stay byte-identical and the planner still uses
-- the GIN index. (The other entity types use jsonb `->>`, which IS immutable,
-- so only tenants -- the one array-valued search field -- needs the wrapper.)
create or replace function public.tenant_search_text(p_full_name text, p_emails text[])
returns text
language sql
immutable
as $$
  select p_full_name || ' ' || array_to_string(coalesce(p_emails, '{}'::text[]), ' ');
$$;

-- ============================================================================
-- 2. Expression trigram GIN indexes (partial: live rows only)
-- ============================================================================
--
-- Partial on `deleted_at is null` so tombstoned rows never bloat the index and
-- the search (which also filters deleted_at is null) stays index-eligible.
--
-- CRITICAL: each index expression below must stay byte-identical to the ILIKE
-- and word_similarity() candidate expression in the matching branch of
-- search_entities() -- the planner only uses an expression index when the query
-- expression matches it exactly.

create index if not exists tenants_search_trgm_idx
  on public.tenants
  using gin (public.tenant_search_text(full_name, emails) gin_trgm_ops)
  where deleted_at is null;

create index if not exists vendors_search_trgm_idx
  on public.vendors
  using gin ((name || ' ' || coalesce(contact->>'email','') || ' ' || coalesce(contact->>'phone','')) gin_trgm_ops)
  where deleted_at is null;

create index if not exists properties_search_trgm_idx
  on public.properties
  using gin ((name || ' ' || coalesce(address->>'line1','')) gin_trgm_ops)
  where deleted_at is null;

create index if not exists areas_search_trgm_idx
  on public.areas
  using gin ((name) gin_trgm_ops)
  where deleted_at is null;

create index if not exists maintenance_requests_search_trgm_idx
  on public.maintenance_requests
  using gin ((title) gin_trgm_ops)
  where deleted_at is null;

-- ============================================================================
-- 3. search_entities(): ranked, account-scoped, multi-type search
-- ============================================================================
--
-- Contract (the API layer is built in parallel against this exact signature --
-- do not rename / reorder / retype):
--   p_account_id  the account to search within (RLS still enforces membership)
--   p_q           the raw user query fragment
--   p_types       allow-list of entity types; null => all types
--   p_exclude     deny-list of entity types; null => exclude none
--   p_limit       overall row cap across all types (clamped to >= 0)
--
-- Returns one ranked row stream: (entity_type, entity_id, title, subtitle,
-- score, context), ordered by score desc then title asc then entity_type asc.
-- `context` is a STRUCTURED disambiguation object (not a flattened string) so
-- the dashboard and the agent branch on typed fields. Only tenant rows carry
-- it today: the tenant's current unit + property (see the outer query).
--
-- SECURITY INVOKER (see header): RLS is the isolation boundary. STABLE because
-- it only reads. search_path pinned to public.

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
  v_pattern text;
begin
  -- A 1-char fragment is a trigram non-starter (no full trigram) and would
  -- scan the world. Require at least 2 non-blank chars; otherwise no rows.
  if char_length(btrim(p_q)) < 2 then
    return;
  end if;

  -- Build the ILIKE substring pattern ONCE. Escape the LIKE metacharacters in
  -- the user input (backslash first, so we don't double-escape the escapes we
  -- add for % and _) so a user typing `%` or `_` matches those literal
  -- characters instead of acting as a wildcard. Used with `escape '\'` below.
  v_pattern := '%' || replace(replace(replace(btrim(p_q), '\', '\\'), '%', '\%'), '_', '\_') || '%';

  return query
  select
    s.entity_type, s.entity_id, s.title, s.subtitle, s.score,
    -- Structured disambiguation context. Only tenants carry it: the tenant's
    -- current unit + property, resolved through their most relevant tenancy
    -- (active/holdover first, then most recent start). This scalar subquery
    -- lives in the OUTER select -- it is evaluated only for the rows that
    -- survive the ORDER BY ... LIMIT, so it costs one lookup per RETURNED row,
    -- not one per match. NULL for non-tenant rows and for tenants with no
    -- resolvable tenancy. RLS (security invoker) still applies to every table
    -- it reads; the explicit account_id predicate is defense-in-depth.
    case when s.entity_type = 'tenant' then (
      select jsonb_build_object(
        'unit_name',      ar.name,
        'property_name',  pr.name,
        'area_id',        ar.id,
        'tenancy_id',     tn.id,
        'tenancy_status', tn.status
      )
      from public.tenancy_tenants tt
      join public.tenancies  tn on tn.id = tt.tenancy_id   and tn.deleted_at is null
      join public.areas      ar on ar.id = tn.area_id      and ar.deleted_at is null
      join public.properties pr on pr.id = ar.property_id  and pr.deleted_at is null
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
      word_similarity(btrim(p_q), public.tenant_search_text(t.full_name, t.emails))::real as score
    from public.tenants t
    where t.deleted_at is null
      and t.account_id = p_account_id
      and (p_types   is null or 'tenant' = any(p_types))
      and (p_exclude is null or 'tenant' <> all(p_exclude))
      and public.tenant_search_text(t.full_name, t.emails) ilike v_pattern escape '\'

    union all

    -- ---- vendors ---------------------------------------------------------
    select
      'vendor'::text as entity_type,
      v.id           as entity_id,
      v.name         as title,
      nullif(coalesce(v.contact->>'email', v.contact->>'phone'), '') as subtitle,
      word_similarity(btrim(p_q), (v.name || ' ' || coalesce(v.contact->>'email','') || ' ' || coalesce(v.contact->>'phone','')))::real as score
    from public.vendors v
    where v.deleted_at is null
      and v.account_id = p_account_id
      and (p_types   is null or 'vendor' = any(p_types))
      and (p_exclude is null or 'vendor' <> all(p_exclude))
      and (v.name || ' ' || coalesce(v.contact->>'email','') || ' ' || coalesce(v.contact->>'phone','')) ilike v_pattern escape '\'

    union all

    -- ---- properties ------------------------------------------------------
    select
      'property'::text as entity_type,
      p.id             as entity_id,
      p.name           as title,
      nullif(p.address->>'line1', '') as subtitle,
      word_similarity(btrim(p_q), (p.name || ' ' || coalesce(p.address->>'line1','')))::real as score
    from public.properties p
    where p.deleted_at is null
      and p.account_id = p_account_id
      and (p_types   is null or 'property' = any(p_types))
      and (p_exclude is null or 'property' <> all(p_exclude))
      and (p.name || ' ' || coalesce(p.address->>'line1','')) ilike v_pattern escape '\'

    union all

    -- ---- areas -----------------------------------------------------------
    select
      'area'::text as entity_type,
      a.id         as entity_id,
      a.name       as title,
      a.kind       as subtitle,
      word_similarity(btrim(p_q), (a.name))::real as score
    from public.areas a
    where a.deleted_at is null
      and a.account_id = p_account_id
      and (p_types   is null or 'area' = any(p_types))
      and (p_exclude is null or 'area' <> all(p_exclude))
      and (a.name) ilike v_pattern escape '\'

    union all

    -- ---- maintenance_requests --------------------------------------------
    select
      'maintenance_request'::text as entity_type,
      m.id                        as entity_id,
      m.title                     as title,
      m.status                    as subtitle,
      word_similarity(btrim(p_q), (m.title))::real as score
    from public.maintenance_requests m
    where m.deleted_at is null
      and m.account_id = p_account_id
      and (p_types   is null or 'maintenance_request' = any(p_types))
      and (p_exclude is null or 'maintenance_request' <> all(p_exclude))
      and (m.title) ilike v_pattern escape '\'
  ) s
  order by s.score desc, s.title asc, s.entity_type asc
  limit greatest(p_limit, 0);
end;
$$;

-- PostgREST exposes this RPC to logged-in members. RLS inside the function
-- (security invoker) still constrains every read to accounts the caller
-- belongs to, so the grant is safe.
grant execute on function public.search_entities(uuid, text, text[], text[], int) to authenticated;
