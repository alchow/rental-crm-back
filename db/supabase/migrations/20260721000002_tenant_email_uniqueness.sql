-- ----------------------------------------------------------------------------
-- Per-account tenant-email uniqueness — a write-time, trigger-enforced integrity
-- backstop plus a server-only conflict oracle for friendly API errors.
--
-- PRODUCT RULE
-- When an email is added to a tenant it must be unique WITHIN the landlord
-- account. A collision is not a silent dedupe: the error must SHOW WHO ELSE
-- holds the address so the operator can reconcile. Two collision classes:
--
--   1. tenant holder  — another live tenant in the same account already lists
--                        the address. This is a hard integrity conflict.
--   2. account_user    — the address is an owner/manager's LOGIN email
--                        (auth.users.email). The comms layer maps those to the
--                        'landlord_user' party, so letting a tenant also carry
--                        the address mis-attributes message direction. This is a
--                        conflict too, but it is enforced at the API layer only
--                        (see the trigger note) — never hard-blocked in the DB.
--
-- WRITE-TIME ONLY (grandfathering)
-- Production already contains duplicates (one address sits on three tenants in
-- one account, and also matches a landlord login). Enforcement therefore fires
-- on WRITES only: the trigger validates NEW.emails on INSERT / UPDATE OF emails,
-- so pre-existing rows are grandfathered structurally — no NOT VALID promotion,
-- no retroactive failure, and this migration cannot fail on dirty data (it adds
-- a function + a trigger, never a CHECK/UNIQUE over existing rows). The trade:
-- re-saving a still-duplicated address errors WITH its holders — deliberate, it
-- forces the operator to clean the duplicate up on the next edit of that row.
--
-- WHAT THIS MIGRATION ADDS
--   1. public._tenant_email_conflicts(account, emails, exclude?) — a SECURITY
--      DEFINER oracle returning every holder (tenant + account_user) that
--      overlaps the candidate addresses, normalized lower(btrim). service_role
--      only (CI guard db/test/check_definer_grants.sql), reached from the API
--      through the admin client wrapper api/src/admin/tenant-email-conflicts.ts.
--   2. A BEFORE INSERT OR UPDATE OF emails trigger on tenants that hard-blocks
--      TENANT-HOLDER conflicts (and intra-array duplicates) by raising 23505.
--      account_user collisions are intentionally NOT blocked here.
-- ----------------------------------------------------------------------------

-- ----------------------------------------------------------------------------
-- Conflict oracle — SERVER-ONLY.
--
-- Returns one row per (candidate address × holder) overlap within the account:
--
--   holder_kind = 'tenant'        another live tenant (deleted_at is null,
--                                  id <> p_exclude_tenant_id) whose emails array
--                                  contains the address; holder_name = full_name.
--   holder_kind = 'account_user'  an owner|manager account member whose
--                                  auth.users.email matches; holder_name =
--                                  public.users.display_name, falling back to the
--                                  login email when the profile has no name.
--
-- Comparison is normalized (lower(btrim)) on both sides. DISTINCT collapses the
-- duplicate rows a repeated address inside one tenant's array would otherwise
-- produce; multiple DISTINCT holders (the "who else" the product rule needs)
-- are preserved.
--
-- SECURITY DEFINER (owner = postgres): the account_user tier reads auth.users,
-- which only postgres may read — a user/anon/authenticated JWT cannot. STABLE
-- (pure read). search_path pinned to public so the lookups are unambiguous under
-- the definer context.
--
-- The grant is service_role ONLY (see the revoke/grant below):
--   * CI guard: db/test/check_definer_grants.sql requires every non-allowlisted
--     public SECURITY DEFINER function to be service_role-only, and this one is
--     not allowlisted.
--   * Enumeration: a direct /rest/v1/rpc grant to authenticated would let a
--     signed-in user of ANY account probe which addresses a landlord login uses.
--     Keeping the call server-side (admin client) closes that hole. The HTTP
--     surface stays user-gated at the tenants route, exactly like the branding
--     suggestions precedent (_email_subdomains_taken + admin/subdomains-taken.ts).
-- ----------------------------------------------------------------------------
create function public._tenant_email_conflicts(
  p_account_id       uuid,
  p_emails           text[],
  p_exclude_tenant_id uuid default null
)
  returns table (email text, holder_kind text, holder_id uuid, holder_name text)
  language sql
  stable
  security definer
  set search_path = public
as $$
  with wanted as (
    select distinct lower(btrim(e)) as norm
      from unnest(p_emails) as e
     where btrim(e) <> ''
  )
  -- Tier 1: other live tenants in the same account (grandfathered dupes still
  -- count — a persisting duplicate row IS a live holder).
  select distinct
         w.norm            as email,
         'tenant'::text    as holder_kind,
         t.id              as holder_id,
         t.full_name       as holder_name
    from public.tenants t
    cross join lateral unnest(t.emails) as te(addr)
    join wanted w on w.norm = lower(btrim(te.addr))
   where t.account_id = p_account_id
     and t.deleted_at is null
     and (p_exclude_tenant_id is null or t.id <> p_exclude_tenant_id)

  union all

  -- Tier 2: owner/manager login emails (never 'agent' — an agent principal is
  -- not a landlord identity the comms layer maps to landlord_user).
  select distinct
         w.norm                 as email,
         'account_user'::text   as holder_kind,
         m.user_id              as holder_id,
         coalesce(nullif(btrim(pu.display_name), ''), au.email) as holder_name
    from public.account_members m
    join auth.users au on au.id = m.user_id
    join wanted    w  on w.norm = lower(btrim(au.email))
    left join public.users pu on pu.id = m.user_id
   where m.account_id = p_account_id
     and m.deleted_at is null
     and m.role in ('owner', 'manager')
$$;

-- Lock the grant surface to service_role ONLY. A SECURITY DEFINER function
-- defaults to EXECUTE for PUBLIC, and Supabase's default ACL additionally grants
-- anon + authenticated — so revoke every non-service grantee explicitly, then
-- grant service_role. This satisfies db/test/check_definer_grants.sql (not
-- allowlisted → must be service_role-only) and closes the enumeration hole.
revoke all on function public._tenant_email_conflicts(uuid, text[], uuid)
  from public, anon, authenticated;
grant execute on function public._tenant_email_conflicts(uuid, text[], uuid)
  to service_role;

-- ----------------------------------------------------------------------------
-- Write-time integrity trigger.
--
-- Fires BEFORE INSERT, and BEFORE UPDATE OF emails, on tenants — only when
-- NEW.emails is non-empty (the WHEN clause skips the common "no emails" and
-- "clearing emails" writes). It raises 23505 (unique_violation, so PostgREST
-- maps a direct member write to HTTP 409) in two cases:
--
--   1. NEW.emails contains an intra-array duplicate after lower(btrim)
--      normalization ("a@x" + "A@x " in the same array).
--   2. _tenant_email_conflicts returns a TENANT-holder row — another live
--      tenant in the account already carries one of the addresses. The message
--      names the first colliding address and its holder(s).
--
-- IT BLOCKS ONLY TENANT-HOLDER CONFLICTS. account_user (landlord-login)
-- collisions are deliberately NOT hard-blocked at the DB: existing landlord-CC
-- flows legitimately reference landlord addresses, and a DB block here could
-- wedge that surface. The API layer still rejects an account_user collision with
-- a 409 (direction mis-attribution), so the asymmetry is: API blocks BOTH
-- classes; the DB backstop blocks only the tenant-holder class.
--
-- SECURITY DEFINER: the oracle it calls is service_role-only and reads
-- auth.users; the definer (owner = postgres) can invoke it. search_path pinned.
--
-- GRANDFATHERING: existing duplicates persist untouched until the next write to
-- that row's emails. Re-saving a still-duplicated address raises here with the
-- holder name(s) — intended, it makes the duplicate visible and forces cleanup.
-- ----------------------------------------------------------------------------
create function public._tenants_email_uniqueness_guard()
  returns trigger
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  v_dup      text;
  v_conflict record;
begin
  -- (1) Intra-array duplicate after normalization.
  select lower(btrim(e))
    into v_dup
    from unnest(NEW.emails) as e
   where btrim(e) <> ''
   group by lower(btrim(e))
  having count(*) > 1
   limit 1;
  if v_dup is not null then
    raise exception 'tenant emails contains duplicate address "%"', v_dup
      using errcode = '23505';
  end if;

  -- (2) Tenant-holder conflict (account_user collisions are API-level only).
  select c.email,
         string_agg(distinct c.holder_name, ', ') as holders
    into v_conflict
    from public._tenant_email_conflicts(NEW.account_id, NEW.emails, NEW.id) c
   where c.holder_kind = 'tenant'
   group by c.email
   order by c.email
   limit 1;

  if v_conflict.email is not null then
    raise exception 'email "%" already belongs to %', v_conflict.email, v_conflict.holders
      using errcode = '23505';
  end if;

  return NEW;
end;
$$;

-- Trigger invocation does not need an EXECUTE grant; revoke the default PUBLIC/
-- anon/authenticated/service_role grants so the SECURITY DEFINER function cannot
-- be called directly off a trigger context. The trigger owner (postgres) retains
-- execute for the trigger firing regardless. (Trigger-returning functions are
-- excluded from the check_definer_grants.sql loop, but we revoke anyway for
-- parity with _reject_reserved_email_subdomain.)
revoke all on function public._tenants_email_uniqueness_guard()
  from public, anon, authenticated, service_role;

create trigger tenants_email_uniqueness_guard
  before insert or update of emails on public.tenants
  for each row
  when (NEW.emails is not null and array_length(NEW.emails, 1) is not null)
  execute function public._tenants_email_uniqueness_guard();
