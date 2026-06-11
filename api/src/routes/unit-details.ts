import { createRoute, z } from '@hono/zod-openapi';
import { newApiApp } from './_lib/app';
import { getSb } from '../supabase/request-client';
import { ApiError, errorResponses } from './_lib/error';

// 1:1 sub-resource on areas: unit-only attributes (bedrooms, bathrooms, sqft).
// The DB-side trigger `unit_details_area_kind_check` raises if you try to
// insert with an area whose kind != 'unit'; we surface that as a 400.
//
// The PUT is an upsert: idempotent set-of-values for a unit's metadata. There
// is no DELETE -- when the parent area is soft-deleted, the unit_details row
// stays (cascade is on the area, soft-delete leaves both). When the area is
// HARD-deleted (not currently a path), the FK cascades.

const UnitDetails = z
  .object({
    area_id: z.string().uuid(),
    account_id: z.string().uuid(),
    bedrooms: z.number().int().nonnegative().nullable(),
    bathrooms: z.number().nonnegative().nullable(),
    sqft: z.number().int().nonnegative().nullable(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .openapi('UnitDetails');

// Exported for reuse by the onboarding-import executor (same-schema validation).
export const PutUnitDetailsBody = z
  .object({
    bedrooms: z.number().int().nonnegative().nullable().optional(),
    bathrooms: z.number().nonnegative().nullable().optional(),
    sqft: z.number().int().nonnegative().nullable().optional(),
  })
  .openapi('PutUnitDetailsBody');

const ParamShape = z.object({
  accountId: z.string().uuid().openapi({ param: { name: 'accountId', in: 'path' } }),
  areaId: z.string().uuid().openapi({ param: { name: 'areaId', in: 'path' } }),
});

const get = createRoute({
  method: 'get',
  path: '/accounts/{accountId}/areas/{areaId}/unit-details',
  tags: ['unit_details'],
  summary: 'Get unit-only attributes for an area',
  request: { params: ParamShape },
  responses: {
    200: { description: 'unit details', content: { 'application/json': { schema: UnitDetails } } },
    ...errorResponses,
  },
});

const put = createRoute({
  method: 'put',
  path: '/accounts/{accountId}/areas/{areaId}/unit-details',
  tags: ['unit_details'],
  summary: 'Upsert unit-only attributes (requires area.kind = unit)',
  request: {
    params: ParamShape,
    body: { content: { 'application/json': { schema: PutUnitDetailsBody } }, required: true },
  },
  responses: {
    200: { description: 'upserted', content: { 'application/json': { schema: UnitDetails } } },
    ...errorResponses,
  },
});

export const unitDetailsApp = newApiApp();

unitDetailsApp.openapi(get, async (c) => {
  const { accountId, areaId } = c.req.valid('param');
  const sb = getSb(c);
  const { data, error } = await sb
    .from('unit_details')
    .select('*')
    .eq('account_id', accountId)
    .eq('area_id', areaId)
    .maybeSingle();
  if (error) throw new ApiError(500, 'database_error', error.message);
  if (!data) throw new ApiError(404, 'not_found', 'no unit_details for this area (may not be a unit-kind area, or none set)');
  return c.json(data as z.infer<typeof UnitDetails>, 200);
});

unitDetailsApp.openapi(put, async (c) => {
  const { accountId, areaId } = c.req.valid('param');
  const body = c.req.valid('json');
  const sb = getSb(c);

  // Upsert: on (area_id) conflict, replace the row.
  const row: Record<string, unknown> = {
    area_id: areaId,
    account_id: accountId,
    updated_at: new Date().toISOString(),
  };
  if (body.bedrooms !== undefined) row.bedrooms = body.bedrooms;
  if (body.bathrooms !== undefined) row.bathrooms = body.bathrooms;
  if (body.sqft !== undefined) row.sqft = body.sqft;

  const { data, error } = await sb
    .from('unit_details')
    .upsert(row, { onConflict: 'area_id' })
    .select('*')
    .single();

  if (error) {
    // The DB trigger raises on a non-unit area; that comes back as a
    // generic error. Detect by message; fall back to 500.
    // It also raises `area <uuid> not found` when the area is invisible
    // under RLS (e.g. belongs to another account) -- 404 from the caller's
    // perspective.
    if (/area .* not found/i.test(error.message)) {
      throw new ApiError(404, 'not_found', 'area not found in this account');
    }
    if (/expected unit/i.test(error.message)) {
      throw new ApiError(400, 'invalid_request', 'area is not kind=unit');
    }
    if (error.code === '23503') {
      throw new ApiError(404, 'not_found', 'area not found in this account');
    }
    throw new ApiError(500, 'database_error', error.message);
  }
  return c.json(data as z.infer<typeof UnitDetails>, 200);
});
