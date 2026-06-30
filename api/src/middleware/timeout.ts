import type { MiddlewareHandler } from 'hono';
import { ApiError } from '../routes/_lib/error';

// Bound total in-app request time. On expiry we THROW an ApiError(503) so the
// single onError formatter (app.ts) envelopes it -- hono/timeout's built-in
// HTTPException(504) would bypass that branch and surface as a generic 500.
//
// The budget is set BELOW Render's ~30s edge timeout so the APP shapes a slow
// request into a typed, retryable response (503 service_unavailable + Retry-
// After) instead of the edge synthesising a bodyless 503 that breaks the
// "branch on error.code" client contract.
//
// Caveats:
//   * This does NOT abort the orphaned handler -- JS has no cancellation here.
//     It keeps running in the background; the client just gets a deterministic
//     response now. Any idempotency key left in-flight is reclaimed within the
//     claim RPC's staleness window (~90s), so a same-key retry recovers.
//   * The race settles when the handler RETURNS its Response. For binary
//     downloads that means "bytes buffered from storage", NOT client transfer
//     time -- a slow mobile download is flushed after next() resolves and is
//     never bounded by this timer.
export function requestTimeout(ms: number): MiddlewareHandler {
  return async (_c, next) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tripwire = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new ApiError(503, 'service_unavailable', 'request exceeded server time budget'),
          ),
        ms,
      );
    });
    try {
      await Promise.race([next(), tripwire]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };
}
