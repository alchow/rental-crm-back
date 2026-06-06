import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { randomBytes, createHash } from 'node:crypto';
import { ApiError, errorResponses } from '../routes/_lib/error';
import { getAdminClient } from './supabase-admin';

// ============================================================================
// Tenant intake -- the single public, unauthenticated, RLS-bypassing route.
// ============================================================================
//
// Threat model (this is the highest-risk surface in the build, so the design
// is conservative):
//
//   * The URL is the secret. The DB stores ONLY sha256(secret); a DB read
//     can never recover a live link. The handler hashes incoming tokens
//     before lookup.
//
//   * Scope is derived STRICTLY from the verified token row:
//       account_id, property_id, tenancy_id <- intake_tokens
//     The submitter's body cannot override any of them. The area_id IS
//     submitter-supplied but is validated to belong to the TOKEN's property
//     (not just the account); a token scoped to property P never lands a
//     write in another property's area.
//
//   * The handler runs with the admin (service-role) client because there
//     is no authenticated user; RLS would otherwise refuse the write to
//     account_members-gated tables. The route lives in src/admin/ so the
//     ESLint quarantine still passes (the only place that imports
//     supabase-admin.ts).
//
//   * audit.actor is set on the connection BEFORE the write, so the audit
//     trigger captures actor='tenant:<token_id>'. This works because the
//     Phase 4 actor-integrity fix says: when auth.uid() is NULL (no JWT --
//     our case), audit.actor wins. When auth.uid() IS set (user-facing
//     path), audit.actor is IGNORED. Intake therefore can't impersonate a
//     real user, and a user can't impersonate an intake.
//
//   * Per-token AND per-IP rate limits (token via DB columns; IP via an
//     in-process sliding window). Both bound the spam blast-radius of a
//     leaked link.
//
//   * Tokens are reusable until revoked. Auto-revoke triggers when the
//     bound tenancy.status moves to 'ended' or the tenancy is soft-deleted.
//     A landlord can also revoke explicitly via the authenticated route.
//     Single-use was considered and rejected: a standing "report an issue"
//     link matches the frictionless-capture goal and the leaked-link blast
//     radius is just spam (covered by rate limits).

// ----- token helpers ---------------------------------------------------------

const TOKEN_BYTES = 32; // 256-bit secret -> 43-char base64url

function generateSecret(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}
function hashSecret(secret: string): Buffer {
  return createHash('sha256').update(secret, 'utf8').digest();
}

export interface MintedToken {
  /** Public token row id (safe to log / surface). */
  id: string;
  /** The plaintext secret -- shown to the landlord ONCE; never stored. */
  secret: string;
  account_id: string;
  property_id: string;
  tenancy_id: string;
  created_at: string;
}

/**
 * Mint a fresh intake token for a tenancy. SECURITY DEFINER-equivalent at the
 * application layer: uses the admin client (RLS-bypass) but BEFORE doing so
 * the caller (the authenticated route) is expected to have verified
 * account membership + immediate-parent (tenancy belongs to account). This
 * function trusts those checks and doesn't re-verify them.
 *
 * Returns the plaintext secret EXACTLY ONCE. The hash is what persists.
 * The unique-partial index on (tenancy_id where revoked_at is null) means a
 * second mint without revoke first will fail with a 23505; the caller must
 * map to a 409 "active token exists" so the operator knows to revoke first.
 */
export async function mintIntakeToken(
  accountId: string,
  tenancyId: string,
): Promise<MintedToken> {
  const admin = getAdminClient();

  // We need property_id for the token. Look it up off the tenancy -> area ->
  // property chain. The admin client bypasses RLS so this just reads the
  // canonical rows.
  const { data: t, error: tErr } = await admin
    .from('tenancies')
    .select('id, account_id, area_id, deleted_at, status, areas!inner(property_id)')
    .eq('account_id', accountId)
    .eq('id', tenancyId)
    .is('deleted_at', null)
    .maybeSingle();
  if (tErr) throw new ApiError(500, 'database_error', tErr.message);
  if (!t) throw new ApiError(404, 'not_found', 'tenancy not found in this account');
  // Refuse to mint for a tenancy that's already terminal.
  if (t.status === 'ended') {
    throw new ApiError(409, 'conflict', 'cannot mint intake token for an ended tenancy');
  }

  // The supabase-js join unwraps `areas!inner` to either a single object or
  // an array depending on the row count it inferred; narrow both shapes.
  const propertyId = Array.isArray(t.areas)
    ? (t.areas[0] as { property_id: string } | undefined)?.property_id
    : (t.areas as { property_id: string } | null)?.property_id;
  if (!propertyId) {
    throw new ApiError(500, 'database_error', 'tenancy area has no property');
  }

  const secret = generateSecret();
  const secretHash = hashSecret(secret);

  // The unique partial index will trip a 23505 if there's an active token
  // for this tenancy; we surface that as 409.
  const { data: row, error: insErr } = await admin
    .from('intake_tokens')
    .insert({
      account_id: accountId,
      property_id: propertyId,
      tenancy_id: tenancyId,
      secret_hash: '\\x' + secretHash.toString('hex'),
    })
    .select('id, account_id, property_id, tenancy_id, created_at')
    .single();
  if (insErr) {
    if (insErr.code === '23505') {
      throw new ApiError(409, 'conflict', 'an active intake token already exists for this tenancy; revoke it first');
    }
    throw new ApiError(500, 'database_error', insErr.message);
  }
  return {
    id: row!.id as string,
    secret,
    account_id: row!.account_id as string,
    property_id: row!.property_id as string,
    tenancy_id: row!.tenancy_id as string,
    created_at: row!.created_at as string,
  };
}

export async function revokeIntakeToken(
  accountId: string,
  tokenId: string,
): Promise<{ id: string; revoked_at: string }> {
  const admin = getAdminClient();
  const { data, error } = await admin
    .from('intake_tokens')
    .update({ revoked_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('account_id', accountId)
    .eq('id', tokenId)
    .is('revoked_at', null)
    .select('id, revoked_at')
    .maybeSingle();
  if (error) throw new ApiError(500, 'database_error', error.message);
  if (!data) throw new ApiError(404, 'not_found', 'intake token not found or already revoked');
  return { id: data.id as string, revoked_at: data.revoked_at as string };
}

// ----- per-IP sliding-window rate limit (in-memory) --------------------------

interface IpBucket {
  count: number;
  windowStart: number; // epoch ms
}
const ipBuckets = new Map<string, IpBucket>();
const IP_WINDOW_MS = 10 * 60 * 1000; // 10 min
const IP_LIMIT = 50;                  // 50 requests / IP / 10 min
const TOKEN_WINDOW_S = 10 * 60;       // matches per-token window
const TOKEN_LIMIT = 20;

/** Test-only: clears the per-IP buckets so retries don't leak across runs. */
export function _resetIntakeIpBucketsForTests(): void {
  ipBuckets.clear();
}

function checkIpLimit(ip: string): { ok: boolean; remaining: number } {
  const now = Date.now();
  const b = ipBuckets.get(ip);
  if (!b || now - b.windowStart > IP_WINDOW_MS) {
    ipBuckets.set(ip, { count: 1, windowStart: now });
    return { ok: true, remaining: IP_LIMIT - 1 };
  }
  b.count += 1;
  return { ok: b.count <= IP_LIMIT, remaining: Math.max(0, IP_LIMIT - b.count) };
}

// ----- public intake handler -------------------------------------------------

const IntakeBody = z
  .object({
    area_id: z.string().uuid(),
    title: z.string().min(1).max(200),
    description: z.string().max(5000).optional(),
    // Triage-actionable: emergency (drop everything), urgent (today),
    // routine (schedule). Carried through into maintenance_request.severity.
    severity: z.enum(['emergency', 'urgent', 'routine']),
    // Tenant-stated time-of-occurrence. logged_at is server-set on the
    // interaction row (and immutable per Phase 3.1).
    occurred_at: z.string().datetime().optional(),
  })
  .openapi('IntakeBody');

const IntakeResponse = z
  .object({
    maintenance_request_id: z.string().uuid(),
    interaction_id: z.string().uuid(),
    // true if an existing open request matched and this submission was
    // appended as an interaction rather than creating a new request. The
    // dedupe key is (area_id, title) on the OPEN requests for this tenancy.
    deduped_onto_existing: z.boolean(),
  })
  .openapi('IntakeResponse');

const intake = createRoute({
  method: 'post',
  path: '/intake/{token}',
  tags: ['intake'],
  summary: 'Submit a maintenance request via tenant magic link',
  request: {
    params: z.object({
      token: z.string().min(8).max(200).openapi({ param: { name: 'token', in: 'path' } }),
    }),
    body: { content: { 'application/json': { schema: IntakeBody } }, required: true },
  },
  responses: {
    201: { description: 'created', content: { 'application/json': { schema: IntakeResponse } } },
    ...errorResponses,
    429: {
      description: 'rate limited',
      content: { 'application/json': { schema: errorResponses[400].content['application/json'].schema } },
    },
  },
});

interface TokenRow {
  id: string;
  account_id: string;
  property_id: string;
  tenancy_id: string;
  revoked_at: string | null;
  last_used_at: string | null;
  use_count: number;
  use_window_start: string;
}

async function lookupAndRateLimitToken(secret: string): Promise<TokenRow> {
  const admin = getAdminClient();
  const hash = hashSecret(secret);
  const { data, error } = await admin
    .from('intake_tokens')
    .select('id, account_id, property_id, tenancy_id, revoked_at, last_used_at, use_count, use_window_start')
    .eq('secret_hash', '\\x' + hash.toString('hex'))
    .maybeSingle();
  if (error) throw new ApiError(500, 'database_error', error.message);
  // Don't distinguish "not found" from "revoked" -- 404 either way.
  if (!data) throw new ApiError(404, 'not_found', 'invalid token');
  if (data.revoked_at) throw new ApiError(404, 'not_found', 'invalid token');

  // Also verify the bound tenancy is still in a state that can receive intake.
  const { data: t, error: tErr } = await admin
    .from('tenancies')
    .select('status, deleted_at')
    .eq('account_id', data.account_id)
    .eq('id', data.tenancy_id)
    .maybeSingle();
  if (tErr) throw new ApiError(500, 'database_error', tErr.message);
  if (!t || t.deleted_at !== null || t.status === 'ended') {
    throw new ApiError(404, 'not_found', 'invalid token');
  }

  // Per-token rate limit: sliding window via (use_window_start, use_count).
  const nowMs = Date.now();
  const windowStartMs = new Date(data.use_window_start as string).getTime();
  let nextCount = data.use_count + 1;
  let nextWindowStart = data.use_window_start as string;
  if (nowMs - windowStartMs > TOKEN_WINDOW_S * 1000) {
    nextCount = 1;
    nextWindowStart = new Date(nowMs).toISOString();
  }
  if (nextCount > TOKEN_LIMIT) {
    throw new ApiError(429, 'conflict', 'rate limit exceeded for this token; try again later');
  }
  await admin
    .from('intake_tokens')
    .update({
      last_used_at: new Date(nowMs).toISOString(),
      use_count: nextCount,
      use_window_start: nextWindowStart,
      updated_at: new Date(nowMs).toISOString(),
    })
    .eq('id', data.id);

  return data as TokenRow;
}

// ----- intake app ------------------------------------------------------------

export const intakeApp = new OpenAPIHono();

intakeApp.openapi(intake, async (c) => {
  // Per-IP limit. With multiple proxies we'd take the leftmost forwarded
  // address; for now the connection peer is fine.
  const ip =
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ??
    c.req.header('cf-connecting-ip') ??
    'unknown';
  const ipCheck = checkIpLimit(ip);
  if (!ipCheck.ok) {
    throw new ApiError(429, 'conflict', 'rate limit exceeded for this IP; try again later');
  }

  const { token } = c.req.valid('param');
  const body = c.req.valid('json');

  // 1. Token verification + per-token rate limit. Returns the scope.
  const tokenRow = await lookupAndRateLimitToken(token);

  // 2. Validate area belongs to the TOKEN's property (not just the account).
  // The admin client bypasses RLS but we still scope by property_id derived
  // from the verified token row.
  const admin = getAdminClient();
  const { data: area, error: aErr } = await admin
    .from('areas')
    .select('id, kind, property_id, account_id')
    .eq('account_id', tokenRow.account_id)
    .eq('property_id', tokenRow.property_id)
    .eq('id', body.area_id)
    .is('deleted_at', null)
    .maybeSingle();
  if (aErr) throw new ApiError(500, 'database_error', aErr.message);
  if (!area) {
    // Don't confirm whether the area exists in another property within the
    // same account; 404 either way.
    throw new ApiError(404, 'not_found', 'area not found in this property');
  }

  // 3. Audit actor. The audit trigger reads current_setting('audit.actor');
  // setting it BEFORE the writes is what makes the chain entries land as
  // actor='tenant:<token_id>'. We use the public token id (a uuid), not
  // the secret.
  // Set as session-local for the duration of this request's DB work. We
  // wrap subsequent writes in a single supabase-js call so the GUC stays
  // in scope... actually supabase-js calls are stateless HTTP, so each
  // call is a fresh connection. We need to call a Postgres function that
  // sets the GUC AND does the writes atomically. Use an RPC.
  //
  // Define an admin RPC: submit_intake(account_id, tenancy_id, area_id,
  //   title, description, severity, occurred_at, actor_token_id) returns
  //   (maintenance_request_id, interaction_id, deduped). The function sets
  //   audit.actor inside, does the dedup logic and inserts, and returns.

  const { data: rpcData, error: rpcErr } = await admin.rpc('submit_intake', {
    p_account_id:   tokenRow.account_id,
    p_tenancy_id:   tokenRow.tenancy_id,
    p_area_id:      area.id,
    p_title:        body.title,
    p_description:  body.description ?? null,
    p_severity:     body.severity,
    p_occurred_at:  body.occurred_at ?? new Date().toISOString(),
    p_actor:        `tenant:${tokenRow.id}`,
  });
  if (rpcErr) {
    throw new ApiError(500, 'database_error', rpcErr.message);
  }
  const row = (Array.isArray(rpcData) ? rpcData[0] : rpcData) as
    | { maintenance_request_id: string; interaction_id: string; deduped: boolean }
    | null;
  if (!row) throw new ApiError(500, 'database_error', 'intake RPC returned no row');

  return c.json(
    {
      maintenance_request_id: row.maintenance_request_id,
      interaction_id: row.interaction_id,
      deduped_onto_existing: row.deduped,
    },
    201,
  );
});
