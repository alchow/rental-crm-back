# Agent service-account provisioning runbook

Per-environment operations for the agent principal (ADR-0006; identity
classification generalized in ADR-0009). One service account per environment;
one membership row per serviced account.

## Provision a new environment

1. **Create the auth user** in Supabase Auth (Dashboard → Authentication →
   Users → Add user, or via the admin API):
   - Email: `agent@<env>.internal` (never a real mailbox)
   - Password: strong random secret — store in the environment's secret manager
   - Confirm email immediately (`email_confirm: true` on the admin API call)

2. **Insert an `account_members` row** for each account the agent must service:
   ```sql
   insert into public.account_members (account_id, user_id, role)
   values ('<account-uuid>', '<agent-user-uuid>', 'agent');
   ```
   The agent must be a member before its JWT passes `requireAccountMembership`.
   This `role='agent'` membership is also what classifies the request as the
   agent principal (ADR-0009) — there is **no `AGENT_USER_ID` env var to set**.
   A landlord can never hold `role='agent'`, so the mapping is exact.

## Agent authentication

The agent service authenticates with ordinary Supabase password login:
```
POST /v1/auth/login  { "email": "...", "password": "..." }
```
It owns the login/refresh cycle; core stays stateless. Use the returned
`access_token` as a Bearer token on every account-scoped request. Refresh
via `POST /v1/auth/refresh` before expiry.

## Token rotation

Rotate via Supabase's password-update API (Dashboard → Users → Reset
password, or admin SDK `auth.admin.updateUserById`). No core change is
needed — the agent service picks up new credentials on its next login cycle.

## Per-account enable / disable

- **Enable**: insert the `account_members` row (step 3 above).
- **Disable**: soft-delete the membership row:
  ```sql
  update public.account_members
  set deleted_at = now()
  where account_id = '<account-uuid>' and user_id = '<agent-user-uuid>';
  ```
  The membership middleware returns 404 on the next request; no JWT
  invalidation is required. Re-enable by clearing `deleted_at`.

---

## Multi-tenant agent (ADR-0009)

The single-account model above is **superseded** by per-account grants + a
root-principal token exchange. One agent serves many accounts; each account gets
its own `role='agent'` service-account user. The legacy single agent's broad
memberships are removed once every served account is grant-driven (the
**decommission** step below).

### Provision the root principal secret (once per environment)

The root agent authenticates to the token-exchange endpoints with a bearer
secret stored hash-only in `agent_principals.secret_hash`. Mint it once (shown
EXACTLY once — store it in the agent service's secret manager), with the target
environment's `SUPABASE_URL` + `SUPABASE_ANON_KEY` + `SUPABASE_SERVICE_ROLE_KEY`
in the env:

```
pnpm --filter ./api exec tsx -e "import('./src/admin/agent-tokens').then(m=>m.provisionRootSecret('default')).then(r=>console.log('ROOT SECRET (store now):',r.secret)).catch(e=>{console.error(e);process.exit(1)})"
```

Re-running rotates the secret (old one stops working immediately).

### Landlord enables/disables per account (self-serve)

Owner/manager calls `POST /v1/accounts/{accountId}/agent-grants`; core
provisions the per-account agent user + membership + grant. `POST
.../agent-grants/{id}/revoke` disables it (marks the grant revoked AND
soft-deletes the membership — the RLS kill). `GET .../agent-grants` lists them.

### Agent runtime (token exchange)

The agent service is purely a core API client (no Supabase credentials):

1. `GET /v1/agent/accounts` with header `X-Agent-Secret: <root secret>` → the
   accounts it may serve. **Authoritative**; re-check on any anomaly.
2. `POST /v1/agent/tokens` `{ "account_id": "…" }` with `X-Agent-Secret` → a
   short-lived Supabase session `{ access_token, refresh_token, expires_in,
   scopes }` scoped to that account.
3. Use `access_token` as the Bearer token on `/v1/accounts/{account_id}/*`.
   Refresh via `POST /v1/auth/refresh`; re-mint via `/v1/agent/tokens` only on a
   new account or refresh failure.
4. **404** on a previously-served account (or **403** on a write) = the grant
   was revoked → fail the workflow closed, drop the account from the fan-out,
   confirm via `GET /v1/agent/accounts`. **401** = refresh / re-mint.

### Decommission the legacy single agent (final cutover, ADR-0009 phase 5)

Once every served account has been re-enabled through the grant flow, remove the
original single agent user's cross-account memberships:

```sql
-- After confirming the new per-account agents exist (one role='agent' member
-- per granted account) and no active agent_grants reference the legacy user:
update public.account_members
set deleted_at = now()
where user_id = '<legacy-agent-user-uuid>' and role = 'agent' and deleted_at is null;
```

