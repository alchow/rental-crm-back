import { z } from '@hono/zod-openapi';
import type { Context } from 'hono';

/**
 * Format a zod validation failure as the standard envelope. Every OpenAPIHono
 * `defaultHook` (the root app's and any sub-app's) should delegate here --
 * hooks do NOT inherit across `.route()` mounts, so a sub-app constructed
 * without one answers validation failures in zod-openapi's default shape
 * instead of ours.
 */
export function validationFailure(c: Context, error: { flatten(): unknown }): Response {
  return c.json(
    {
      error: {
        code: 'invalid_request',
        message: 'request validation failed',
        details: error.flatten(),
      },
    },
    400,
  );
}

// Project-wide error envelope. Every non-2xx response uses this shape so
// clients branch on `error.code`, not on the message text (which is for
// humans). Codes are deliberately coarse-grained; adding finer codes is
// fine, but never repurpose an existing one.
export const ErrorEnvelope = z
  .object({
    error: z.object({
      code: z.string().openapi({
        example: 'not_found',
        description:
          'Stable, machine-readable code. Clients branch on this; never on message.',
      }),
      message: z.string().openapi({ example: 'not found' }),
      details: z.unknown().optional(),
    }),
  })
  .openapi('ErrorEnvelope');

// Every route declares these alongside its success response. The handler
// never RETURNS one of these -- it THROWS an ApiError, and the top-level
// onError handler formats it. This keeps zod-openapi's typed-response
// inference happy (handlers always satisfy the success path) and gives one
// place where error formatting lives.
export const errorResponses = {
  400: {
    description: 'invalid request',
    content: { 'application/json': { schema: ErrorEnvelope } },
  },
  404: {
    description: 'not found / not a member',
    content: { 'application/json': { schema: ErrorEnvelope } },
  },
  500: {
    description: 'server error',
    content: { 'application/json': { schema: ErrorEnvelope } },
  },
} as const;

export type ErrorCode =
  | 'invalid_request'
  | 'unauthenticated'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  // idempotency-middleware codes (distinct from domain 409s like
  // send_state_unknown / invalid_correction_target because they demand the
  // OPPOSITE client behavior). idempotency_conflict: the same Idempotency-Key
  // was replayed with a DIFFERENT request body -- the client's key derivation
  // is wrong; do NOT blind-retry. idempotency_in_flight: the original request
  // for this key is still running -- retry shortly with the SAME key+body.
  | 'idempotency_conflict'
  | 'idempotency_in_flight'
  // correcting/retracting an interaction that is not the current head of
  // its chain (already superseded, or the chain is closed by a retraction)
  | 'invalid_correction_target'
  | 'database_error'
  | 'internal_error'
  // profile: a submitted phone number cannot be normalised to E.164
  | 'invalid_phone'
  // agent-principal firewall codes (Workstream D)
  | 'agent_forbidden'           // agent attempted a forbidden operation (correction/retraction)
  | 'agent_entry_type_forbidden' // agent attempted to append a communication directly
  | 'agent_only'                // landlord attempted an agent-only field or kind
  // messaging codes (Workstream E)
  | 'messaging_unconfigured'    // Twilio env vars absent; send endpoint returns 503
  | 'no_sms_destination'        // recipient has no usable E.164 phone number
  | 'sms_opted_out'             // recipient's phone is in sms_opt_outs
  | 'send_failed'               // provider definitively rejected the send (Twilio 4xx)
  | 'send_state_unknown';       // provider call timed out / 5xx; outbox stays 'sending'

export class ApiError extends Error {
  constructor(
    public readonly status: 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500 | 502 | 503,
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * Map a PostgREST/Postgres write error to an ApiError. Use on user-scoped
 * write paths where a blanket 500 would mask an authorization outcome: a row
 * RLS refuses surfaces as Postgres 42501 (insufficient_privilege) -- map it to
 * a clean 403 rather than 500. This is the ADR-0009 Phase 4 fix for the
 * narrow window where a just-revoked agent still passes the cached membership
 * middleware but the live RLS check denies the write. Unrecognised codes keep
 * the generic database_error 500.
 */
export function dbError(error: { code?: string; message: string }): ApiError {
  if (error.code === '42501') {
    return new ApiError(403, 'forbidden', 'not authorized to write this resource');
  }
  return new ApiError(500, 'database_error', error.message);
}
