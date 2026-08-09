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

// Positive-hit TTL cache: saves one PostgREST round trip on
// every account-scoped request. SAFE BY CONSTRUCTION: RLS is the actual
// guard -- a stale entry cannot read or write anything the DB refuses, it
// only delays the 404-on-revocation convenience by at most the TTL.
// Negative results are NEVER cached (a just-added member must not be locked
// out for the TTL). Bounded LRU eviction: on overflow the single oldest
// (least-recently-used) entry is evicted — never the entire cache — so
// multi-tenant agent fan-out cannot cause a thundering-herd cliff where one
// overflow forces every concurrent request back to a PostgREST round trip.
const MEMBERSHIP_CACHE_MAX = 10_000;
const membershipCache = createLruTtlCache<{ role: string }>(MEMBERSHIP_CACHE_MAX);

export function _clearMembershipCacheForTests(): void {
  membershipCache.clear();
}

export function requireAccountMembership(): MiddlewareHandler {
  return async (c, next) => {
    const accountId = c.req.param('accountId');
    if (!accountId || !UUID_RE.test(accountId)) {
      // Don't even hit the DB for garbage input. The 404 is intentional:
      // an attacker probing for account ids gets no information about
      // whether ids in the right shape exist.
      return notFound();
    }

    const ttl = loadEnv().MEMBERSHIP_CACHE_TTL_MS;
    const cacheKey = `${c.get('auth').userId}:${accountId}`;
    if (ttl > 0) {
      const hit = membershipCache.get(cacheKey);
      if (hit) {
        // Cache enforces TTL internally; no manual expiresAt check needed.
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
      // RLS returned zero rows -- the caller is not a member of this
      // account (or the account doesn't exist; we don't distinguish).
      return notFound();
    }

    if (ttl > 0) {
      membershipCache.set(cacheKey, { role: data.role }, ttl);
    }
    c.set('account', { accountId, role: data.role });
    return next();
  };
}
