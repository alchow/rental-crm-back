import { createRoute, z } from '@hono/zod-openapi';
import { newApiApp } from './_lib/app';
import { getSb } from '../supabase/request-client';
import { ApiError, dbError, errorResponses } from './_lib/error';
import { normalizePhone } from './_lib/phone';

// ---------------------------------------------------------------------------
// Owner (landlord) phone verification — agent-only persist endpoint.
//
// POST /accounts/{accountId}/owner-phone-verifications
//   body: { user_id, phone }
//
// This is the COMMIT of the SMS OTP flow. landlord-agent owns the challenge
// lifecycle (issues the code, sends it over Telnyx, checks the reply). After it
// confirms the code it calls THIS endpoint, authenticated as the agent
// principal, to record the verified number in the system of record. The number
// then reads back as verified on GET /v1/profile (phone + phone_verified_at).
//
// Why agent-only: if a landlord token could set phone_verified_at, the SMS step
// could be skipped entirely. The handler rejects any non-agent principal, and
// the underlying set_owner_phone_verified() RPC re-checks the same thing from
// the JWT (defence in depth). The RPC is SECURITY DEFINER because the agent's
// JWT (auth.uid() = agent) cannot write the landlord's users row under RLS.
//
// Account-scoped, so the shared v1 middleware (auth -> membership -> principal
// -> idempotency) applies: an Idempotency-Key is required, matching every other
// mutating account-scoped route.
// ---------------------------------------------------------------------------

const AccountParam = z.object({
  accountId: z.string().uuid().openapi({ param: { name: 'accountId', in: 'path' } }),
});

const VerifyOwnerPhoneBody = z
  .object({
    user_id: z.string().uuid(),
    phone: z.string().min(1).max(32),
  })
  .openapi('VerifyOwnerPhoneBody');

const OwnerPhoneResponse = z
  .object({
    user_id: z.string().uuid(),
    phone: z.string(),
    phone_verified_at: z.string(),
  })
  .openapi('OwnerPhoneResponse');

const verify = createRoute({
  method: 'post',
  path: '/accounts/{accountId}/owner-phone-verifications',
  tags: ['owner-phone'],
  summary:
    'Record a landlord phone as verified. Agent principal only — called by ' +
    'landlord-agent after it has confirmed the SMS OTP. Persists phone + ' +
    'phone_verified_at on the target user.',
  request: {
    params: AccountParam,
    body: { content: { 'application/json': { schema: VerifyOwnerPhoneBody } }, required: true },
  },
  responses: {
    200: { description: 'verified', content: { 'application/json': { schema: OwnerPhoneResponse } } },
    ...errorResponses,
  },
});

export const ownerPhoneApp = newApiApp();

ownerPhoneApp.openapi(verify, async (c) => {
  const { accountId } = c.req.valid('param');
  const body = c.req.valid('json');
  const sb = getSb(c);
  const principal = c.get('principal');

  // Agent-only: a landlord must not be able to flip their own verified bit.
  if (principal.type !== 'agent') {
    throw new ApiError(403, 'agent_only', 'phone verification may only be recorded by the agent principal');
  }

  // Normalise to E.164 so the stored value matches the users.phone CHECK (same
  // rule the profile route applies before a write).
  const phone = normalizePhone(body.phone);
  if (!phone) {
    throw new ApiError(422, 'invalid_phone', `could not resolve '${body.phone}' to a valid E.164 number`);
  }

  const { data, error } = await sb.rpc('set_owner_phone_verified', {
    p_account_id: accountId,
    p_user_id: body.user_id,
    p_phone: phone,
  });

  if (error) {
    // 42501 raised by the RPC when the caller is not the account's agent.
    if (error.code === '42501') throw new ApiError(403, 'agent_only', 'not authorized to verify this phone');
    // P0002 raised when the target user is not a member of the account.
    if (error.code === 'P0002') throw new ApiError(404, 'not_found', 'user is not a member of this account');
    throw dbError(error);
  }

  const row = data as { id: string; phone: string; phone_verified_at: string };
  return c.json(
    { user_id: row.id, phone: row.phone, phone_verified_at: row.phone_verified_at },
    200,
  );
});
