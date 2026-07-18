import { createRoute, z } from '@hono/zod-openapi';
import { newApiApp } from '../_lib/app';
import { getSb } from '../../supabase/request-client';
import { asJson, type DbTableUpdate } from '../../supabase/db-types';
import { ApiError, errorResponses } from '../_lib/error';
import { keysetPage } from '../_lib/cursor';
import { softDeleteStamp } from '../_lib/soft-delete';
import {
  listInspectionTemplateCatalog,
  getInspectionTemplateCatalog,
} from '../../admin/inspection-template-catalog';
import {
  InspectionTemplate,
  CreateTemplateBody,
  PatchTemplateBody,
  AccountParam,
  AccountAndIdParam,
  ListQuery,
  TemplateListResponse,
} from './shared';

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
    200: {
      description: 'template',
      content: { 'application/json': { schema: InspectionTemplate } },
    },
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
    201: {
      description: 'created',
      content: { 'application/json': { schema: InspectionTemplate } },
    },
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
    200: {
      description: 'updated',
      content: { 'application/json': { schema: InspectionTemplate } },
    },
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

export const inspectionTemplatesApp = newApiApp();

inspectionTemplatesApp.openapi(tplList, async (c) => {
  const { accountId } = c.req.valid('param');
  const { cursor, limit } = c.req.valid('query');
  const sb = getSb(c);
  const q = sb
    .from('inspection_templates')
    .select('*')
    .eq('account_id', accountId)
    .is('deleted_at', null);
  const { items, next_cursor: nextCursor } = await keysetPage(q, { cursor, limit });
  return c.json(
    { data: items, next_cursor: nextCursor } as z.infer<typeof TemplateListResponse>,
    200,
  );
});

inspectionTemplatesApp.openapi(tplGet, async (c) => {
  const { accountId, id } = c.req.valid('param');
  const sb = getSb(c);
  const { data, error } = await sb
    .from('inspection_templates')
    .select('*')
    .eq('account_id', accountId)
    .eq('id', id)
    .is('deleted_at', null)
    .maybeSingle();
  if (error) throw new ApiError(500, 'database_error', error.message);
  if (!data) throw new ApiError(404, 'not_found', 'not found');
  return c.json(data as z.infer<typeof InspectionTemplate>, 200);
});

inspectionTemplatesApp.openapi(tplCreate, async (c) => {
  const { accountId } = c.req.valid('param');
  const body = c.req.valid('json');
  const sb = getSb(c);
  const { data, error } = await sb
    .from('inspection_templates')
    .insert({
      account_id: accountId,
      name: body.name,
      schema: asJson(body.schema ?? {}),
    })
    .select('*')
    .single();
  if (error) throw new ApiError(500, 'database_error', error.message);
  return c.json(data as z.infer<typeof InspectionTemplate>, 201);
});

inspectionTemplatesApp.openapi(tplPatch, async (c) => {
  const { accountId, id } = c.req.valid('param');
  const body = c.req.valid('json');
  const sb = getSb(c);
  const update: DbTableUpdate<'inspection_templates'> = { updated_at: new Date().toISOString() };
  if (body.name !== undefined) update.name = body.name;
  if (body.schema !== undefined) update.schema = asJson(body.schema);
  const { data, error } = await sb
    .from('inspection_templates')
    .update(update)
    .eq('account_id', accountId)
    .eq('id', id)
    .is('deleted_at', null)
    .select('*')
    .maybeSingle();
  if (error) throw new ApiError(500, 'database_error', error.message);
  if (!data) throw new ApiError(404, 'not_found', 'not found');
  return c.json(data as z.infer<typeof InspectionTemplate>, 200);
});

inspectionTemplatesApp.openapi(tplRemove, async (c) => {
  const { accountId, id } = c.req.valid('param');
  const sb = getSb(c);
  const { data, error } = await sb
    .from('inspection_templates')
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

// ----- bundled starter template catalog -------------------------------------

const CatalogItem = z
  .object({
    id: z.string(),
    name: z.string(),
    jurisdiction: z.string().nullable(),
    version: z.string(),
    section_count: z.number().int(),
  })
  .openapi('InspectionTemplateCatalogItem');
const CatalogListResponse = z
  .object({ data: z.array(CatalogItem) })
  .openapi('InspectionTemplateCatalogList');
const FromCatalogBody = z
  .object({
    catalog_id: z.string().min(1).max(100),
    name: z.string().min(1).max(200).optional(),
  })
  .openapi('CreateInspectionTemplateFromCatalogBody');

const catalogListRoute = createRoute({
  method: 'get',
  path: '/accounts/{accountId}/inspection-template-catalog',
  tags: ['inspection_templates'],
  summary: 'List bundled starter inspection templates',
  request: { params: AccountParam },
  responses: {
    200: {
      description: 'catalog',
      content: { 'application/json': { schema: CatalogListResponse } },
    },
    ...errorResponses,
  },
});
inspectionTemplatesApp.openapi(catalogListRoute, async (c) => {
  return c.json({ data: listInspectionTemplateCatalog() }, 200);
});

const fromCatalogRoute = createRoute({
  method: 'post',
  path: '/accounts/{accountId}/inspection-templates/from-catalog',
  tags: ['inspection_templates'],
  summary: 'Clone a bundled starter template into this account',
  request: {
    params: AccountParam,
    body: { content: { 'application/json': { schema: FromCatalogBody } }, required: true },
  },
  responses: {
    201: {
      description: 'created',
      content: { 'application/json': { schema: InspectionTemplate } },
    },
    ...errorResponses,
  },
});
inspectionTemplatesApp.openapi(fromCatalogRoute, async (c) => {
  const { accountId } = c.req.valid('param');
  const body = c.req.valid('json');
  const tpl = getInspectionTemplateCatalog(body.catalog_id);
  if (!tpl) throw new ApiError(404, 'not_found', 'catalog template not found');
  const sb = getSb(c);
  const { data, error } = await sb
    .from('inspection_templates')
    .insert({
      account_id: accountId,
      name: body.name ?? tpl.name,
      jurisdiction: tpl.jurisdiction,
      version: tpl.version,
      // Server-set provenance: this row was cloned from a bundled catalog form.
      catalog_id: tpl.id,
      schema: asJson(tpl.schema),
    })
    .select('*')
    .single();
  if (error) throw new ApiError(500, 'database_error', error.message);
  return c.json(data as z.infer<typeof InspectionTemplate>, 201);
});

// ============================================================================
// inspections app
// ============================================================================
