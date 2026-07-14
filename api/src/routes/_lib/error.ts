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
        description: 'Stable, machine-readable code. Clients branch on this; never on message.',
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

// Spread alongside errorResponses on routes that emit domain 409s, so the
// conflict shows up in the contract instead of being a runtime surprise. The
// description names the fine-grained codes a route can return; keep each
// route's own description specific about which apply.
export const conflictResponse = {
  409: {
    description: 'conflict — error.code carries a fine-grained reason (see the route description)',
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
  // invalid_correction_target because they demand the OPPOSITE client
  // behavior). idempotency_conflict: the same Idempotency-Key
  // was replayed with a DIFFERENT request body -- the client's key derivation
  // is wrong; do NOT blind-retry. idempotency_in_flight: the original request
  // for this key is still running -- retry shortly with the SAME key+body.
  | 'idempotency_conflict'
  | 'idempotency_in_flight'
  // Atomic inspection setup used an older template schema hash. Refresh and
  // review the Create-screen scratchpad before submitting it again.
  | 'template_changed'
  // correcting/retracting an interaction that is not the current head of
  // its chain (already superseded, or the chain is closed by a retraction)
  | 'invalid_correction_target'
  | 'database_error'
  | 'internal_error'
  // transient dependency failure (DB connection refused/starting, upstream
  // unreachable, network timeout). Distinct from database_error/internal_error
  // because it is RETRYABLE: the client should back off and retry (honouring
  // Retry-After). Always paired with HTTP 503.
  | 'service_unavailable'
  // profile: a submitted phone number cannot be normalised to E.164
  | 'invalid_phone'
  // agent-principal firewall codes (Workstream D)
  | 'agent_forbidden' // agent attempted a forbidden operation (correction/retraction)
  | 'agent_entry_type_forbidden' // agent attempted a communication append without provenance
  | 'agent_only' // landlord attempted an agent-only field or kind
  // contract-first stub: the route is defined (and its schemas are final)
  // but the handler has not shipped yet. Clients should treat this as
  // "come back after the next deploy", never as a permanent failure.
  | 'not_implemented'
  // comms: the destination address is on the opt-out register; the send was
  // refused BEFORE any intent was recorded (nothing happened, no journal
  // trace). Not retryable until the counterparty opts back in.
  | 'opted_out'
  // ADR-0012 rent-change conflicts. Fine-grained (invalid_correction_target
  // precedent) so clients can build recovery UX per cause instead of echoing
  // message text: each code implies a distinct next action.
  | 'tenancy_ended' // rent change on an ended tenancy: nothing to do
  | 'notice_not_served' // anchor notice has no served_at: serve it first
  | 'instrument_not_current' // anchor lease is expired/superseded: pick/create a current one
  | 'schedule_conflict' // a same-kind schedule starts on/after effective_date:
  // delete it (never-billed) or change on a later date
  | 'lease_superseded' // transition out of status=superseded: create a new lease instead
  | 'instrument_anchored' // patch/delete of a lease/notice anchoring a live schedule
  | 'schedule_has_charges' // DELETE of a schedule with non-voided charges: void them first
  | 'property_requires_area' // property scope has zero/multiple live units: caller must choose area_id
  | 'tenancy_already_ended' // POST /tenancies/{id}/end was already applied: do not retry
  | 'tenancy_has_money'; // PATCH start_date once non-voided charges/payments exist:
// the money rows anchor the timeline — void them first
// (ADR-0012 recipes) or leave start_date alone

export class ApiError extends Error {
  constructor(
    public readonly status: 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500 | 501 | 502 | 503,
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

// Transient-failure signatures. A request that hits one of these did not fail
// on its own merits -- a dependency was momentarily unavailable -- so the
// correct contract is a retryable 503, not a 500. Postgres SQLSTATEs:
//   08*    connection_exception family
//   57P03  cannot_connect_now (server still starting -- the cold-start case)
//   53300  too_many_connections   53400  configuration_limit_exceeded
const TRANSIENT_PG_CODES = new Set([
  '08000',
  '08003',
  '08006',
  '08001',
  '08004',
  '08007',
  '08P01',
  '57P03',
  '53300',
  '53400',
]);
// Node/undici socket + DNS errors. undici nests the real code under .cause, so
// classifyTransient() inspects both the error and its cause.
const TRANSIENT_NET_CODES = new Set([
  'ENOTFOUND',
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_HEADERS_TIMEOUT',
]);

/**
 * Classify an error as a transient dependency failure -> retryable 503, or
 * null if it is not transient (the caller then keeps its own mapping). Checks
 * `.code` on the error and on `.cause` (undici wraps the socket error there).
 * Used by dbError() and by app.ts onError for raw throws that bubble unwrapped.
 */
export function classifyTransient(e: unknown): ApiError | null {
  const codeOf = (v: unknown): string | undefined =>
    v && typeof v === 'object' && typeof (v as { code?: unknown }).code === 'string'
      ? (v as { code: string }).code
      : undefined;
  const codes = [
    codeOf(e),
    codeOf(e && typeof e === 'object' ? (e as { cause?: unknown }).cause : undefined),
  ];
  for (const c of codes) {
    if (c && (TRANSIENT_PG_CODES.has(c) || TRANSIENT_NET_CODES.has(c))) {
      return new ApiError(503, 'service_unavailable', 'a dependency is temporarily unavailable');
    }
  }
  return null;
}

/**
 * Map a PostgREST/Postgres write error to an ApiError. Use on user-scoped
 * write paths where a blanket 500 would mask an authorization outcome: a row
 * RLS refuses surfaces as Postgres 42501 (insufficient_privilege) -- map it to
 * a clean 403 rather than 500. This is the ADR-0009 Phase 4 fix for the
 * narrow window where a just-revoked agent still passes the cached membership
 * middleware but the live RLS check denies the write. A transient dependency
 * blip surfaces as a retryable 503. Unrecognised codes keep the generic
 * database_error 500.
 */
export function dbError(error: { code?: string; message: string }): ApiError {
  const transient = classifyTransient(error);
  if (transient) return transient;
  if (error.code === '42501') {
    return new ApiError(403, 'forbidden', 'not authorized to write this resource');
  }
  return new ApiError(500, 'database_error', error.message);
}
