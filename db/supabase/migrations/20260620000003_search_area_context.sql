-- ----------------------------------------------------------------------------
-- Entity search: tagged context union + `area` disambiguation context (PR 1 of
-- the landlord-agent "core-asks-search-context" enrichment).
--
-- Two changes to search_entities(), nothing else (signature/return/matching all
-- unchanged from 20260620000002):
--
--   1. Every context object now carries a `kind` discriminator ('tenant',
--      'area', ...) so the OpenAPI `context` is a TAGGED union and the agent's
--      generated client narrows on context.kind instead of casting on the
--      sibling entity_type.
--
--   2. `area` results now carry context: the unit's property (the disambiguator
--      that distinguishes two "Apt 1" across buildings) plus current occupancy
--      and the RELATIONAL handoff `active_tenancy_id` -- "the tenant of this
--      unit" -- so a maintenance ack can address the occupant with no second
--      fetch. The area's own unit/common kind is exposed as `area_kind` because
--      the union discriminator already owns `kind`.
--
-- Still computed only for the rows that survive ORDER BY ... LIMIT (one lookup
-- per RETURNED row, not per match), and still SECURITY INVOKER so RLS scopes
-- every read. Additive: tenant context fields are unchanged; vendor/property/
-- maintenance_request stay null until later PRs in this track.
-- ----------------------------------------------------------------------------

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

  v_q := public.normalize_search_text(p_q);
  if char_length(v_q) < 1 then
    return;
  end if;
  v_pattern := '%' || replace(replace(replace(v_q, '\', '\\'), '%', '\%'), '_', '\_') || '%';

  return query
  select
    s.entity_type, s.entity_id, s.title, s.subtitle, s.score,
    -- Per-type, TAGGED disambiguation context. One lookup per RETURNED row.
    case
      -- tenant: current unit + property via the most relevant tenancy.
      when s.entity_type = 'tenant' then (
        select jsonb_build_object(
          'kind',           'tenant',
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
      )
      -- area: property disambiguator + occupancy + the active-tenancy handoff.
      -- The area's most relevant active/holdover tenancy (if any) drives
      -- occupancy_status, active_tenancy_id, and the occupant name list.
      when s.entity_type = 'area' then (
        select jsonb_build_object(
          'kind',              'area',
          'property_id',       p.id,
          'property_name',     p.name,
          'address',           nullif(p.address->>'line1', ''),
          'area_kind',         a.kind,
          'active_tenancy_id', act.tenancy_id,
          'tenant_names',      coalesce(act.tenant_names, array[]::text[]),
          'occupancy_status',  case when act.tenancy_id is not null then 'occupied' else 'vacant' end
        )
        from public.areas a
        join public.properties p
          on p.id = a.property_id and p.account_id = p_account_id and p.deleted_at is null
        left join lateral (
          select
            tn2.id as tenancy_id,
            array_remove(
              array_agg(te.full_name order by (tt2.role = 'primary') desc, te.full_name),
              null
            ) as tenant_names
          from public.tenancies tn2
          left join public.tenancy_tenants tt2
            on tt2.tenancy_id = tn2.id and tt2.account_id = p_account_id and tt2.deleted_at is null
          left join public.tenants te
            on te.id = tt2.tenant_id and te.account_id = p_account_id and te.deleted_at is null
          where tn2.area_id    = a.id
            and tn2.account_id = p_account_id
            and tn2.deleted_at is null
            and tn2.status in ('active', 'holdover')
          group by tn2.id, tn2.start_date
          order by tn2.start_date desc, tn2.id desc
          limit 1
        ) act on true
        where a.id = s.entity_id and a.account_id = p_account_id and a.deleted_at is null
      )
      else null
    end as context
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
