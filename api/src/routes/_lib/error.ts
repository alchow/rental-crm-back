import { z } from '@hono/zod-openapi';

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
  | 'database_error'
  | 'internal_error';

export class ApiError extends Error {
  constructor(
    public readonly status: 400 | 401 | 403 | 404 | 409 | 500,
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}
