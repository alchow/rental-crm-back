-- ----------------------------------------------------------------------------
-- Premium + ops reserved email subdomains — a file-driven, trigger-enforced
-- business-rule backstop.
--
-- The branding stack lets an owner/manager write accounts.email_subdomain
-- directly against PostgREST under the column grant added in 20260704000001, so
-- every policy the API enforces (routes/_lib/subdomain.ts) needs a DB backstop
-- or it is bypassable. The original backstop (accounts_email_subdomain_reserved,
-- 20260704000001) mirrors the static RESERVED_SUBDOMAINS list and is UNCHANGED.
--
-- This migration adds the DATA-DRIVEN half: the premium property-category names
-- the platform reserves for RESALE are no longer a hardcoded array + CHECK. They
-- live in a config file (api/src/config/premium-subdomains.json), and this
-- migration provides:
--
--   1. public.reserved_subdomain_labels — a table of reserved labels, each
--      tagged kind = 'premium' | 'ops'. It is the DB-side source of truth the
--      backstop reads. Premium rows are RECONCILED to the config file on every
--      API boot (admin/sync-premium-subdomains.ts); ops rows are
--      migration-managed and the sync never touches them.
--   2. A BEFORE-WRITE trigger on accounts that rejects a reserved label (or the
--      em<digits> return-path shape) — the unbypassable backstop for the
--      direct column-granted PostgREST write path.
--
-- No CHECK constraint (a fixed-literal CHECK is deliberately rejected here): a
-- CHECK would embed a hardcoded literal list, which would need a migration per
-- sale/addition. A table + boot sync lets the file drive the DB with zero
-- migrations. The trigger fires on WRITES only, so any account that already
-- holds a now-reserved label is grandfathered structurally — no NOT VALID dance,
-- no retroactive invalidation.
-- ----------------------------------------------------------------------------

-- ----------------------------------------------------------------------------
-- Reserved-label table.
--
-- label: a single lowercase RFC-1035 DNS label (same regex the branding format
--        CHECK enforces) — the primary key, so labels are unique and a re-insert
--        of the same label is a no-op under ON CONFLICT DO NOTHING (idempotent,
--        multi-instance-boot safe).
-- kind:  'premium' (file-driven, reconciled at boot) or 'ops' (migration-managed).
--
-- Source of truth for premium is api/src/config/premium-subdomains.json, synced
-- at API boot (premium rows only); ops rows are migration-managed.
-- ----------------------------------------------------------------------------
create table public.reserved_subdomain_labels (
  label      text primary key
             check (label ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'),
  kind       text not null check (kind in ('premium', 'ops')),
  created_at timestamptz not null default now()
);

comment on table public.reserved_subdomain_labels is
  'Reserved email-subdomain labels backing the accounts write trigger. '
  'kind=premium rows are the DB mirror of api/src/config/premium-subdomains.json '
  '(reconciled on every API boot by admin/sync-premium-subdomains.ts); kind=ops '
  'rows are migration-managed and the boot sync never touches them.';

-- Lock the surface. FORCE RLS with NO policies denies anon/authenticated even
-- if a grant leaks; the explicit revoke removes the grant too (belt + braces).
-- Only the SECURITY DEFINER trigger below (owner = postgres, rolbypassrls) and
-- the service-role boot sync (rolbypassrls) read/write this table.
alter table public.reserved_subdomain_labels enable row level security;
alter table public.reserved_subdomain_labels force row level security;

revoke all on public.reserved_subdomain_labels from public, anon, authenticated;
grant select, insert, delete on public.reserved_subdomain_labels to service_role;

-- ----------------------------------------------------------------------------
-- Day-0 seed: parity with the shipping API.
--   * 8 ops names (OPS_SUBDOMAINS in routes/_lib/premium-subdomains.ts) — these
--     stay migration-managed.
--   * 50 premium names (the initial contents of premium-subdomains.json) — so
--     the backstop is populated before the first boot sync runs. Premium rows
--     will be RECONCILED against the file on every boot thereafter (a sold name
--     is deleted, a newly added name is inserted).
-- ----------------------------------------------------------------------------
insert into public.reserved_subdomain_labels (label, kind)
select label, 'ops'
  from unnest(array[
    'smoke', 'dkim', 'dmarc', 'spf', 'mta', 'autodiscover', 'autoconfig', 'sterling'
  ]) as label;

insert into public.reserved_subdomain_labels (label, kind)
select label, 'premium'
  from unnest(array[
    'rent', 'rents', 'rental', 'rentals', 'lease', 'leases', 'leasing',
    'property', 'properties', 'propertymanagement', 'realty', 'realestate', 'estates',
    'home', 'homes', 'house', 'houses', 'housing',
    'apartment', 'apartments', 'apts', 'condo', 'condos', 'townhomes', 'duplex',
    'units', 'suites', 'lofts', 'villas', 'flats', 'residences', 'residential',
    'tenant', 'tenants', 'landlord', 'landlords', 'manager', 'management',
    'broker', 'brokerage', 'agent', 'agents', 'listings', 'forrent',
    'maintenance', 'inspections', 'screening', 'applications', 'hoa', 'communities'
  ]) as label;

-- ----------------------------------------------------------------------------
-- Write-time backstop.
--
-- Fires BEFORE INSERT, and BEFORE UPDATE OF email_subdomain, on accounts, only
-- when the new value is non-null. It rejects the em<digits> return-path shape
-- (SMTP2GO owns em<digits>.<parent>) and any label present in
-- reserved_subdomain_labels (premium OR ops). errcode 23514 (check_violation)
-- so PostgREST maps the direct write to a 4xx, matching the old CHECK's shape.
--
-- SECURITY DEFINER (owner = postgres): reserved_subdomain_labels has FORCE RLS
-- and no policies, so the invoking authenticated/service role cannot read it;
-- the definer (rolbypassrls) can. search_path pinned to public to keep the
-- lookup unambiguous under a definer context.
--
-- Semantics: WRITES only — existing holders of a label that later becomes
-- reserved are grandfathered structurally (no NOT VALID promotion needed). The
-- API layer rejects first with friendly 422s; this trigger only bites the
-- direct column-granted PostgREST write path.
-- ----------------------------------------------------------------------------
create or replace function public._reject_reserved_email_subdomain()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if NEW.email_subdomain ~ '^em[0-9]+$'
     or exists (
       select 1
         from public.reserved_subdomain_labels r
        where r.label = NEW.email_subdomain
     )
  then
    raise exception 'email_subdomain "%" is a reserved label', NEW.email_subdomain
      using errcode = '23514';
  end if;
  return NEW;
end;
$$;

-- Trigger invocation does not need EXECUTE; revoke the default PUBLIC grant so
-- the SECURITY DEFINER function cannot be called directly off a trigger context.
revoke all on function public._reject_reserved_email_subdomain()
  from public, anon, authenticated, service_role;

create trigger accounts_email_subdomain_reserved_guard
  before insert or update of email_subdomain on public.accounts
  for each row
  when (NEW.email_subdomain is not null)
  execute function public._reject_reserved_email_subdomain();

-- ----------------------------------------------------------------------------
-- Existence oracle for the suggestions endpoint — SERVER-ONLY.
--
-- public._email_subdomains_taken(candidates) returns the subset of the input
-- labels already claimed by SOME account. SECURITY DEFINER so it can see across
-- accounts (accounts carries only a member-SELECT policy under FORCE RLS, so a
-- user JWT cannot read another account's row) — but it returns ONLY the label
-- text, never the holding account's id or name.
--
-- It is called SERVER-SIDE ONLY, through the service-role admin client
-- (api/src/admin/subdomains-taken.ts) from the suggestions route (accounts.ts
-- /email-branding/suggestions, which is requireManager-gated). There is NO
-- direct PostgREST RPC path for any user JWT: the grant below is
-- service_role-only, so an anon/authenticated /rest/v1/rpc call is denied. That
-- closes an any-authenticated-user enumeration hole — a signed-in user of ANY
-- account could otherwise probe whether an arbitrary label is claimed — while
-- the gated route still lets an owner/manager learn "taken" (the same fact a
-- PATCH 409 reveals) for their own suggestion flow.
--
-- This also satisfies db/test/check_definer_grants.sql: the function is NOT on
-- that guard's allowlist, so the rule requires it be service_role-only.
-- ----------------------------------------------------------------------------
create function public._email_subdomains_taken(p_candidates text[])
  returns setof text
  language sql
  stable
  security definer
  set search_path = public
as $$
  select email_subdomain
    from public.accounts
   where email_subdomain = any (p_candidates)
$$;

-- Lock the grant surface to service_role ONLY. A SECURITY DEFINER function
-- defaults to EXECUTE for PUBLIC, and Supabase's default ACL additionally grants
-- anon + authenticated — so revoke every non-service grantee explicitly. The
-- function is invoked server-side via the service-role admin client (never off a
-- user JWT), which both closes the enumeration hole and satisfies
-- db/test/check_definer_grants.sql (not allowlisted → must be service_role-only).
revoke all on function public._email_subdomains_taken(text[]) from public, anon, authenticated;
grant execute on function public._email_subdomains_taken(text[]) to service_role;
