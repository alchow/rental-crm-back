-- ----------------------------------------------------------------------------
-- ADR-0009 hardening: indexes for the agent token-exchange hot paths.
-- (Post-merge CTO audit; both gaps confirmed by pg_indexes inspection.)
--
-- (1) GET /v1/agent/accounts -- discovery, called on every agent fan-out cycle.
--     listGrantedAccounts (admin/agent-tokens.ts) filters
--       agent_principal_id = ? AND revoked_at IS NULL  ORDER BY granted_at DESC
--     No existing index leads with agent_principal_id (agent_grants_active_uq
--     leads with account_id), so this was a sequential scan of every active
--     grant in the table. This partial index serves both the filter and the
--     ordering -- O(active grants for the principal), and no sort node.
--
-- (2) requireRootPrincipal (admin/agent-tokens.ts) authenticates EVERY agent
--     request by `secret_hash = ?`. secret_hash had no index (unlike
--     intake_tokens.secret_hash, which is UNIQUE). Unique because each
--     principal owns a distinct secret; partial because secret_hash is nullable
--     (a principal row can exist before a secret is provisioned).
-- ----------------------------------------------------------------------------

create index agent_grants_principal_active_idx
  on public.agent_grants (agent_principal_id, granted_at desc)
  where revoked_at is null;

create unique index agent_principals_secret_hash_idx
  on public.agent_principals (secret_hash)
  where secret_hash is not null;
