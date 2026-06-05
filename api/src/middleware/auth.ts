import type { MiddlewareHandler } from 'hono';
import {
  createLocalJWKSet,
  createRemoteJWKSet,
  errors as joseErrors,
  jwtVerify,
  type JSONWebKeySet,
  type JWTPayload,
} from 'jose';
import { loadEnv } from '../env';

// Supabase access tokens are ES256-signed via the project's JWKS endpoint.
// The shape below is what Supabase issues today; extra claims pass through
// untyped so consumers can read them off `claims`.
export interface AuthClaims extends JWTPayload {
  sub: string;
  email?: string;
  role?: string;
}

export interface AuthContext {
  userId: string;
  claims: AuthClaims;
  // The raw token, forwarded by callers when they need to construct a
  // user-scoped Supabase client (RLS executes under the caller's identity).
  accessToken: string;
}

declare module 'hono' {
  interface ContextVariableMap {
    auth: AuthContext;
  }
}

type JwksGetter = ReturnType<typeof createRemoteJWKSet> | ReturnType<typeof createLocalJWKSet>;

let cachedJwks: JwksGetter | null = null;

function getJwks(): JwksGetter {
  if (cachedJwks) return cachedJwks;
  const env = loadEnv();
  if (env.SUPABASE_JWKS_JSON) {
    // Local override (tests, air-gapped) -- verify against an in-process
    // key set instead of fetching from the network.
    const parsed = JSON.parse(env.SUPABASE_JWKS_JSON) as JSONWebKeySet;
    cachedJwks = createLocalJWKSet(parsed);
  } else {
    // Production path. jose caches the JWKS in-memory and refetches on a
    // kid miss (rotation). cacheMaxAge keeps an upper bound on staleness.
    cachedJwks = createRemoteJWKSet(new URL(env.SUPABASE_JWKS_URL), {
      cacheMaxAge: 10 * 60 * 1000, // 10 min
      cooldownDuration: 30 * 1000, // 30 s between refetches on miss
    });
  }
  return cachedJwks;
}

// Test-only: clear the cached JWKS so a subsequent verify picks up new env.
export function _resetJwksCacheForTests(): void {
  cachedJwks = null;
}

function unauth(message: string): Response {
  return new Response(
    JSON.stringify({ error: { code: 'unauthenticated', message } }),
    { status: 401, headers: { 'content-type': 'application/json' } },
  );
}

export function requireAuth(): MiddlewareHandler {
  return async (c, next) => {
    const header = c.req.header('authorization') ?? '';
    if (!/^bearer\s+/i.test(header)) {
      return unauth('missing bearer token');
    }
    const token = header.replace(/^bearer\s+/i, '').trim();
    if (!token) return unauth('empty bearer token');

    const env = loadEnv();
    try {
      const { payload } = await jwtVerify(token, getJwks(), {
        issuer: env.SUPABASE_JWT_ISSUER,
        audience: env.SUPABASE_JWT_AUDIENCE,
        algorithms: ['ES256'],
      });
      if (!payload.sub || typeof payload.sub !== 'string') {
        return unauth('token missing sub claim');
      }
      c.set('auth', {
        userId: payload.sub,
        claims: payload as AuthClaims,
        accessToken: token,
      });
      return next();
    } catch (e) {
      // Bucket the common cases so a client gets a stable code without
      // exposing internal reasons (e.g., kid not found).
      if (e instanceof joseErrors.JWTExpired) return unauth('token expired');
      if (e instanceof joseErrors.JWTClaimValidationFailed) {
        return unauth('token claim invalid');
      }
      if (e instanceof joseErrors.JOSEError) return unauth('invalid token');
      return unauth('invalid token');
    }
  };
}
