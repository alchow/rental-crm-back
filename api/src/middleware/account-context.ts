import type { MiddlewareHandler } from 'hono';
import { getSb } from '../supabase/request-client';
import { loadEnv } from '../env';
import { createLruTtlCache } from './lru-ttl-cache';

// Active-account guard. SECURITY: Derive accountId only from the path and query
// membership with the caller JWT so RLS remains the authorization floor. Never
// use a service-role client with client-supplied scope. Membership misses return
// 404 to avoid confirming account existence.

export interface AccountContext {
  accountId: string;
  role: string;
}

declare module 'hono' {
  interface ContextVariableMap {
    account: AccountContext;
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function notFound(): Response {
  return new Response(
    JSON.stringify({ error: { code: 'not_found', message: 'not found' } }),
    { status: 404, headers: { 'content-type': 'application/json' } },
  );
}

// Cache positive membership only; RLS still enforces current row access.
// Bounded LRU eviction avoids clearing every account when the cache fills.
const MEMBERSHIP_CACHE_MAX = 10_000;
const membershipCache = createLruTtlCache<{ role: string }>(MEMBERSHIP_CACHE_MAX);

export function _clearMembershipCacheForTests(): void {
  membershipCache.clear();
}

export function requireAccountMembership(): MiddlewareHandler {
  return async (c, next) => {
    const accountId = c.req.param('accountId');
    if (!accountId || !UUID_RE.test(accountId)) {
      // Use the same 404 for malformed, absent, and inaccessible accounts.
      return notFound();
    }

    const ttl = loadEnv().MEMBERSHIP_CACHE_TTL_MS;
    const cacheKey = `${c.get('auth').userId}:${accountId}`;
    if (ttl > 0) {
      const hit = membershipCache.get(cacheKey);
      if (hit) {
        c.set('account', { accountId, role: hit.role });
        return next();
      }
    }

    const sb = getSb(c);
    const { data, error } = await sb
      .from('account_members')
      .select('role')
      .eq('account_id', accountId)
      .is('deleted_at', null)
      .maybeSingle();

    if (error) {
      return c.json(
        { error: { code: 'database_error', message: error.message } },
        500,
      );
    }
    if (!data) {
      return notFound();
    }

    if (ttl > 0) {
      membershipCache.set(cacheKey, { role: data.role }, ttl);
    }
    c.set('account', { accountId, role: data.role });
    return next();
  };
}
