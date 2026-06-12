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
  // correcting/retracting an interaction that is not the current head of
  // its chain (already superseded, or the chain is closed by a retraction)
  | 'invalid_correction_target'
  | 'database_error'
  | 'internal_error'
  // agent-principal firewall codes (Workstream D)
  | 'agent_forbidden'           // agent attempted a forbidden operation (correction/retraction)
  | 'agent_entry_type_forbidden' // agent attempted to append a communication directly
  | 'agent_only';               // landlord attempted an agent-only field or kind

export class ApiError extends Error {
  constructor(
    public readonly status: 400 | 401 | 403 | 404 | 409 | 429 | 500 | 502,
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}
