import { z } from 'zod';

// Access tokens are verified via Supabase's asymmetric signing keys (ES256)
// served at the project's JWKS endpoint — not the HS256 shared secret. The
// JWKS URL, issuer, and audience are derived from SUPABASE_URL by default,
// but may be overridden explicitly (e.g. for self-hosted deployments or
// test fixtures). See api/src/middleware/auth.ts (added in phase 4).

const RawEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(8787),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  // Positive-hit TTL for the account-membership middleware cache (ms).
  // 0 disables. Safe because RLS is the actual guard: a stale entry cannot
  // read or write anything the DB refuses -- staleness only delays the
  // 404-on-revocation convenience by at most this long.
  MEMBERSHIP_CACHE_TTL_MS: z.coerce.number().int().min(0).default(45_000),

  SUPABASE_URL: z.string().url(),
  SUPABASE_ANON_KEY: z.string().min(20),
  // The privileged service-role env var is intentionally NOT declared here.
  // It lives in api/src/admin/ so non-admin code can't read it.

  SUPABASE_JWKS_URL: z.string().url().optional(),
  // Optional override: a literal JWKS JSON. When set, the auth middleware
  // verifies tokens against THIS key set instead of fetching SUPABASE_JWKS_URL.
  // Used in test environments where we mint our own ES256 keys; also useful
  // for air-gapped deployments. In prod, leave unset and let the URL fetch.
  SUPABASE_JWKS_JSON: z.string().min(1).optional(),
  SUPABASE_JWT_ISSUER: z.string().url().optional(),
  SUPABASE_JWT_AUDIENCE: z.string().min(1).default('authenticated'),

  // Anthropic API key for the onboarding-import recognition/mapping LLM
  // (api/src/admin/import-llm.ts). The LLM only ever proposes; the
  // deterministic executor writes. Privacy: only column names + <=5 sample
  // values per column are ever sent -- never full row data.
  //
  // Optional in the schema so the app still boots (and the spec still emits,
  // and every non-import test still runs) without it; import-llm.ts asserts
  // its presence at call time and 502s cleanly if it's unset.
  ANTHROPIC_API_KEY: z.string().min(20).optional(),

  // Resend transactional-email credentials (api/src/admin/mailer.ts). Both are
  // optional so the app still boots without them: getMailer() falls back to a
  // stub that logs sends instead of delivering. Set BOTH to enable real
  // delivery. MAIL_FROM accepts a bare address or the named-sender form
  // ("Acme <noreply@acme.com>"), so it is a plain string, not .email().
  RESEND_API_KEY: z.string().min(1).optional(),
  MAIL_FROM: z.string().min(1).optional(),

  // HMAC secret for the public email-unsubscribe endpoint. SHARED with the
  // transport repo, which mints per-address unsubscribe URLs statelessly (it
  // holds the same secret). Unset -> the public unsubscribe endpoint 503s (and
  // the transport must NOT emit List-Unsubscribe headers).
  UNSUBSCRIBE_HMAC_SECRET: z.string().min(32).optional(),

  // Cutover flag for core-originated transactional email. ON ('on' | 'true')
  // -> the inspection-capture renewal email is written to the comms outbox (the
  // transport dials the provider); OFF/unset -> the legacy in-core mailer
  // (admin/mailer.ts) sends directly. The mailer is deleted only after the
  // coordinator signals cutover-verified.
  COMMS_EMAIL_PIPELINE: z.string().optional(),

  // Extra browser origins allowed to call the API via CORS, beyond the
  // built-in Lovable defaults (see middleware/cors.ts). Comma-separated;
  // each entry is either an exact origin (https://app.example.com) or a
  // wildcard subdomain pattern (*.example.com).
  CORS_ALLOWED_ORIGINS: z.string().optional(),
});

export interface Env {
  NODE_ENV: 'development' | 'test' | 'production';
  PORT: number;
  LOG_LEVEL: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';
  MEMBERSHIP_CACHE_TTL_MS: number;
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
  SUPABASE_JWKS_URL: string;
  SUPABASE_JWKS_JSON: string | null;
  SUPABASE_JWT_ISSUER: string;
  SUPABASE_JWT_AUDIENCE: string;
  CORS_ALLOWED_ORIGINS: string[];
  ANTHROPIC_API_KEY: string | null;
  RESEND_API_KEY: string | null;
  MAIL_FROM: string | null;
  UNSUBSCRIBE_HMAC_SECRET: string | null;
  COMMS_EMAIL_PIPELINE: boolean;
}

let cached: Env | null = null;

export function loadEnv(): Env {
  if (cached) return cached;
  const parsed = RawEnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  const raw = parsed.data;
  const supabaseOrigin = raw.SUPABASE_URL.replace(/\/+$/, '');
  cached = {
    NODE_ENV: raw.NODE_ENV,
    PORT: raw.PORT,
    LOG_LEVEL: raw.LOG_LEVEL,
    MEMBERSHIP_CACHE_TTL_MS: raw.MEMBERSHIP_CACHE_TTL_MS,
    SUPABASE_URL: raw.SUPABASE_URL,
    SUPABASE_ANON_KEY: raw.SUPABASE_ANON_KEY,
    SUPABASE_JWKS_URL: raw.SUPABASE_JWKS_URL ?? `${supabaseOrigin}/auth/v1/.well-known/jwks.json`,
    SUPABASE_JWKS_JSON: raw.SUPABASE_JWKS_JSON ?? null,
    SUPABASE_JWT_ISSUER: raw.SUPABASE_JWT_ISSUER ?? `${supabaseOrigin}/auth/v1`,
    SUPABASE_JWT_AUDIENCE: raw.SUPABASE_JWT_AUDIENCE,
    CORS_ALLOWED_ORIGINS: raw.CORS_ALLOWED_ORIGINS
      ? raw.CORS_ALLOWED_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean)
      : [],
    ANTHROPIC_API_KEY: raw.ANTHROPIC_API_KEY ?? null,
    RESEND_API_KEY: raw.RESEND_API_KEY ?? null,
    MAIL_FROM: raw.MAIL_FROM ?? null,
    UNSUBSCRIBE_HMAC_SECRET: raw.UNSUBSCRIBE_HMAC_SECRET ?? null,
    COMMS_EMAIL_PIPELINE: raw.COMMS_EMAIL_PIPELINE === 'on' || raw.COMMS_EMAIL_PIPELINE === 'true',
  };
  return cached;
}

// Test-only: clear the cached env so a subsequent loadEnv() picks up
// process.env changes the test made. Production code should never call this.
export function _resetEnvCacheForTests(): void {
  cached = null;
}
