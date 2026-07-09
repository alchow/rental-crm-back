import type { Context } from 'hono';
import type { AppSupabaseClient } from './db-types';
import { getUserClient } from './user-client';

declare module 'hono' {
  interface ContextVariableMap {
    sb: AppSupabaseClient;
  }
}

// Per-REQUEST memoization of the user-scoped client. The middleware stack
// (membership, idempotency, immediate-parent) and the handler each need the
// caller's client; constructing it once per request instead of 2-4 times
// saves the repeated createClient() setup without ever sharing a client
// across requests (the token differs per call -- see user-client.ts).
export function getSb(c: Context): AppSupabaseClient {
  const cached = c.get('sb') as AppSupabaseClient | undefined;
  if (cached) return cached;
  const sb = getUserClient(c.get('auth').accessToken);
  c.set('sb', sb);
  return sb;
}
