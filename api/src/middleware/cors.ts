import { cors } from 'hono/cors';
import type { MiddlewareHandler } from 'hono';
import { loadEnv } from '../env';

// Lovable (the project's frontend builder) serves every preview and
// published build from a per-project subdomain of one of these two
// domains. The subdomain is an opaque project id that changes per project
// and on republish, so an exact-origin allowlist can't track it -- match
// the suffix instead. Extra origins (custom domains, local dev, etc.) come
// from CORS_ALLOWED_ORIGINS.
const DEFAULT_ORIGIN_PATTERNS = ['*.lovableproject.com', '*.lovable.app'];

function originMatches(origin: string, pattern: string): boolean {
  if (pattern.startsWith('*.')) {
    const suffix = pattern.slice(1); // ".lovableproject.com"
    return origin.length > suffix.length && origin.endsWith(suffix);
  }
  return origin === pattern;
}

export function corsMiddleware(): MiddlewareHandler {
  const env = loadEnv();
  const patterns = [...DEFAULT_ORIGIN_PATTERNS, ...env.CORS_ALLOWED_ORIGINS];
  return cors({
    origin: (origin) => (patterns.some((pattern) => originMatches(origin, pattern)) ? origin : null),
    allowMethods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    // Authorization carries the Supabase access token; Idempotency-Key is
    // required on mutating account-scoped endpoints (see idempotency.ts).
    allowHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key'],
  });
}
