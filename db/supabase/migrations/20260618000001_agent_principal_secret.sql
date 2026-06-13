-- ----------------------------------------------------------------------------
-- Agent root-principal credential (ADR-0009 Phase 3).
--
-- agent_principals gains the credential the root agent presents to the
-- token-exchange endpoints (POST /v1/agent/tokens, GET /v1/agent/accounts):
--
--   secret_hash   sha256 of the root bearer secret. We store ONLY the hash --
--                 the same shape and rationale as intake_tokens.secret_hash
--                 (20260605000007): a DB read can never recover a live
--                 credential; the plaintext is shown ONCE at provisioning and
--                 never persisted. Nullable, because a principal row can be
--                 created lazily by the Phase-2 grant flow before any secret
--                 is set; a principal with a null secret_hash simply cannot
--                 authenticate.
--   secret_set_at when the current secret was provisioned/rotated (audit).
--
-- Root-auth mechanism decision (ADR-0009 Phase 3): a hashed bearer secret, not
-- an asymmetric client assertion. The agent is a first-party service that talks
-- only to core over TLS; a high-entropy secret stored hash-only matches the
-- intake-token precedent and is sufficient. Asymmetric client_assertion is the
-- documented upgrade path if the agent ever becomes a third-party client.
--
-- No RLS change: agent_principals is deny-all to authenticated (Phase 1,
-- RLS-without-policies + REVOKE); secret_hash is read/written exclusively by
-- the admin/ service-role auth + provisioning path, never on the user data path.
-- ----------------------------------------------------------------------------

alter table public.agent_principals
  add column secret_hash   bytea,
  add column secret_set_at timestamptz;
