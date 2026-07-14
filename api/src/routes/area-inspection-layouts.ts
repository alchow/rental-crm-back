import { createRoute, z } from '@hono/zod-openapi';
import { newApiApp } from './_lib/app';
import { getSb } from '../supabase/request-client';
import { asJson, type DbTableInsert } from '../supabase/db-types';
import { ApiError, errorResponses } from './_lib/error';
import { softDeleteStamp } from './_lib/soft-delete';

// Per-unit inspection layout: an INERT template-trim delta store.
//
// A landlord starts from a base inspection template and trims it per unit ("no
// garage here; add a second balcony"). The frontend records that trim as a
// delta DOCUMENT keyed (area_id x template_id) -- it does NOT fork the template.
// This route is the document's home: one singleton sub-resource per
// (area, template) pair.
//
// The backend is deliberately DUMB about the document's meaning. We pin its
// SHAPE with zod (bounded arrays, typed added-item records) so the SDK gets
// exact types, but we never validate a removed/added KEY against the template's
// schema -- membership is the frontend's job, recomputed on every apply (a
// removed key that no longer exists in a re-published base template is simply a
// no-op there). Because of that, GET on a pair that was never written returns
// 404 ("no memory -- render the standard form"), PUT is an idempotent
// whole-document upsert, and DELETE resets the unit back to the standard form.
//
// Path shape mirrors unit-details (another singleton sub-resource on an area);
// areaId is pre-validated by the requireImmediateParent middleware, and a
// cross-account templateId is rejected by the composite FK (surfaced as 404).

// The delta document. STRICT so an unexpected key is a 400 rather than silently
// stored: the frontend owns this shape, so an unknown field is a client bug.
// Reused verbatim as the response `layout` so generated FE types are exact.
const LayoutDoc = z
  .object({
    removed_section_keys: z.array(z.string().min(1).max(200)).max(500).optional(),
    removed_item_keys: z.array(z.string().min(1).max(200)).max(500).optional(),
    removed_check_keys: z.array(z.string().min(1).max(200)).max(500).optional(),
    added_items: z
      .array(
        z
          .object({
            key: z.string().min(1).max(200),
            label: z.string().min(1).max(200),
            group_label: z.string().min(1).max(200).nullable().optional(),
            sort_order: z.number().int().optional(),
          })
          .strict(),
      )
      .max(200)
      .optional(),
    added_checks: z
      .array(
        z
          .object({
            key: z.string().min(1).max(200),
            label: z.string().min(1).max(200),
            group_label: z.string().min(1).max(200).nullable().optional(),
            sort_order: z.number().int().optional(),
            // §20(a) typed checks land with this program.
            input_kind: z.enum(['boolean', 'count', 'text']).optional(),
          })
          .strict(),
      )
      .max(200)
      .optional(),
  })
  .strict()
  .openapi('AreaInspectionLayoutDoc');

const PutBody = z
  .object({
    base_template_version: z.string().min(1).max(100).optional(),
    layout: LayoutDoc,
  })
  .strict()
  .openapi('PutAreaInspectionLayoutBody');

const AreaInspectionLayout = z
  .object({
    id: z.string().uuid(),
    account_id: z.string().uuid(),
    area_id: z.string().uuid(),
    template_id: z.string().uuid(),
    base_template_version: z.string().nullable(),
    layout: LayoutDoc,
    created_at: z.string(),
    updated_at: z.string(),
    deleted_at: z.string().nullable(),
  })
  .openapi('AreaInspectionLayout');

const ParamShape = z.object({
  accountId: z
    .string()
    .uuid()
    .openapi({ param: { name: 'accountId', in: 'path' } }),
  areaId: z
    .string()
    .uuid()
    .openapi({ param: { name: 'areaId', in: 'path' } }),
  templateId: z
    .string()
    .uuid()
    .openapi({ param: { name: 'templateId', in: 'path' } }),
});

const BASE_PATH = '/accounts/{accountId}/areas/{areaId}/inspection-layouts/{templateId}';

const get = createRoute({
  method: 'get',
  path: BASE_PATH,
  tags: ['area_inspection_layouts'],
  summary: 'Get the per-unit inspection layout delta for an (area, template)',
  request: { params: ParamShape },
  responses: {
    200: { description: 'layout delta', content: { 'application/json': { schema: AreaInspectionLayout } } },
    ...errorResponses,
  },
});

const put = createRoute({
  method: 'put',
  path: BASE_PATH,
  tags: ['area_inspection_layouts'],
  summary: 'Upsert the per-unit inspection layout delta (idempotent whole-document)',
  request: {
    params: ParamShape,
    body: { content: { 'application/json': { schema: PutBody } }, required: true },
  },
  responses: {
    200: { description: 'upserted', content: { 'application/json': { schema: AreaInspectionLayout } } },
    ...errorResponses,
  },
});

const remove = createRoute({
  method: 'delete',
  path: BASE_PATH,
  tags: ['area_inspection_layouts'],
  summary: 'Reset the unit back to the standard form (soft-delete the delta)',
  request: { params: ParamShape },
  responses: {
    204: { description: 'reset to standard form' },
    ...errorResponses,
  },
});

export const areaInspectionLayoutsApp = newApiApp();

areaInspectionLayoutsApp.openapi(get, async (c) => {
  const { accountId, areaId, templateId } = c.req.valid('param');
  const sb = getSb(c);
  const { data, error } = await sb
    .from('area_inspection_layouts')
    .select('*')
    .eq('account_id', accountId)
    .eq('area_id', areaId)
    .eq('template_id', templateId)
    .is('deleted_at', null)
    .maybeSingle();
  if (error) throw new ApiError(500, 'database_error', error.message);
  if (!data)
    throw new ApiError(
      404,
      'not_found',
      'no inspection layout for this area+template (renders the standard form)',
    );
  // Json row -> structured doc: every write is validated through LayoutDoc, so
  // the stored document already conforms; the double cast just re-narrows Json.
  return c.json(data as unknown as z.infer<typeof AreaInspectionLayout>, 200);
});

areaInspectionLayoutsApp.openapi(put, async (c) => {
  const { accountId, areaId, templateId } = c.req.valid('param');
  const body = c.req.valid('json');
  const sb = getSb(c);

  const row: DbTableInsert<'area_inspection_layouts'> = {
    account_id: accountId,
    area_id: areaId,
    template_id: templateId,
    base_template_version: body.base_template_version ?? null,
    layout: asJson(body.layout),
    // LOAD-BEARING: the unique arbiter (area_id, template_id) is TOTAL, so an
    // upsert onto a soft-deleted row UPDATES it in place. Clearing deleted_at
    // here is what revives that tombstone on a re-PUT after DELETE (one physical
    // row per area+template, ever) instead of colliding on a fresh insert.
    deleted_at: null,
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await sb
    .from('area_inspection_layouts')
    .upsert(row, { onConflict: 'area_id,template_id' })
    .select('*')
    .single();

  if (error) {
    // A cross-account template_id dies on the composite (account_id,
    // template_id) FK as 23503. areaId is pre-validated by the
    // requireImmediateParent middleware, so it is never the offender here.
    if (error.code === '23503') {
      throw new ApiError(404, 'not_found', 'area_id or template_id does not belong to this account');
    }
    throw new ApiError(500, 'database_error', error.message);
  }
  return c.json(data as unknown as z.infer<typeof AreaInspectionLayout>, 200);
});

areaInspectionLayoutsApp.openapi(remove, async (c) => {
  const { accountId, areaId, templateId } = c.req.valid('param');
  const sb = getSb(c);
  // Soft delete: the tombstone stays so a later PUT can revive it (see put()).
  const { data, error } = await sb
    .from('area_inspection_layouts')
    .update(softDeleteStamp())
    .eq('account_id', accountId)
    .eq('area_id', areaId)
    .eq('template_id', templateId)
    .is('deleted_at', null)
    .select('id')
    .maybeSingle();
  if (error) throw new ApiError(500, 'database_error', error.message);
  if (!data) throw new ApiError(404, 'not_found', 'no inspection layout to reset for this area+template');
  return c.body(null, 204);
});
