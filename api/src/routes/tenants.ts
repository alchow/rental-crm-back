import { createRoute, z } from '@hono/zod-openapi';
import { newApiApp } from './_lib/app';
import { getSb } from '../supabase/request-client';
import type { DbTableUpdate } from '../supabase/db-types';
import { ApiError, conflictResponse, errorResponses } from './_lib/error';
import { keysetPage } from './_lib/cursor';
import { softDeleteStamp } from './_lib/soft-delete';
import { CreateTenantBody } from '../schemas/importable';
import { tenantEmailConflicts } from '../admin/tenant-email-conflicts';

const Tenant = z
  .object({
    id: z.string().uuid(),
    account_id: z.string().uuid(),
    full_name: z.string(),
    emails: z.array(z.string()),
    phones: z.array(z.string()),
    notes: z.string().nullable(),
    created_at: z.string(),
    updated_at: z.string(),
    deleted_at: z.string().nullable(),
  })
  .openapi('Tenant');

const PatchTenantBody = z
  .object({
    full_name: z.string().min(1).max(200).optional(),
    emails: z.array(z.string().email()).optional(),
    phones: z.array(z.string().min(1).max(40)).optional(),
    notes: z.string().nullable().optional(),
  })
  .refine((b) => Object.keys(b).length > 0, {
    message: 'at least one field is required',
  })
  .openapi('PatchTenantBody');

const AccountParam = z.object({
  accountId: z
    .string()
    .uuid()
    .openapi({ param: { name: 'accountId', in: 'path' } }),
});
const AccountAndIdParam = z.object({
  accountId: z
    .string()
    .uuid()
    .openapi({ param: { name: 'accountId', in: 'path' } }),
  id: z
    .string()
    .uuid()
    .openapi({ param: { name: 'id', in: 'path' } }),
});

const ListQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().positive().max(100).default(50),
});

const ListResponse = z
  .object({ data: z.array(Tenant), next_cursor: z.string().nullable() })
  .openapi('TenantListResponse');

const list = createRoute({
  method: 'get',
  path: '/accounts/{accountId}/tenants',
  tags: ['tenants'],
  summary: 'List tenants',
  request: { params: AccountParam, query: ListQuery },
  responses: {
    200: { description: 'page', content: { 'application/json': { schema: ListResponse } } },
    ...errorResponses,
  },
});
const get = createRoute({
  method: 'get',
  path: '/accounts/{accountId}/tenants/{id}',
  tags: ['tenants'],
  summary: 'Get one tenant',
  request: { params: AccountAndIdParam },
  responses: {
    200: { description: 'tenant', content: { 'application/json': { schema: Tenant } } },
    ...errorResponses,
  },
});
const create = createRoute({
  method: 'post',
  path: '/accounts/{accountId}/tenants',
  tags: ['tenants'],
  summary: 'Create a tenant',
  description:
    'A 409 conflict is returned when an email is already held within the account — by ' +
    'another tenant, or by an owner/manager login email (details.conflicts names the holders).',
  request: {
    params: AccountParam,
    body: { content: { 'application/json': { schema: CreateTenantBody } }, required: true },
  },
  responses: {
    201: { description: 'created', content: { 'application/json': { schema: Tenant } } },
    ...errorResponses,
    ...conflictResponse,
  },
});
const patch = createRoute({
  method: 'patch',
  path: '/accounts/{accountId}/tenants/{id}',
  tags: ['tenants'],
  summary: 'Update a tenant (partial)',
  description:
    'A 409 conflict is returned when a written email is already held within the account — by ' +
    'another tenant, or by an owner/manager login email (details.conflicts names the holders).',
  request: {
    params: AccountAndIdParam,
    body: { content: { 'application/json': { schema: PatchTenantBody } }, required: true },
  },
  responses: {
    200: { description: 'updated', content: { 'application/json': { schema: Tenant } } },
    ...errorResponses,
    ...conflictResponse,
  },
});
const remove = createRoute({
  method: 'delete',
  path: '/accounts/{accountId}/tenants/{id}',
  tags: ['tenants'],
  summary: 'Soft-delete a tenant',
  request: { params: AccountAndIdParam },
  responses: {
    204: { description: 'deleted' },
    ...errorResponses,
  },
});

// ----------------------------------------------------------------------------
// Per-account tenant-email uniqueness (migration 20260721000002).
//
// Two enforcement layers back this route:
//   * assertEmailsWritable() — the friendly, pre-insert path. It rejects
//     intra-array dupes with a 422 (blanks/padded input never reach it — the
//     body schema's z.string().email() 400s those first), then asks the
//     service-role oracle who else holds the addresses and raises a 409 that
//     SHOWS the holder(s). It hard-blocks BOTH collision classes — another
//     tenant, and an owner/manager login email (the comms layer maps those to
//     landlord_user, so a shared address mis-attributes message direction).
//   * mapEmailUniqueViolation() — the race-window backstop. The DB trigger
//     raises 23505 if a concurrent write slipped a duplicate in between the
//     oracle check and the insert; map that to the same 409 with a generic
//     message. (The trigger blocks only the tenant-holder class; the API blocks
//     both, so the DB permits an account_user write the API refuses — documented
//     asymmetry.)
// ----------------------------------------------------------------------------

/**
 * Reject case-insensitive intra-array duplicates with a 422 fieldErrors.emails
 * (matches accounts.ts branding). Blanks/padded input never reach here — the
 * body schema's z.string().email() already 400s them in the defaultHook — so
 * the duplicate check is the ONLY normalization the API layer owes; the DB
 * compares lower(btrim) on its side. Caller guarantees `emails` is non-empty.
 */
function normalizeEmailsForWrite(emails: string[]): string[] {
  const seen = new Set<string>();
  for (const e of emails) {
    const norm = e.toLowerCase();
    if (seen.has(norm)) {
      throw new ApiError(422, 'invalid_request', 'tenant emails are invalid', {
        fieldErrors: { emails: [`duplicate address ${e}`] },
      });
    }
    seen.add(norm);
  }
  return emails;
}

/**
 * Normalize, then reject any per-account collision with a 409 that names the
 * holder(s). `excludeTenantId` is the row being PATCHed (so it does not collide
 * with itself). Returns the normalized array to persist.
 */
async function assertEmailsWritable(
  accountId: string,
  emails: string[],
  excludeTenantId?: string,
): Promise<string[]> {
  const normalized = normalizeEmailsForWrite(emails);
  const conflicts = await tenantEmailConflicts(accountId, normalized, excludeTenantId);
  if (conflicts.length === 0) return normalized;

  const tenantHits = conflicts.filter((c) => c.holder_kind === 'tenant');
  // Representative holder for the summary line: prefer a tenant holder (hard
  // integrity), else the account_user (landlord-login) collision.
  const primary = tenantHits[0] ?? conflicts[0];
  if (!primary) return normalized; // unreachable — conflicts is non-empty here
  let message: string;
  let fieldError: string;
  if (primary.holder_kind === 'tenant') {
    // Another tenant already holds the address. Name the first few holders.
    const shown = tenantHits.slice(0, 3);
    message = `email ${shown.map((c) => `${c.email} already belongs to ${c.holder_name}`).join('; ')}`;
    fieldError = `already belongs to ${primary.holder_name}`;
  } else {
    // account_user only: the address is a landlord's login email.
    message = `email ${primary.email} is an account user's login email (${primary.holder_name})`;
    fieldError = "is an account user's login email";
  }
  throw new ApiError(409, 'conflict', message, {
    conflicts,
    fieldErrors: { emails: [fieldError] },
  });
}

/**
 * Map the trigger's 23505 (unique_violation) to the friendly 409. Anything else
 * keeps the standard database_error 500. Used on the insert/update result only
 * for the narrow race window assertEmailsWritable did not already close.
 */
function mapTenantWriteError(error: { code?: string; message: string }): ApiError {
  if (error.code === '23505') {
    return new ApiError(409, 'conflict', 'an email on this tenant already belongs to someone else', {
      fieldErrors: { emails: ['already in use'] },
    });
  }
  return new ApiError(500, 'database_error', error.message);
}

export const tenantsApp = newApiApp();

tenantsApp.openapi(list, async (c) => {
  const { accountId } = c.req.valid('param');
  const { cursor, limit } = c.req.valid('query');
  const sb = getSb(c);
  const query = sb.from('tenants').select('*').eq('account_id', accountId).is('deleted_at', null);
  const { items, next_cursor: nextCursor } = await keysetPage(query, { cursor, limit });
  return c.json({ data: items, next_cursor: nextCursor } as z.infer<typeof ListResponse>, 200);
});

tenantsApp.openapi(get, async (c) => {
  const { accountId, id } = c.req.valid('param');
  const sb = getSb(c);
  const { data, error } = await sb
    .from('tenants')
    .select('*')
    .eq('account_id', accountId)
    .eq('id', id)
    .is('deleted_at', null)
    .maybeSingle();
  if (error) throw new ApiError(500, 'database_error', error.message);
  if (!data) throw new ApiError(404, 'not_found', 'not found');
  return c.json(data as z.infer<typeof Tenant>, 200);
});

tenantsApp.openapi(create, async (c) => {
  const { accountId } = c.req.valid('param');
  const body = c.req.valid('json');
  const sb = getSb(c);
  const emails = body.emails ?? [];
  const emailsToStore = emails.length > 0 ? await assertEmailsWritable(accountId, emails) : emails;
  const { data, error } = await sb
    .from('tenants')
    .insert({
      account_id: accountId,
      full_name: body.full_name,
      emails: emailsToStore,
      phones: body.phones ?? [],
      notes: body.notes ?? null,
    })
    .select('*')
    .single();
  if (error) throw mapTenantWriteError(error);
  return c.json(data as z.infer<typeof Tenant>, 201);
});

tenantsApp.openapi(patch, async (c) => {
  const { accountId, id } = c.req.valid('param');
  const body = c.req.valid('json');
  const sb = getSb(c);
  const update: DbTableUpdate<'tenants'> = { updated_at: new Date().toISOString() };
  if (body.full_name !== undefined) update.full_name = body.full_name;
  if (body.emails !== undefined) {
    update.emails =
      body.emails.length > 0 ? await assertEmailsWritable(accountId, body.emails, id) : body.emails;
  }
  if (body.phones !== undefined) update.phones = body.phones;
  if (body.notes !== undefined) update.notes = body.notes;
  const { data, error } = await sb
    .from('tenants')
    .update(update)
    .eq('account_id', accountId)
    .eq('id', id)
    .is('deleted_at', null)
    .select('*')
    .maybeSingle();
  if (error) throw mapTenantWriteError(error);
  if (!data) throw new ApiError(404, 'not_found', 'not found');
  return c.json(data as z.infer<typeof Tenant>, 200);
});

tenantsApp.openapi(remove, async (c) => {
  const { accountId, id } = c.req.valid('param');
  const sb = getSb(c);
  const { data, error } = await sb
    .from('tenants')
    .update(softDeleteStamp())
    .eq('account_id', accountId)
    .eq('id', id)
    .is('deleted_at', null)
    .select('id')
    .maybeSingle();
  if (error) throw new ApiError(500, 'database_error', error.message);
  if (!data) throw new ApiError(404, 'not_found', 'not found');
  return c.body(null, 204);
});
