-- ----------------------------------------------------------------------------
-- CI guard: no non-allowlisted public SECURITY DEFINER function may be
-- executable by the `anon` or `authenticated` role.
--
-- WHY THIS EXISTS
-- On Supabase, default privileges (from pg_default_acl owned by postgres/
-- supabase_admin) explicitly grant EXECUTE on every new public function to
-- `anon`, `authenticated`, and `service_role`. A bare `revoke execute ...
-- from public` is a NO-OP against those grants, so any SECURITY DEFINER
-- function that bypasses RLS stays callable by anon/authenticated directly
-- via PostgREST (/rest/v1/rpc/<fn>) using the public anon key. The correct
-- fix is to revoke from the roles themselves; migration 20260628000009 does
-- this. This script fails the build if that protection regresses.
--
-- The same default ACL is replicated in db/test/supabase_compat.sql (the CI
-- primer) so that CI and prod are in the same starting state before migrations
-- apply -- making this guard meaningful rather than vacuous.
--
-- ALLOWLIST (intended anon- or authenticated-callable SECURITY DEFINER fns)
-- These functions are self-defending via auth.uid() or explicit membership
-- checks, so leaving anon/authenticated EXECUTE on them is intentional:
--   * create_account_for_new_user     -- first-account guard keyed on auth.uid()
--   * create_payment_with_allocations -- belt-and-braces membership check inside
--   * set_owner_phone_verified        -- account_members + auth.uid()
--   * is_approver_member              -- result AND-ed with is_account_member(auth.uid());
--                                        called by the authenticated interactions route
--   Comms ledger (20260701000002) — each asserts live membership in the
--   account it acts on BEFORE any read/write (raising 42501 otherwise):
--   * complete_send                   -- member of the outbox row's account
--   * capture_inbound                 -- agent-role member of p_account_id
--   * record_opt_out                  -- agent-role member of p_account_id
--   * list_account_opt_outs           -- member of p_account_id; result is
--                                        intersected with the account's own
--                                        channel_identities (no address oracle)
-- (Migration 009 also revokes anon from the first four — the comms migration
--  does the same for its own — so authenticated is the only non-service_role
--  grantee that remains on any public SECURITY DEFINER function.)
--
-- Any SECURITY DEFINER function NOT in this list must be service_role-only.
-- ----------------------------------------------------------------------------

DO $$
DECLARE
  p            record;
  fn_name      text;
  which_roles  text;
  violations   text[] := '{}';
  allowlist    text[] := ARRAY[
    'create_account_for_new_user',
    'create_payment_with_allocations',
    'set_owner_phone_verified',
    'is_approver_member',
    -- comms ledger (20260701000002): self-defending membership asserts inside
    'complete_send',
    'capture_inbound',
    'record_opt_out',
    'list_account_opt_outs',
    -- account email identity (20260703000003): asserts a live OWNER
    -- membership in the target account before writing
    'set_account_email_slug'
  ];
BEGIN

  -- ----------------------------------------------------------------
  -- Meaningfulness safeguard: every allowlisted name must exist as a
  -- public SECURITY DEFINER function. If it was renamed or dropped, we
  -- raise immediately so the allowlist cannot silently rot.
  -- ----------------------------------------------------------------
  FOREACH fn_name IN ARRAY allowlist LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM   pg_proc   pr
      JOIN   pg_namespace ns ON ns.oid = pr.pronamespace
      WHERE  ns.nspname  = 'public'
        AND  pr.proname  = fn_name
        AND  pr.prosecdef = true
    ) THEN
      RAISE EXCEPTION
        'SECURITY (allowlist rot): public SECURITY DEFINER function "%" not found '
        '-- it may have been renamed or dropped; update the allowlist in '
        'db/test/check_definer_grants.sql accordingly',
        fn_name;
    END IF;
  END LOOP;

  -- ----------------------------------------------------------------
  -- Main check: iterate every non-trigger public SECURITY DEFINER
  -- function that is NOT on the allowlist and assert that neither
  -- anon nor authenticated can EXECUTE it.
  -- ----------------------------------------------------------------
  FOR p IN
    SELECT pr.oid,
           pr.proname
    FROM   pg_proc      pr
    JOIN   pg_namespace ns ON ns.oid = pr.pronamespace
    WHERE  ns.nspname    = 'public'
      AND  pr.prosecdef  = true
      AND  pr.prorettype <> 'pg_catalog.trigger'::regtype
      AND  pr.proname    <> ALL(allowlist)
    ORDER  BY pr.proname
  LOOP
    which_roles := NULL;

    IF has_function_privilege('anon',          p.oid, 'execute') THEN
      which_roles := 'anon';
    END IF;
    IF has_function_privilege('authenticated', p.oid, 'execute') THEN
      which_roles := COALESCE(which_roles || ', ', '') || 'authenticated';
    END IF;

    IF which_roles IS NOT NULL THEN
      violations := violations || format('%I  (callable by: %s)', p.proname, which_roles);
    END IF;
  END LOOP;

  -- ----------------------------------------------------------------
  -- Verdict
  -- ----------------------------------------------------------------
  IF array_length(violations, 1) IS NOT NULL THEN
    RAISE EXCEPTION
      'SECURITY: % SECURITY DEFINER function(s) are anon/authenticated-executable '
      '(must be service_role only):%',
      array_length(violations, 1),
      E'\n  ' || array_to_string(violations, E'\n  ');
  END IF;

  RAISE NOTICE 'OK: all non-allowlisted public SECURITY DEFINER functions are locked to service_role.';

END $$;
