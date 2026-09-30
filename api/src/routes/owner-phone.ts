import { recordOwnerPhoneVerification } from '../admin/owner-phone-verifier';
import { createRoute, z } from '@hono/zod-openapi';
import { newApiApp } from './_lib/app';
import { getSb } from '../supabase/request-client';
import { ApiError, dbError, errorResponses, ErrorEnvelope, conflictResponse } from './_lib/error';
import { normalizePhone } from './_lib/phone';

// Commits an SMS OTP verification completed by the agent service.
// DATA FLOW: agent verifies OTP -> this route -> set_owner_phone_verified RPC
// -> GET /v1/profile exposes phone + phone_verified_at.
// SECURITY: Both route and RPC require the agent principal; allowing a landlord
// token would bypass OTP. The SECURITY DEFINER RPC writes the landlord row that
// the agent JWT cannot update under RLS.

const AccountParam = z.object({
  accountId: z
    .string()
    .uuid()
    .openapi({ param: { name: 'accountId', in: 'path' } }),
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
    200: {
      description: 'verified',
      content: { 'application/json': { schema: OwnerPhoneResponse } },
    },
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
    throw new ApiError(
      403,
      'agent_only',
      'phone verification may only be recorded by the agent principal',
    );
  }

  // Normalise to E.164 so the stored value matches the users.phone CHECK (same
  // rule the profile route applies before a write).
  const phone = normalizePhone(body.phone);
  if (!phone) {
    throw new ApiError(
      422,
      'invalid_phone',
      `could not resolve '${body.phone}' to a valid E.164 number`,
    );
  }

  const { data, error } = await sb.rpc('set_owner_phone_verified', {
    p_account_id: accountId,
    p_user_id: body.user_id,
    p_phone: phone,
  });

  if (error) {
    // 42501 raised by the RPC when the caller is not the account's agent.
    if (error.code === '42501')
      throw new ApiError(403, 'agent_only', 'not authorized to verify this phone');
    // P0002 raised when the target user is not a member of the account.
    if (error.code === 'P0002')
      throw new ApiError(404, 'not_found', 'user is not a member of this account');
    throw dbError(error);
  }

  const row = data as { id: string; phone: string; phone_verified_at: string };
  return c.json(
    { user_id: row.id, phone: row.phone, phone_verified_at: row.phone_verified_at },
    200,
  );
});

// This route owns its atomic receipts: generic response caching must not skip
// the verifier credential and live membership checks on retries.
const confirm = createRoute({
  method: 'post',
  path: '/accounts/{accountId}/owner-phone-verifications/confirm',
  tags: ['owner-phone'],
  summary:
    'Record the current human caller’s verified phone with a dedicated SMS verifier credential',
  request: {
    params: AccountParam,
    headers: z.object({
      'x-phone-verifier-key-id': z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
      'x-phone-verifier-secret': z.string().min(32).max(256),
      'idempotency-key': z.string(),
      'x-correlation-id': z.string().min(1).max(200),
    }),
    body: {
      required: true,
      content: {
        'application/json': {
          schema: z
            .object({
              verification_id: z.string().uuid(),
              phone: z.string().regex(/^\+[1-9][0-9]{6,14}$/),
              expires_at: z.string().datetime({ offset: true }),
            })
            .strict()
            .openapi('ConfirmOwnerPhoneBody'),
        },
      },
    },
  },
  responses: {
    200: {
      description: 'verified; retries return the original result',
      content: { 'application/json': { schema: OwnerPhoneResponse } },
    },
    401: {
      description: 'human authentication required',
      content: { 'application/json': { schema: ErrorEnvelope } },
    },
    403: {
      description: 'invalid verifier or caller role',
      content: { 'application/json': { schema: ErrorEnvelope } },
    },
    ...errorResponses,
    ...conflictResponse,
  },
});

ownerPhoneApp.openapi(confirm, async (c) => {
  if (c.get('principal').type !== 'user') {
    throw new ApiError(403, 'forbidden', 'a human caller is required');
  }
  const body = c.req.valid('json');
  const headers = c.req.valid('header');
  if (headers['idempotency-key'] !== `owner-phone-${body.verification_id}`) {
    throw new ApiError(400, 'invalid_request', 'idempotency key must identify the verification');
  }
  const result = await recordOwnerPhoneVerification({
    keyId: headers['x-phone-verifier-key-id'],
    secret: headers['x-phone-verifier-secret'],
    userId: c.get('auth').userId,
    accountId: c.req.valid('param').accountId,
    verificationId: body.verification_id,
    phone: body.phone,
    expiresAt: body.expires_at,
    correlationId: headers['x-correlation-id'],
  });
  if (result.replayed) c.header('Idempotency-Replay', 'true');
  return c.json(
    { user_id: result.user_id, phone: result.phone, phone_verified_at: result.phone_verified_at },
    200,
  );
});
