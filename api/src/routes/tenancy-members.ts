import { createRoute, z } from '@hono/zod-openapi';
import { newApiApp } from './_lib/app';
import { getSb } from '../supabase/request-client';
import { ApiError, errorResponses } from './_lib/error';
import { keysetPage } from './_lib/cursor';
import { paginated } from './_lib/list-response';
import { softDeleteStamp } from './_lib/soft-delete';
import { AddMemberBody, MemberRole } from '../schemas/importable';

// Sub-resource of tenancies: the people occupying a tenancy, with a role.
// One tenant can hold multiple roles in the same tenancy (the unique key is
// (tenancy_id, tenant_id, role)). A guarantor is also a "member" here, just
// with role=guarantor.
//
// Cross-account safety: the route filters by tenancy_id (from the URL path)
// and the underlying composite FK rejects a tenancy in another account, so
// even if the URL was crafted to point at another account's tenancy the
// query returns nothing.

const TenancyMember = z
  .object({
    id: z.string().uuid(),
    account_id: z.string().uuid(),
    tenancy_id: z.string().uuid(),
    tenant_id: z.string().uuid(),
    role: MemberRole,
    created_at: z.string(),
    updated_at: z.string(),
    deleted_at: z.string().nullable(),
  })
  .openapi('TenancyMember');

const PatchMemberBody = z.object({ role: MemberRole }).openapi('PatchTenancyMemberBody');

const ListResponse = paginated(TenancyMember).openapi('TenancyMemberListResponse');

const ListQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().positive().max(100).default(50),
});

const TenancyParam = z.object({
  accountId: z
    .string()
    .uuid()
    .openapi({ param: { name: 'accountId', in: 'path' } }),
  tenancyId: z
    .string()
    .uuid()
    .openapi({ param: { name: 'tenancyId', in: 'path' } }),
});
const MemberParam = z.object({
  accountId: z
    .string()
    .uuid()
    .openapi({ param: { name: 'accountId', in: 'path' } }),
  tenancyId: z
    .string()
    .uuid()
    .openapi({ param: { name: 'tenancyId', in: 'path' } }),
  id: z
    .string()
    .uuid()
    .openapi({ param: { name: 'id', in: 'path' } }),
});

const list = createRoute({
  method: 'get',
  path: '/accounts/{accountId}/tenancies/{tenancyId}/members',
  tags: ['tenancy-members'],
  summary: 'List members of a tenancy',
  request: { params: TenancyParam, query: ListQuery },
  responses: {
    200: { description: 'members', content: { 'application/json': { schema: ListResponse } } },
    ...errorResponses,
  },
});
const add = createRoute({
  method: 'post',
  path: '/accounts/{accountId}/tenancies/{tenancyId}/members',
  tags: ['tenancy-members'],
  summary: 'Add a tenant to a tenancy with a role',
  request: {
    params: TenancyParam,
    body: { content: { 'application/json': { schema: AddMemberBody } }, required: true },
  },
  responses: {
    201: { description: 'added', content: { 'application/json': { schema: TenancyMember } } },
    ...errorResponses,
  },
});
const patch = createRoute({
  method: 'patch',
  path: '/accounts/{accountId}/tenancies/{tenancyId}/members/{id}',
  tags: ['tenancy-members'],
  summary: 'Update a member role',
  request: {
    params: MemberParam,
    body: { content: { 'application/json': { schema: PatchMemberBody } }, required: true },
  },
  responses: {
    200: { description: 'updated', content: { 'application/json': { schema: TenancyMember } } },
    ...errorResponses,
  },
});
const remove = createRoute({
  method: 'delete',
  path: '/accounts/{accountId}/tenancies/{tenancyId}/members/{id}',
  tags: ['tenancy-members'],
  summary: 'Soft-delete a tenancy member',
  request: { params: MemberParam },
  responses: {
    204: { description: 'removed' },
    ...errorResponses,
  },
});

export const tenancyMembersApp = newApiApp();

tenancyMembersApp.openapi(list, async (c) => {
  const { accountId, tenancyId } = c.req.valid('param');
  const { cursor, limit } = c.req.valid('query');
  const sb = getSb(c);
  const q = sb
    .from('tenancy_tenants')
    .select('*')
    .eq('account_id', accountId)
    .eq('tenancy_id', tenancyId)
    .is('deleted_at', null);
  // Oldest-first, keyset-paginated on created_at.
  const { items, next_cursor } = await keysetPage<z.infer<typeof TenancyMember>>(q, {
    cursor,
    limit,
  });
  return c.json({ data: items, next_cursor }, 200);
});

tenancyMembersApp.openapi(add, async (c) => {
  const { accountId, tenancyId } = c.req.valid('param');
  const body = c.req.valid('json');
  const sb = getSb(c);
  const { data, error } = await sb
    .from('tenancy_tenants')
    .insert({
      account_id: accountId,
      tenancy_id: tenancyId,
      tenant_id: body.tenant_id,
      role: body.role,
    })
    .select('*')
    .single();
  if (error) {
    if (error.code === '23505') {
      throw new ApiError(409, 'conflict', 'this tenant already holds this role in this tenancy');
    }
    if (error.code === '23503') {
      // Composite FK miss: tenancy_id or tenant_id doesn't belong to this account.
      throw new ApiError(404, 'not_found', 'tenancy or tenant not found in this account');
    }
    throw new ApiError(500, 'database_error', error.message);
  }
  return c.json(data as z.infer<typeof TenancyMember>, 201);
});

tenancyMembersApp.openapi(patch, async (c) => {
  const { accountId, tenancyId, id } = c.req.valid('param');
  const body = c.req.valid('json');
  const sb = getSb(c);
  const { data, error } = await sb
    .from('tenancy_tenants')
    .update({ role: body.role, updated_at: new Date().toISOString() })
    .eq('account_id', accountId)
    .eq('tenancy_id', tenancyId)
    .eq('id', id)
    .is('deleted_at', null)
    .select('*')
    .maybeSingle();
  if (error) {
    if (error.code === '23505') {
      throw new ApiError(409, 'conflict', 'a member with this role already exists for the tenancy');
    }
    throw new ApiError(500, 'database_error', error.message);
  }
  if (!data) throw new ApiError(404, 'not_found', 'not found');
  return c.json(data as z.infer<typeof TenancyMember>, 200);
});

tenancyMembersApp.openapi(remove, async (c) => {
  const { accountId, tenancyId, id } = c.req.valid('param');
  const sb = getSb(c);
  const { data, error } = await sb
    .from('tenancy_tenants')
    .update(softDeleteStamp())
    .eq('account_id', accountId)
    .eq('tenancy_id', tenancyId)
    .eq('id', id)
    .is('deleted_at', null)
    .select('id')
    .maybeSingle();
  if (error) throw new ApiError(500, 'database_error', error.message);
  if (!data) throw new ApiError(404, 'not_found', 'not found');
  return c.body(null, 204);
});
