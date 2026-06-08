import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { getUserClient } from '../supabase/user-client';
import { ApiError, errorResponses } from './_lib/error';
import { decodeCursor, encodeCursor } from './_lib/cursor';
import { generateAndStoreInspectionReport } from '../admin/pdf';

// ============================================================================
// inspection_templates / inspections / inspection_items + completion.
// ============================================================================
//
// A "completed" inspection is locked: the DB triggers
// _reject_completed_inspection_update + _reject_item_update_on_completed_
// inspection refuse any change. Corrections happen via NEW events under
// the audit spine, never edits to the report bytes. Phase 8's contribution
// is the COMPLETE endpoint -- it sets completed_at AND renders the PDF
// (deterministically) AND stores it as a content-hashed attachment of
// entity_type='inspection_report'.

// --- inspection_templates ---------------------------------------------------

const InspectionTemplate = z
  .object({
    id: z.string().uuid(),
    account_id: z.string().uuid(),
    name: z.string(),
    schema: z.record(z.unknown()),
    created_at: z.string(),
    updated_at: z.string(),
    deleted_at: z.string().nullable(),
  })
  .openapi('InspectionTemplate');

const CreateTemplateBody = z
  .object({
    name: z.string().min(1).max(200),
    schema: z.record(z.unknown()).optional(),
  })
  .openapi('CreateInspectionTemplateBody');

const PatchTemplateBody = z
  .object({
    name: z.string().min(1).max(200).optional(),
    schema: z.record(z.unknown()).optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: 'at least one field is required' })
  .openapi('PatchInspectionTemplateBody');

// --- inspections ------------------------------------------------------------

const Inspection = z
  .object({
    id: z.string().uuid(),
    account_id: z.string().uuid(),
    area_id: z.string().uuid(),
    template_id: z.string().uuid().nullable(),
    performed_by: z.string().uuid().nullable(),
    performed_at: z.string().nullable(),
    completed_at: z.string().nullable(),
    notes: z.string().nullable(),
    created_at: z.string(),
    updated_at: z.string(),
    deleted_at: z.string().nullable(),
  })
  .openapi('Inspection');

const CreateInspectionBody = z
  .object({
    area_id: z.string().uuid(),
    template_id: z.string().uuid().optional(),
    performed_at: z.string().datetime().optional(),
    notes: z.string().max(20000).optional(),
  })
  .openapi('CreateInspectionBody');

const PatchInspectionBody = z
  .object({
    template_id: z.string().uuid().nullable().optional(),
    performed_at: z.string().datetime().nullable().optional(),
    notes: z.string().nullable().optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: 'at least one field is required' })
  .openapi('PatchInspectionBody');

// --- inspection_items -------------------------------------------------------

const InspectionItem = z
  .object({
    id: z.string().uuid(),
    account_id: z.string().uuid(),
    inspection_id: z.string().uuid(),
    label: z.string(),
    condition: z.string().nullable(),
    notes: z.string().nullable(),
    created_at: z.string(),
    updated_at: z.string(),
    deleted_at: z.string().nullable(),
  })
  .openapi('InspectionItem');

const CreateItemBody = z
  .object({
    label: z.string().min(1).max(200),
    condition: z.string().max(200).optional(),
    notes: z.string().max(5000).optional(),
  })
  .openapi('CreateInspectionItemBody');

const PatchItemBody = z
  .object({
    label: z.string().min(1).max(200).optional(),
    condition: z.string().nullable().optional(),
    notes: z.string().nullable().optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: 'at least one field is required' })
  .openapi('PatchInspectionItemBody');

// --- params ------------------------------------------------------------------

const AccountParam = z.object({
  accountId: z.string().uuid().openapi({ param: { name: 'accountId', in: 'path' } }),
});
const AccountAndIdParam = z.object({
  accountId: z.string().uuid().openapi({ param: { name: 'accountId', in: 'path' } }),
  id: z.string().uuid().openapi({ param: { name: 'id', in: 'path' } }),
});
const InspectionAndItemParam = z.object({
  accountId: z.string().uuid().openapi({ param: { name: 'accountId', in: 'path' } }),
  inspectionId: z.string().uuid().openapi({ param: { name: 'inspectionId', in: 'path' } }),
  id: z.string().uuid().openapi({ param: { name: 'id', in: 'path' } }),
});
const InspectionParam = z.object({
  accountId: z.string().uuid().openapi({ param: { name: 'accountId', in: 'path' } }),
  inspectionId: z.string().uuid().openapi({ param: { name: 'inspectionId', in: 'path' } }),
});

const ListQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().positive().max(100).default(50),
});
const InspectionListQuery = ListQuery.extend({
  area_id: z.string().uuid().optional(),
});
const TemplateListResponse = z
  .object({ data: z.array(InspectionTemplate), next_cursor: z.string().nullable() })
  .openapi('InspectionTemplateListResponse');
const InspectionListResponse = z
  .object({ data: z.array(Inspection), next_cursor: z.string().nullable() })
  .openapi('InspectionListResponse');
const ItemListResponse = z
  .object({ data: z.array(InspectionItem) })
  .openapi('InspectionItemListResponse');

const CompleteResponse = z
  .object({
    inspection: Inspection,
    report: z.object({
      attachment_id: z.string().uuid(),
      content_hash: z.string(),
      size_bytes: z.number().int(),
    }),
  })
  .openapi('InspectionCompleteResponse');

// ============================================================================
// templates app
// ============================================================================

const tplList = createRoute({
  method: 'get',
  path: '/accounts/{accountId}/inspection-templates',
  tags: ['inspection_templates'],
  request: { params: AccountParam, query: ListQuery },
  responses: {
    200: { description: 'page', content: { 'application/json': { schema: TemplateListResponse } } },
    ...errorResponses,
  },
});
const tplGet = createRoute({
  method: 'get',
  path: '/accounts/{accountId}/inspection-templates/{id}',
  tags: ['inspection_templates'],
  request: { params: AccountAndIdParam },
  responses: {
    200: { description: 'template', content: { 'application/json': { schema: InspectionTemplate } } },
    ...errorResponses,
  },
});
const tplCreate = createRoute({
  method: 'post',
  path: '/accounts/{accountId}/inspection-templates',
  tags: ['inspection_templates'],
  request: {
    params: AccountParam,
    body: { content: { 'application/json': { schema: CreateTemplateBody } }, required: true },
  },
  responses: {
    201: { description: 'created', content: { 'application/json': { schema: InspectionTemplate } } },
    ...errorResponses,
  },
});
const tplPatch = createRoute({
  method: 'patch',
  path: '/accounts/{accountId}/inspection-templates/{id}',
  tags: ['inspection_templates'],
  request: {
    params: AccountAndIdParam,
    body: { content: { 'application/json': { schema: PatchTemplateBody } }, required: true },
  },
  responses: {
    200: { description: 'updated', content: { 'application/json': { schema: InspectionTemplate } } },
    ...errorResponses,
  },
});
const tplRemove = createRoute({
  method: 'delete',
  path: '/accounts/{accountId}/inspection-templates/{id}',
  tags: ['inspection_templates'],
  summary: 'Soft-delete an inspection template',
  request: { params: AccountAndIdParam },
  responses: {
    204: { description: 'deleted' },
    ...errorResponses,
  },
});

export const inspectionTemplatesApp = new OpenAPIHono();

inspectionTemplatesApp.openapi(tplList, async (c) => {
  const { accountId } = c.req.valid('param');
  const { cursor, limit } = c.req.valid('query');
  const sb = getUserClient(c.get('auth').accessToken);
  let q = sb.from('inspection_templates').select('*').eq('account_id', accountId).is('deleted_at', null);
  q = q.order('created_at', { ascending: true }).order('id', { ascending: true }).limit(limit + 1);
  if (cursor) {
    const cur = decodeCursor(cursor);
    if (cur) {
      q = q.or(`created_at.gt.${cur.created_at},and(created_at.eq.${cur.created_at},id.gt.${cur.id})`);
    }
  }
  const { data, error } = await q;
  if (error) throw new ApiError(500, 'database_error', error.message);
  const rows = data ?? [];
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];
  const nextCursor = hasMore && last
    ? encodeCursor({ created_at: String(last.created_at), id: String(last.id) })
    : null;
  return c.json({ data: items, next_cursor: nextCursor } as z.infer<typeof TemplateListResponse>, 200);
});

inspectionTemplatesApp.openapi(tplGet, async (c) => {
  const { accountId, id } = c.req.valid('param');
  const sb = getUserClient(c.get('auth').accessToken);
  const { data, error } = await sb.from('inspection_templates').select('*')
    .eq('account_id', accountId).eq('id', id).is('deleted_at', null).maybeSingle();
  if (error) throw new ApiError(500, 'database_error', error.message);
  if (!data) throw new ApiError(404, 'not_found', 'not found');
  return c.json(data as z.infer<typeof InspectionTemplate>, 200);
});

inspectionTemplatesApp.openapi(tplCreate, async (c) => {
  const { accountId } = c.req.valid('param');
  const body = c.req.valid('json');
  const sb = getUserClient(c.get('auth').accessToken);
  const { data, error } = await sb.from('inspection_templates').insert({
    account_id: accountId, name: body.name, schema: body.schema ?? {},
  }).select('*').single();
  if (error) throw new ApiError(500, 'database_error', error.message);
  return c.json(data as z.infer<typeof InspectionTemplate>, 201);
});

inspectionTemplatesApp.openapi(tplPatch, async (c) => {
  const { accountId, id } = c.req.valid('param');
  const body = c.req.valid('json');
  const sb = getUserClient(c.get('auth').accessToken);
  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (body.name !== undefined) update.name = body.name;
  if (body.schema !== undefined) update.schema = body.schema;
  const { data, error } = await sb.from('inspection_templates').update(update)
    .eq('account_id', accountId).eq('id', id).is('deleted_at', null).select('*').maybeSingle();
  if (error) throw new ApiError(500, 'database_error', error.message);
  if (!data) throw new ApiError(404, 'not_found', 'not found');
  return c.json(data as z.infer<typeof InspectionTemplate>, 200);
});

inspectionTemplatesApp.openapi(tplRemove, async (c) => {
  const { accountId, id } = c.req.valid('param');
  const sb = getUserClient(c.get('auth').accessToken);
  const { data, error } = await sb.from('inspection_templates')
    .update({ deleted_at: new Date().toISOString() })
    .eq('account_id', accountId)
    .eq('id', id)
    .is('deleted_at', null)
    .select('id')
    .maybeSingle();
  if (error) throw new ApiError(500, 'database_error', error.message);
  if (!data) throw new ApiError(404, 'not_found', 'not found');
  return c.body(null, 204);
});

// ============================================================================
// inspections app
// ============================================================================

const inspList = createRoute({
  method: 'get',
  path: '/accounts/{accountId}/inspections',
  tags: ['inspections'],
  request: { params: AccountParam, query: InspectionListQuery },
  responses: {
    200: { description: 'page', content: { 'application/json': { schema: InspectionListResponse } } },
    ...errorResponses,
  },
});
const inspGet = createRoute({
  method: 'get',
  path: '/accounts/{accountId}/inspections/{id}',
  tags: ['inspections'],
  request: { params: AccountAndIdParam },
  responses: {
    200: { description: 'inspection', content: { 'application/json': { schema: Inspection } } },
    ...errorResponses,
  },
});
const inspCreate = createRoute({
  method: 'post',
  path: '/accounts/{accountId}/inspections',
  tags: ['inspections'],
  request: {
    params: AccountParam,
    body: { content: { 'application/json': { schema: CreateInspectionBody } }, required: true },
  },
  responses: {
    201: { description: 'created', content: { 'application/json': { schema: Inspection } } },
    ...errorResponses,
  },
});
const inspPatch = createRoute({
  method: 'patch',
  path: '/accounts/{accountId}/inspections/{id}',
  tags: ['inspections'],
  summary: 'Patch an inspection (rejected with 409 if already completed)',
  request: {
    params: AccountAndIdParam,
    body: { content: { 'application/json': { schema: PatchInspectionBody } }, required: true },
  },
  responses: {
    200: { description: 'updated', content: { 'application/json': { schema: Inspection } } },
    ...errorResponses,
  },
});
const inspComplete = createRoute({
  method: 'post',
  path: '/accounts/{accountId}/inspections/{id}/complete',
  tags: ['inspections'],
  summary: 'Mark an inspection complete; locks it AND stores the rendered PDF as a content-hashed attachment',
  request: { params: AccountAndIdParam },
  responses: {
    200: { description: 'completed', content: { 'application/json': { schema: CompleteResponse } } },
    ...errorResponses,
  },
});

export const inspectionsApp = new OpenAPIHono();

inspectionsApp.openapi(inspList, async (c) => {
  const { accountId } = c.req.valid('param');
  const { cursor, limit, area_id } = c.req.valid('query');
  const sb = getUserClient(c.get('auth').accessToken);
  let q = sb.from('inspections').select('*').eq('account_id', accountId).is('deleted_at', null);
  if (area_id) q = q.eq('area_id', area_id);
  q = q.order('created_at', { ascending: true }).order('id', { ascending: true }).limit(limit + 1);
  if (cursor) {
    const cur = decodeCursor(cursor);
    if (cur) {
      q = q.or(`created_at.gt.${cur.created_at},and(created_at.eq.${cur.created_at},id.gt.${cur.id})`);
    }
  }
  const { data, error } = await q;
  if (error) throw new ApiError(500, 'database_error', error.message);
  const rows = data ?? [];
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];
  const nextCursor = hasMore && last
    ? encodeCursor({ created_at: String(last.created_at), id: String(last.id) })
    : null;
  return c.json({ data: items, next_cursor: nextCursor } as z.infer<typeof InspectionListResponse>, 200);
});

inspectionsApp.openapi(inspGet, async (c) => {
  const { accountId, id } = c.req.valid('param');
  const sb = getUserClient(c.get('auth').accessToken);
  const { data, error } = await sb.from('inspections').select('*')
    .eq('account_id', accountId).eq('id', id).is('deleted_at', null).maybeSingle();
  if (error) throw new ApiError(500, 'database_error', error.message);
  if (!data) throw new ApiError(404, 'not_found', 'not found');
  return c.json(data as z.infer<typeof Inspection>, 200);
});

inspectionsApp.openapi(inspCreate, async (c) => {
  const { accountId } = c.req.valid('param');
  const body = c.req.valid('json');
  const sb = getUserClient(c.get('auth').accessToken);
  const auth = c.get('auth');
  const { data, error } = await sb.from('inspections').insert({
    account_id: accountId,
    area_id: body.area_id,
    template_id: body.template_id ?? null,
    performed_by: auth.userId,
    performed_at: body.performed_at ?? null,
    notes: body.notes ?? null,
  }).select('*').single();
  if (error) {
    if (error.code === '23503') throw new ApiError(404, 'not_found', 'area_id or template_id does not belong to this account');
    throw new ApiError(500, 'database_error', error.message);
  }
  return c.json(data as z.infer<typeof Inspection>, 201);
});

inspectionsApp.openapi(inspPatch, async (c) => {
  const { accountId, id } = c.req.valid('param');
  const body = c.req.valid('json');
  const sb = getUserClient(c.get('auth').accessToken);
  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (body.template_id !== undefined) update.template_id = body.template_id;
  if (body.performed_at !== undefined) update.performed_at = body.performed_at;
  if (body.notes !== undefined) update.notes = body.notes;
  const { data, error } = await sb.from('inspections').update(update)
    .eq('account_id', accountId).eq('id', id).is('deleted_at', null)
    .select('*').maybeSingle();
  if (error) {
    if (/inspection .* is completed/i.test(error.message)) {
      throw new ApiError(409, 'conflict', 'inspection is completed and cannot be modified');
    }
    throw new ApiError(500, 'database_error', error.message);
  }
  if (!data) throw new ApiError(404, 'not_found', 'not found');
  return c.json(data as z.infer<typeof Inspection>, 200);
});

inspectionsApp.openapi(inspComplete, async (c) => {
  const { accountId, id } = c.req.valid('param');
  const sb = getUserClient(c.get('auth').accessToken);

  // Step 1: set completed_at via the user-client (RLS-scoped). This is the
  // last UPDATE that's allowed -- subsequent PATCHes trip the trigger.
  const completedAt = new Date().toISOString();
  const { data: locked, error: lockErr } = await sb.from('inspections')
    .update({ completed_at: completedAt, updated_at: completedAt })
    .eq('account_id', accountId)
    .eq('id', id)
    .is('deleted_at', null)
    .is('completed_at', null)   // idempotent: a second complete is a no-op match-zero -> 404
    .select('*')
    .maybeSingle();
  if (lockErr) throw new ApiError(500, 'database_error', lockErr.message);
  if (!locked) throw new ApiError(404, 'not_found', 'inspection not found or already completed');

  // Step 2: render + store the report via the admin helper. The function
  // reads inspection / area / items / photos directly and writes one
  // attachment of entity_type='inspection_report'. The PDF is byte-
  // deterministic so re-running produces the SAME content hash.
  const report = await generateAndStoreInspectionReport({
    accountId,
    inspectionId: id,
  });

  return c.json({
    inspection: locked as z.infer<typeof Inspection>,
    report,
  }, 200);
});

// ============================================================================
// inspection_items app (sub-resource of inspections)
// ============================================================================

const itemList = createRoute({
  method: 'get',
  path: '/accounts/{accountId}/inspections/{inspectionId}/items',
  tags: ['inspection_items'],
  request: { params: InspectionParam },
  responses: {
    200: { description: 'items', content: { 'application/json': { schema: ItemListResponse } } },
    ...errorResponses,
  },
});
const itemCreate = createRoute({
  method: 'post',
  path: '/accounts/{accountId}/inspections/{inspectionId}/items',
  tags: ['inspection_items'],
  request: {
    params: InspectionParam,
    body: { content: { 'application/json': { schema: CreateItemBody } }, required: true },
  },
  responses: {
    201: { description: 'created', content: { 'application/json': { schema: InspectionItem } } },
    ...errorResponses,
  },
});
const itemPatch = createRoute({
  method: 'patch',
  path: '/accounts/{accountId}/inspections/{inspectionId}/items/{id}',
  tags: ['inspection_items'],
  request: {
    params: InspectionAndItemParam,
    body: { content: { 'application/json': { schema: PatchItemBody } }, required: true },
  },
  responses: {
    200: { description: 'updated', content: { 'application/json': { schema: InspectionItem } } },
    ...errorResponses,
  },
});
const itemRemove = createRoute({
  method: 'delete',
  path: '/accounts/{accountId}/inspections/{inspectionId}/items/{id}',
  tags: ['inspection_items'],
  summary: 'Soft-delete an inspection item (rejected with 409 if the parent inspection is completed)',
  request: { params: InspectionAndItemParam },
  responses: {
    204: { description: 'deleted' },
    ...errorResponses,
  },
});

export const inspectionItemsApp = new OpenAPIHono();

inspectionItemsApp.openapi(itemList, async (c) => {
  const { accountId, inspectionId } = c.req.valid('param');
  const sb = getUserClient(c.get('auth').accessToken);
  const { data, error } = await sb.from('inspection_items')
    .select('*')
    .eq('account_id', accountId)
    .eq('inspection_id', inspectionId)
    .is('deleted_at', null)
    .order('created_at', { ascending: true });
  if (error) throw new ApiError(500, 'database_error', error.message);
  return c.json({ data: (data ?? []) as z.infer<typeof InspectionItem>[] }, 200);
});

inspectionItemsApp.openapi(itemCreate, async (c) => {
  const { accountId, inspectionId } = c.req.valid('param');
  const body = c.req.valid('json');
  const sb = getUserClient(c.get('auth').accessToken);
  const { data, error } = await sb.from('inspection_items').insert({
    account_id: accountId,
    inspection_id: inspectionId,
    label: body.label,
    condition: body.condition ?? null,
    notes: body.notes ?? null,
  }).select('*').single();
  if (error) {
    if (/parent inspection .* is completed/i.test(error.message)) {
      throw new ApiError(409, 'conflict', 'parent inspection is completed; items are immutable');
    }
    if (error.code === '23503') throw new ApiError(404, 'not_found', 'inspection not found in this account');
    throw new ApiError(500, 'database_error', error.message);
  }
  return c.json(data as z.infer<typeof InspectionItem>, 201);
});

inspectionItemsApp.openapi(itemPatch, async (c) => {
  const { accountId, inspectionId, id } = c.req.valid('param');
  const body = c.req.valid('json');
  const sb = getUserClient(c.get('auth').accessToken);
  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (body.label !== undefined) update.label = body.label;
  if (body.condition !== undefined) update.condition = body.condition;
  if (body.notes !== undefined) update.notes = body.notes;
  const { data, error } = await sb.from('inspection_items').update(update)
    .eq('account_id', accountId)
    .eq('inspection_id', inspectionId)
    .eq('id', id)
    .is('deleted_at', null)
    .select('*').maybeSingle();
  if (error) {
    if (/parent inspection .* is completed/i.test(error.message)) {
      throw new ApiError(409, 'conflict', 'parent inspection is completed; items are immutable');
    }
    throw new ApiError(500, 'database_error', error.message);
  }
  if (!data) throw new ApiError(404, 'not_found', 'not found');
  return c.json(data as z.infer<typeof InspectionItem>, 200);
});

inspectionItemsApp.openapi(itemRemove, async (c) => {
  const { accountId, inspectionId, id } = c.req.valid('param');
  const sb = getUserClient(c.get('auth').accessToken);
  const { data, error } = await sb.from('inspection_items')
    .update({ deleted_at: new Date().toISOString() })
    .eq('account_id', accountId)
    .eq('inspection_id', inspectionId)
    .eq('id', id)
    .is('deleted_at', null)
    .select('id')
    .maybeSingle();
  if (error) {
    if (/parent inspection .* is completed/i.test(error.message)) {
      throw new ApiError(409, 'conflict', 'parent inspection is completed; items are immutable');
    }
    throw new ApiError(500, 'database_error', error.message);
  }
  if (!data) throw new ApiError(404, 'not_found', 'not found');
  return c.body(null, 204);
});
