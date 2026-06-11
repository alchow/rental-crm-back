import type { MiddlewareHandler } from 'hono';
import { getLogger } from '../log';

// One structured summary line per request: method, matched route pattern,
// status, duration, and -- when the auth/membership middleware has run --
// the user and account. Combined with the request-id (hono/request-id,
// mounted just before this), a production incident is traceable end-to-end
// from a single grep.
//
// /healthz is logged at debug: Render polls it every few seconds and an
// info-level line per poll would drown the signal.

declare module 'hono' {
  interface ContextVariableMap {
    requestId: string;
  }
}

export function requestLog(): MiddlewareHandler {
  return async (c, next) => {
    const start = performance.now();
    try {
      await next();
    } finally {
      const requestId = c.get('requestId');
      c.res.headers.set('x-request-id', requestId ?? '');
      const log = getLogger();
      const level = c.req.path === '/healthz' ? 'debug' : 'info';
      log[level](
        {
          requestId,
          method: c.req.method,
          // routePath is the matched pattern (low-cardinality, aggregatable);
          // fall back to the raw path when no route matched (404s).
          path: c.req.routePath || c.req.path,
          status: c.res.status,
          ms: Math.round(performance.now() - start),
          userId: c.get('auth')?.userId,
          accountId: c.get('account')?.accountId,
        },
        'request',
      );
    }
  };
}
