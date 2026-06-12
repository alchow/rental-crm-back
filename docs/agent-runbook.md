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

---

## Twilio webhook setup

### Required environment variables

Set these in the service's environment (Render dashboard or equivalent):

| Variable | Description |
|---|---|
| `TWILIO_ACCOUNT_SID` | Your Twilio Account SID (starts with `AC`). |
| `TWILIO_AUTH_TOKEN` | Your Twilio Auth Token (used to validate webhook signatures). |
| `TWILIO_MESSAGING_SERVICE_SID` | Your Twilio Messaging Service SID (starts with `MG`). |
| `PUBLIC_BASE_URL` | The public HTTPS URL of this API, e.g. `https://rental-crm-api.onrender.com`. **No trailing slash.** Used to construct status-callback URLs and to reconstruct the exact URL Twilio signed. |

If any of these are absent, the send endpoints return `503 messaging_unconfigured` and the webhook endpoints return `404`. `GET /healthz` → `capabilities.messaging.configured` tells you whether all vars are present.

### Webhook URLs to configure on the Messaging Service

In the Twilio Console → Messaging → Services → your Messaging Service:

- **Inbound message webhook URL**: `<PUBLIC_BASE_URL>/v1/twilio/inbound`
  HTTP method: `POST`
- **Status callback URL** (on each outbound message): set automatically by the send path as `<PUBLIC_BASE_URL>/v1/twilio/status?outbox_id=<uuid>`. You do not configure this in the console; it is per-message.

### Advanced Opt-Out (carrier compliance)

Enable **Advanced Opt-Out** on the Messaging Service in the Twilio Console. Twilio sends the carrier-mandated STOP/START/HELP auto-replies; this API keeps the authoritative local opt-out registry (`sms_opt_outs`) in sync so the send path can refuse before dialling without an extra Twilio lookup. The two systems are complementary — do not disable either.

### 10DLC registration

Brand and campaign registration for 10DLC is operational, outside this repo. Complete registration before sending to US numbers.

### Real-credential smoke test (run once per environment, after env vars are set)

All automated tests run against a fake provider; this is the one manual pass
that proves the real Twilio wiring. Use a phone you control as the tenant's
number.

1. `GET /healthz` → `capabilities.messaging.configured` must be `true`.
2. Create (or pick) a tenant whose `phones[0]` is your test phone in E.164.
3. `POST /v1/accounts/{accountId}/messages` as a landlord user with
   `{ "channel": "sms", "recipient_type": "tenant", "recipient_id": "...", "body": "smoke test" }`
   and an `Idempotency-Key`. Expect 201 with a `provider_sid` (starts `SM`),
   and the SMS on your phone.
4. Replay the exact request with the SAME `Idempotency-Key` → identical 201
   body, **no second SMS** (the dangerous double-send surface — this replay
   check is the point of the smoke test).
5. Within ~a minute, `GET /v1/accounts/{accountId}/messages/{outbox_id}` →
   `status: "delivered"`, and `GET .../interactions/{interaction_id}` →
   `delivery_status: "delivered"` (proves the status webhook round-trip).
6. Reply **STOP** from your phone; then repeat step 3 with a new key →
   `409 sms_opted_out` (proves inbound webhook + opt-out registry). Reply
   **START** to clean up, and verify a send works again.
7. Reply with a normal text; `GET .../interactions` should show the inbound
   entry with `author_type: "tenant"` and your message body.

---

## `needs_reconcile` outbox rows — manual recovery procedure

An outbox row enters `needs_reconcile` status when the reconcile janitor finds it stuck in `sending` for longer than the configured threshold (default 1 hour). This means:
- The API's synchronous `complete_sms_send` call did not run (the API crashed or the RPC failed).
- No Twilio status callback arrived to complete the record.

There is no SQL-side way to know whether Twilio accepted the message without querying the Twilio API, so the janitor parks the row for human review rather than guessing.

### How to resolve

1. **Identify the message in the Twilio console.** Go to Monitor → Logs → Messages. Filter by the `To` number and the approximate send time. Find the message and note its `MessageSid`.

2. **If Twilio accepted the message (SID exists):**
   ```sql
   -- Step A: complete the outbox record and append the journal interaction.
   select public.complete_sms_send_system('<outbox-uuid>', '<MessageSid>');

   -- Step B: apply the current delivery status.
   -- p_status one of: 'sent', 'delivered', 'undeliverable', 'failed'
   select public.update_sms_delivery('<outbox-uuid>', '<MessageSid>', 'delivered');
   ```
   Both functions are SECURITY DEFINER and must be called as the service role (Supabase SQL editor → service role, or via `psql` with the service-role connection string).

3. **If Twilio never received the message (no SID):**
   ```sql
   -- Mark as failed; no journal entry (nothing was sent — ADR-0007).
   update public.message_outbox
   set status = 'failed',
       error_code = 'no_provider_sid',
       error_message = 'manually resolved: Twilio never received this message',
       updated_at = now()
   where id = '<outbox-uuid>';
   ```

4. **Verify.** After resolution, `GET /accounts/{accountId}/messages/{id}` should show the correct status. If the message was delivered, `GET /interactions/{id}` should show `delivery_status='delivered'`.

---

## Reconcile janitor scheduling

The `reconcile_message_outbox` function parks stale `sending` rows. Schedule it as an operational cron job — the same convention as the Phase 11 janitors (`prune_ip_rate_buckets`, `prune_idempotency_keys`):

```sql
-- Run every 15 minutes; park rows stuck in 'sending' for > 1 hour.
select public.reconcile_message_outbox(3600);
```

Schedule via `pg_cron` (Supabase Dashboard → Database → Cron Jobs) or an external scheduler that can connect to the DB with the service role. The function is idempotent and safe to run concurrently (it locks rows `for update` internally).
