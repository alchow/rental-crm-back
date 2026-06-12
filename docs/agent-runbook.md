# Agent service-account provisioning runbook

Per-environment operations for the agent principal (ADR-0006). One service
account per environment; one membership row per serviced account.

## Provision a new environment

1. **Create the auth user** in Supabase Auth (Dashboard → Authentication →
   Users → Add user, or via the admin API):
   - Email: `agent@<env>.internal` (never a real mailbox)
   - Password: strong random secret — store in the environment's secret manager
   - Confirm email immediately (`email_confirm: true` on the admin API call)

2. **Set `AGENT_USER_ID`** in the service's environment variables to the new
   user's UUID. Until this is set, no request can classify as the agent
   principal (safe default).

3. **Insert an `account_members` row** for each account the agent must service:
   ```sql
   insert into public.account_members (account_id, user_id, role)
   values ('<account-uuid>', '<agent-user-uuid>', 'agent');
   ```
   The agent must be a member before its JWT passes `requireAccountMembership`.

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
