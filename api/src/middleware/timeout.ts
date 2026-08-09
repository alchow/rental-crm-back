import type { MiddlewareHandler } from 'hono';
import { ApiError } from '../routes/_lib/error';

// Keep the app deadline below the edge deadline so slow requests receive the
// typed, retryable 503 envelope. Expiry does not cancel handler work; stale
// idempotency claims are reclaimable. The timer ends when a Response is ready,
// so it bounds download buffering but not transfer to a slow client.
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
