import { createRoute, z } from '@hono/zod-openapi';
import { newApiApp } from '../routes/_lib/app';
import { randomBytes, createHash } from 'node:crypto';
import { ApiError, errorResponses } from '../routes/_lib/error';
import { nullableRpcArg } from '../supabase/db-types';
import { getAdminClient } from './supabase-admin';
import { processAndStoreBytes, ALLOWED_MIME_TYPES, MAX_BYTES } from './storage';

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
//   * audit.actor is set inside the RPC BEFORE the writes, so the audit
//     trigger captures actor='tenant:<token_id>'. This works because the
//     Phase 4 actor-integrity fix says: when auth.uid() is NULL (no JWT --
//     our case), audit.actor wins. When auth.uid() IS set (user-facing
//     path), audit.actor is IGNORED. Intake therefore can't impersonate a
//     real user, and a user can't impersonate an intake.
//
//   * Phase 9: the attachment INSERT is folded into the RPC, so a single
//     transaction lands maintenance_request + interaction + attachment
//     (+ optional HEIC-derived JPEG). Three failure modes are eliminated
//     by construction: "request without its photo", "photo without its
//     request", and "photo audited as 'system' instead of the tenant".
//
//   * Phase 9: per-IP rate limit moved to the DB (bump_ip_rate_bucket).
//     The Phase 7 in-memory bucket reset on every restart and was useless
//     across instances; the DB sliding window survives both.
//
//   * Tokens are reusable until revoked. Auto-revoke triggers when the
//     bound tenancy.status moves to 'ended' or the tenancy is soft-deleted.
//     A landlord can also revoke explicitly via the authenticated route.

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

export async function mintIntakeToken(accountId: string, tenancyId: string): Promise<MintedToken> {
  const admin = getAdminClient();
  const { data: t, error: tErr } = await admin
    .from('tenancies')
    .select('id, account_id, area_id, deleted_at, status, areas!inner(property_id)')
    .eq('account_id', accountId)
    .eq('id', tenancyId)
    .is('deleted_at', null)
    .maybeSingle();
  if (tErr) throw new ApiError(500, 'database_error', tErr.message);
  if (!t) throw new ApiError(404, 'not_found', 'tenancy not found in this account');
  if (t.status === 'ended') {
    throw new ApiError(409, 'conflict', 'cannot mint intake token for an ended tenancy');
  }
  const propertyId = Array.isArray(t.areas)
    ? (t.areas[0] as { property_id: string } | undefined)?.property_id
    : (t.areas as { property_id: string } | null)?.property_id;
  if (!propertyId) {
    throw new ApiError(500, 'database_error', 'tenancy area has no property');
  }

  const secret = generateSecret();
  const secretHash = hashSecret(secret);
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
      throw new ApiError(
        409,
        'conflict',
        'an active intake token already exists for this tenancy; revoke it first',
      );
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

// ----- per-IP rate limit (DB sliding window) --------------------------------

const TOKEN_WINDOW_S = 10 * 60;
const TOKEN_LIMIT = 20;
const IP_WINDOW_S = 10 * 60;
const IP_LIMIT = 50;

async function bumpIpRateBucket(ip: string): Promise<{ ok: boolean }> {
  const admin = getAdminClient();
  const { data, error } = await admin.rpc('bump_ip_rate_bucket', {
    p_ip: ip.slice(0, 64),
    p_scope: 'intake',
    p_window_sec: IP_WINDOW_S,
  });
  if (error) {
    // Fail closed: if rate-limit infra is down we drop the request rather
    // than leaving it un-bounded. A leaked link with a misconfigured DB is
    // strictly worse than a temporary 429.
    return { ok: false };
  }
  const count = typeof data === 'number' ? data : Number(data);
  return { ok: count <= IP_LIMIT };
}

/** Test-only: clears the per-IP DB buckets so tests don't leak across runs. */
export async function _resetIntakeIpBucketsForTests(): Promise<void> {
  const admin = getAdminClient();
  await admin.from('ip_rate_buckets').delete().eq('scope', 'intake');
}

// ----- public intake handler -------------------------------------------------

const IntakeBody = z
  .object({
    // Optional since the C2 usability fix: the token already binds one
    // tenancy, and a tenancy is one unit-kind area, so the submitter's own
    // unit is the honest default. A tenant on a public magic link has no way
    // to discover area UUIDs anyway. When provided, it is still validated
    // against the TOKEN's property below.
    area_id: z.string().uuid().optional().openapi({
      description:
        "Optional; defaults to the tenancy's unit. If provided, must belong to the token's property.",
    }),
    title: z.string().min(1).max(200),
    description: z.string().max(5000).optional(),
    severity: z.enum(['emergency', 'urgent', 'routine']),
    occurred_at: z.string().datetime().optional(),
  })
  .openapi('IntakeBody');

// Documentation-only variant for the multipart leg (adds the file part).
// Registered in the OpenAPI components but never used as a validator.
const IntakeMultipartBody = IntakeBody.extend({
  file: z.any().openapi({
    type: 'string',
    format: 'binary',
    description: 'Optional photo (JPEG/PNG/WebP/HEIC; HEIC gets a server-derived JPEG).',
  }),
}).openapi('IntakeMultipartBody');

const IntakeResponse = z
  .object({
    maintenance_request_id: z.string().uuid(),
    interaction_id: z.string().uuid(),
    // Phase 9: when the submitter included a file, attachment_id is the
    // INSERTed attachments row. For HEIC uploads, derivative_id is the
    // server-derived JPEG row whose derived_from = attachment_id.
    attachment_id: z.string().uuid().nullable(),
    derivative_id: z.string().uuid().nullable(),
    deduped_onto_existing: z.boolean(),
  })
  .openapi('IntakeResponse');

// The request body is described in the spec via raw $ref schema objects
// (registered on the registry below) rather than Zod schemas: zod-openapi
// auto-registers a validator only for `schema instanceof ZodType`, and with
// two declared content-types (JSON for text-only intake, multipart for
// intake + photo) an auto-validator would reject whichever shape it wasn't
// bound to. Raw $refs keep the spec honest for generated clients while the
// handler keeps its manual dual-content-type parsing, validated by
// IntakeBody directly.
const intake = createRoute({
  method: 'post',
  path: '/intake/{token}',
  tags: ['intake'],
  summary: 'Submit a maintenance request via tenant magic link',
  request: {
    params: z.object({
      token: z
        .string()
        .min(8)
        .max(200)
        .openapi({ param: { name: 'token', in: 'path' } }),
    }),
    body: {
      required: true,
      description:
        'application/json for text-only intake; multipart/form-data when attaching a photo.',
      content: {
        'application/json': {
          schema: { $ref: '#/components/schemas/IntakeBody' } as never,
        },
        'multipart/form-data': {
          schema: { $ref: '#/components/schemas/IntakeMultipartBody' } as never,
        },
      },
    },
  },
  responses: {
    201: { description: 'created', content: { 'application/json': { schema: IntakeResponse } } },
    ...errorResponses,
    429: {
      description: 'rate limited',
      content: {
        'application/json': { schema: errorResponses[400].content['application/json'].schema },
      },
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
  submission_count: number;
}

interface VerifiedToken {
  token: TokenRow;
  /** The token tenancy's own unit area — the default intake location. */
  tenancyAreaId: string;
}

async function lookupAndRateLimitToken(secret: string): Promise<VerifiedToken> {
  const admin = getAdminClient();
  const hash = hashSecret(secret);
  const { data, error } = await admin
    .from('intake_tokens')
    .select(
      'id, account_id, property_id, tenancy_id, revoked_at, last_used_at, use_count, use_window_start, submission_count',
    )
    .eq('secret_hash', '\\x' + hash.toString('hex'))
    .maybeSingle();
  if (error) throw new ApiError(500, 'database_error', error.message);
  if (!data) throw new ApiError(404, 'not_found', 'invalid token');
  if (data.revoked_at) throw new ApiError(404, 'not_found', 'invalid token');

  const { data: t, error: tErr } = await admin
    .from('tenancies')
    .select('status, deleted_at, area_id')
    .eq('account_id', data.account_id)
    .eq('id', data.tenancy_id)
    .maybeSingle();
  if (tErr) throw new ApiError(500, 'database_error', tErr.message);
  if (!t || t.deleted_at !== null || t.status === 'ended') {
    throw new ApiError(404, 'not_found', 'invalid token');
  }

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

  return { token: data as TokenRow, tenancyAreaId: t.area_id as string };
}

function clientIp(c: { req: { header: (n: string) => string | undefined } }): string {
  return (
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ??
    c.req.header('cf-connecting-ip') ??
    'unknown'
  );
}

// ----- intake app ------------------------------------------------------------

export const intakeApp = newApiApp();

// Emit the body schemas into components even though the route references
// them only as raw $refs (see the comment above the route definition).
intakeApp.openAPIRegistry.register('IntakeBody', IntakeBody);
intakeApp.openAPIRegistry.register('IntakeMultipartBody', IntakeMultipartBody);

intakeApp.openapi(intake, async (c) => {
  const ipCheck = await bumpIpRateBucket(clientIp(c));
  if (!ipCheck.ok) {
    throw new ApiError(429, 'conflict', 'rate limit exceeded for this IP; try again later');
  }

  const { token } = c.req.valid('param');
  const { token: tokenRow, tenancyAreaId } = await lookupAndRateLimitToken(token);

  // Parse body in either JSON or multipart shape. We do this ourselves
  // because zod-openapi's auto-validator picks ONE content-type and we
  // accept both -- relying on c.req.valid('json') silently drops the
  // multipart path, and vice versa.
  const contentType = c.req.header('content-type') ?? '';
  type IntakeFields = z.infer<typeof IntakeBody>;
  let candidate: Record<string, unknown>;
  let file: File | null = null;

  if (contentType.toLowerCase().startsWith('multipart/')) {
    type BodyVal = string | File | undefined;
    const form = (await c.req.parseBody()) as Record<string, BodyVal>;
    candidate = {
      area_id: typeof form.area_id === 'string' ? form.area_id : undefined,
      title: typeof form.title === 'string' ? form.title : undefined,
      description: typeof form.description === 'string' ? form.description : undefined,
      severity: typeof form.severity === 'string' ? form.severity : undefined,
      occurred_at: typeof form.occurred_at === 'string' ? form.occurred_at : undefined,
    };
    const maybeFile = form.file;
    if (maybeFile && typeof maybeFile !== 'string' && 'arrayBuffer' in maybeFile) {
      file = maybeFile as File;
    }
  } else {
    // A syntactically-broken JSON body must be its own clear 400 — swallowing
    // it into {} used to cascade into per-field "Required" messages that told
    // the submitter nothing (usability finding C2).
    try {
      candidate = (await c.req.json()) as Record<string, unknown>;
    } catch {
      throw new ApiError(400, 'invalid_request', 'malformed JSON request body');
    }
  }
  const parsed = IntakeBody.safeParse(candidate);
  if (!parsed.success) {
    // Field paths matter here: this message is rendered verbatim to the
    // tenant by intake clients. "title: Required" is actionable; "Required"
    // alone is not.
    throw new ApiError(
      400,
      'invalid_request',
      parsed.error.issues
        .map((i) => (i.path.length > 0 ? `${i.path.join('.')}: ` : '') + i.message)
        .join('; '),
      { fieldErrors: parsed.error.flatten().fieldErrors },
    );
  }
  const fields: IntakeFields = parsed.data;

  // Location defaults to the tenancy's own unit (the token binds exactly one
  // tenancy). Either way the area is re-validated to be a live area of the
  // TOKEN's property — the default id could only fail if the unit was
  // removed out from under the tenancy by direct DB manipulation.
  const areaId = fields.area_id ?? tenancyAreaId;
  const admin = getAdminClient();
  const { data: area, error: aErr } = await admin
    .from('areas')
    .select('id, kind, property_id, account_id')
    .eq('account_id', tokenRow.account_id)
    .eq('property_id', tokenRow.property_id)
    .eq('id', areaId)
    .is('deleted_at', null)
    .maybeSingle();
  if (aErr) throw new ApiError(500, 'database_error', aErr.message);
  if (!area) {
    throw new ApiError(
      404,
      'not_found',
      fields.area_id !== undefined
        ? 'area not found in this property'
        : 'the tenancy’s unit is no longer available; contact your landlord',
    );
  }

  // If a file came in, validate + store the bytes BEFORE calling the RPC.
  // The RPC just records the metadata; the bytes need to be findable in
  // storage by the time anyone reads the attachment row. On RPC failure
  // we have orphan blobs in storage, which a future cron prunes by
  // storage_path NOT IN (SELECT storage_path FROM attachments).
  let putResult: Awaited<ReturnType<typeof processAndStoreBytes>> | null = null;
  if (file) {
    const mime = file.type || 'application/octet-stream';
    if (!ALLOWED_MIME_TYPES.has(mime)) {
      throw new ApiError(400, 'invalid_request', `unsupported mime_type ${mime}`);
    }
    const size = file.size;
    if (size <= 0 || size > MAX_BYTES) {
      throw new ApiError(400, 'invalid_request', `file size out of range (${size})`);
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    putResult = await processAndStoreBytes(tokenRow.account_id, bytes, mime);
  }

  const { data: rpcData, error: rpcErr } = await admin.rpc('submit_intake_with_attachment', {
    p_account_id: tokenRow.account_id,
    p_tenancy_id: tokenRow.tenancy_id,
    p_area_id: area.id,
    p_title: fields.title,
    p_description: nullableRpcArg(fields.description ?? null),
    p_severity: fields.severity,
    p_occurred_at: fields.occurred_at ?? new Date().toISOString(),
    p_actor: `tenant:${tokenRow.id}`,
    p_attachment_hash: nullableRpcArg(putResult?.primary.hash ?? null),
    p_attachment_mime: nullableRpcArg(putResult?.primary.mimeType ?? null),
    p_attachment_size: nullableRpcArg(putResult?.primary.sizeBytes ?? null),
    p_attachment_path: nullableRpcArg(putResult?.primary.storagePath ?? null),
    p_derivative_hash: putResult?.derivative?.hash,
    p_derivative_mime: putResult?.derivative?.mimeType,
    p_derivative_size: putResult?.derivative?.sizeBytes,
    p_derivative_path: putResult?.derivative?.storagePath,
  });
  if (rpcErr) {
    throw new ApiError(500, 'database_error', rpcErr.message);
  }
  const row = (Array.isArray(rpcData) ? rpcData[0] : rpcData) as {
    maintenance_request_id: string;
    interaction_id: string;
    attachment_id: string | null;
    derivative_id: string | null;
    deduped: boolean;
  } | null;
  if (!row) throw new ApiError(500, 'database_error', 'intake RPC returned no row');

  // Lifetime success counter, bumped only after the RPC committed. Same
  // read-modify-write pattern (and the same accepted undercount race) as the
  // use_count window bump above; a UX counter, not evidence. Failures are
  // deliberately not counted -- that is use_count's job.
  await admin
    .from('intake_tokens')
    .update({
      submission_count: tokenRow.submission_count + 1,
      updated_at: new Date().toISOString(),
    })
    .eq('id', tokenRow.id);

  return c.json(
    {
      maintenance_request_id: row.maintenance_request_id,
      interaction_id: row.interaction_id,
      attachment_id: row.attachment_id,
      derivative_id: row.derivative_id,
      deduped_onto_existing: row.deduped,
    },
    201,
  );
});
