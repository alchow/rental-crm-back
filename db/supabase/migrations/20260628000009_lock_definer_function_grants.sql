-- ----------------------------------------------------------------------------
-- Security hardening: lock service-role-only SECURITY DEFINER functions.
--
-- Root cause: on Supabase, default privileges (pg_default_acl; owners postgres +
-- supabase_admin) EXPLICITLY grant EXECUTE on every new public function to
-- `anon` + `authenticated`. So the prior `revoke execute ... from public`
-- pattern is a NO-OP against those grants, and every SECURITY DEFINER
-- (RLS-bypassing) function meant to be service-role-only stayed callable by
-- anon/authenticated DIRECTLY via PostgREST (/rest/v1/rpc/<fn>) with the public
-- anon key -- bypassing the token/membership checks that live only in the API.
--
-- Fix: explicitly revoke EXECUTE from anon + authenticated on every
-- service-role-only DEFINER function. (Migrations 20260628000008 and
-- 20260616000004_inbound_messaging.sql already did this correctly.) A CI guard
-- (db/test/check_definer_grants.sql) now fails the build if any non-allowlisted
-- public SECDEF function is anon/authenticated-executable, so this can't regress.
--
-- KEPT authenticated-callable (Group 2 below: revoke public + anon, KEEP
-- authenticated). Each is invoked by the authenticated user-client and
-- self-defends internally on auth.uid()/membership, so a direct PostgREST call
-- cannot cause cross-account harm; anon has no legitimate caller (all run inside
-- an authenticated session) so anon is revoked too. End-state invariant: NO
-- public SECURITY DEFINER function is anon-executable.
--   * create_account_for_new_user      -- first-account guard keyed on auth.uid()
--   * create_payment_with_allocations  -- auth.uid() + is_account_member() check
--   * set_owner_phone_verified         -- agent-role account-member check
--   * is_approver_member               -- result AND-ed with is_account_member(auth.uid())
-- ----------------------------------------------------------------------------

-- Group 1 -- service-role-only DEFINER functions (no legitimate anon/authenticated
-- caller: reached only via the admin/service-role client, cron, or from inside
-- another DEFINER function). Revoke EXECUTE from public + anon + authenticated.
revoke execute on function public.advance_tenancy_statuses(timestamptz) from public, anon, authenticated;
revoke execute on function public.bump_ip_rate_bucket(text, text, integer) from public, anon, authenticated;
revoke execute on function public.complete_evidence_export(uuid, uuid, text, text, bigint, timestamptz, boolean, text) from public, anon, authenticated;
revoke execute on function public.generate_rent_charges(uuid, timestamptz) from public, anon, authenticated;
revoke execute on function public.generate_scheduled_task_runs(uuid, timestamptz) from public, anon, authenticated;
revoke execute on function public.prune_idempotency_keys(integer, integer) from public, anon, authenticated;
revoke execute on function public.prune_ip_rate_buckets(integer) from public, anon, authenticated;
revoke execute on function public.submit_intake(uuid, uuid, uuid, text, text, text, timestamptz, text) from public, anon, authenticated;
revoke execute on function public.submit_intake_with_attachment(uuid, uuid, uuid, text, text, text, timestamptz, text, text, text, bigint, text, text, text, bigint, text) from public, anon, authenticated;
revoke execute on function public.tenant_submit_inspection(uuid, uuid, uuid) from public, anon, authenticated;
revoke execute on function public.tenant_update_inspection_item(uuid, uuid, uuid, uuid, text, text) from public, anon, authenticated;
revoke execute on function public.tenant_upsert_inspection_checks(uuid, uuid, uuid, jsonb) from public, anon, authenticated;
revoke execute on function public.verify_chain_incremental(uuid) from public, anon, authenticated;
revoke execute on function public.verify_chain_sweep(uuid) from public, anon, authenticated;

-- Re-assert the intended grantee (idempotent -- these already hold it; explicit
-- so the end state is unambiguous and a missing original grant can't bite).
grant execute on function public.advance_tenancy_statuses(timestamptz) to service_role;
grant execute on function public.bump_ip_rate_bucket(text, text, integer) to service_role;
grant execute on function public.complete_evidence_export(uuid, uuid, text, text, bigint, timestamptz, boolean, text) to service_role;
grant execute on function public.generate_rent_charges(uuid, timestamptz) to service_role;
grant execute on function public.generate_scheduled_task_runs(uuid, timestamptz) to service_role;
grant execute on function public.prune_idempotency_keys(integer, integer) to service_role;
grant execute on function public.prune_ip_rate_buckets(integer) to service_role;
grant execute on function public.submit_intake(uuid, uuid, uuid, text, text, text, timestamptz, text) to service_role;
grant execute on function public.submit_intake_with_attachment(uuid, uuid, uuid, text, text, text, timestamptz, text, text, text, bigint, text, text, text, bigint, text) to service_role;
grant execute on function public.tenant_submit_inspection(uuid, uuid, uuid) to service_role;
grant execute on function public.tenant_update_inspection_item(uuid, uuid, uuid, uuid, text, text) to service_role;
grant execute on function public.tenant_upsert_inspection_checks(uuid, uuid, uuid, jsonb) to service_role;
grant execute on function public.verify_chain_incremental(uuid) to service_role;
grant execute on function public.verify_chain_sweep(uuid) to service_role;

-- Group 2 -- authenticated-callable, self-defending DEFINER functions (each gates
-- internally on auth.uid()/membership; called by the authenticated user-client).
-- KEEP authenticated; revoke anon (+ public) -- no legitimate anon caller.
revoke execute on function public.create_account_for_new_user(text, text) from public, anon;
revoke execute on function public.create_payment_with_allocations(uuid, uuid, bigint, text, timestamptz, text, text, uuid, text, jsonb) from public, anon;
revoke execute on function public.set_owner_phone_verified(uuid, uuid, text) from public, anon;
revoke execute on function public.is_approver_member(uuid, uuid) from public, anon;

grant execute on function public.create_account_for_new_user(text, text) to authenticated;
grant execute on function public.create_payment_with_allocations(uuid, uuid, bigint, text, timestamptz, text, text, uuid, text, jsonb) to authenticated;
grant execute on function public.set_owner_phone_verified(uuid, uuid, text) to authenticated;
grant execute on function public.is_approver_member(uuid, uuid) to authenticated;
