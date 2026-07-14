import { createRoute, z } from '@hono/zod-openapi';
import { newApiApp } from './_lib/app';
import { getSb } from '../supabase/request-client';
import { asJson, type DbTableUpdate } from '../supabase/db-types';
import { ApiError, conflictResponse, errorResponses } from './_lib/error';
import { keysetPage } from './_lib/cursor';
import { softDeleteStamp } from './_lib/soft-delete';
import { generateAndStoreInspectionReport } from '../admin/pdf';
import {
  generateCaptureSecret,
  hashCaptureSecret,
  DEFAULT_CAPTURE_TTL_MIN,
  MAX_CAPTURE_TTL_MIN,
} from '../admin/inspection-capture';
import {
  listInspectionTemplateCatalog,
  getInspectionTemplateCatalog,
} from '../admin/inspection-template-catalog';

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
    jurisdiction: z.string().nullable(),
    version: z.string().nullable(),
    // Provenance of a catalog-cloned template; server-set, never client-writable.
    catalog_id: z.string().nullable(),
    schema: z.record(z.unknown()),
    // Canonical md5(schema::text); DB-generated, drifts iff schema changes.
    schema_hash: z.string().nullable(),
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
    kind: z.string(),
    tenancy_id: z.string().uuid().nullable(),
    baseline_inspection_id: z.string().uuid().nullable(),
    status: z.string(),
    capture_mode: z.string(),
    supersedes_inspection_id: z.string().uuid().nullable(),
    voided_at: z.string().nullable(),
    void_reason: z.string().nullable(),
    template_snapshot: z.record(z.unknown()).nullable(),
    subject_snapshot: z.record(z.unknown()).nullable(),
    // Engagement-funnel timestamps (real columns; nested under `engagement` on
    // the detail response too -- see InspectionDetail).
    link_delivered_at: z.string().nullable(),
    form_opened_at: z.string().nullable(),
    form_started_at: z.string().nullable(),
    submitted_at: z.string().nullable(),
    created_at: z.string(),
    updated_at: z.string(),
    deleted_at: z.string().nullable(),
  })
  .openapi('Inspection');

// Tenant-engagement funnel, surfaced on the inspection DETAIL read only. The
// four timestamps mirror the columns above; rooms_done / rooms_total are DERIVED
// (see the detail handler) so they can't drift. Always present (never null),
// so the FE never null-guards the object -- only individual timestamps are null
// before the corresponding step happens.
const InspectionEngagement = z
  .object({
    link_delivered_at: z.string().nullable(),
    form_opened_at: z.string().nullable(),
    form_started_at: z.string().nullable(),
    submitted_at: z.string().nullable(),
    rooms_done: z.number().int(),
    rooms_total: z.number().int(),
  })
  .openapi('InspectionEngagement');

// Strict superset of Inspection: because Inspection is a registered schema,
// zod-to-openapi emits this as `allOf: [Inspection, { engagement }]`, so the two
// can never drift and every existing GET /inspections/{id} consumer stays valid.
const InspectionDetail = Inspection.extend({
  engagement: InspectionEngagement,
}).openapi('InspectionDetail');

const InspectionKind = z.enum(['move_in', 'move_out', 'periodic', 'general']);
const CaptureMode = z.enum(['landlord', 'tenant', 'collaborative']);
const ChangeType = z.enum([
  'unchanged',
  'normal_wear',
  'damage',
  'not_present_at_baseline',
  'new_at_checkout',
]);

const CreateInspectionBody = z
  .object({
    area_id: z.string().uuid(),
    template_id: z.string().uuid().optional(),
    performed_at: z.string().datetime().optional(),
    notes: z.string().max(20000).optional(),
    kind: InspectionKind.optional(),
    tenancy_id: z.string().uuid().optional(),
    baseline_inspection_id: z.string().uuid().optional(),
    capture_mode: CaptureMode.optional(),
  })
  .openapi('CreateInspectionBody');

// Authoritative setup accepted by the transactional creation path. These are
// deliberately setup fields only: an inspection starts unanswered, without
// evidence or condition data. The final mode lets the Create screen send its
// trimmed scratchpad directly instead of seed -> upsert -> serial delete.
const CreateInspectionFromTemplateItem = z
  .object({
    item_key: z.string().min(1).max(200),
    label: z.string().min(1).max(200),
    group_label: z.string().min(1).max(200).optional(),
    sort_order: z.number().int().min(-2147483648).max(2147483647).optional(),
  })
  .openapi('CreateInspectionFromTemplateItem');

const CreateInspectionFromTemplateCheck = z
  .object({
    field_key: z.string().min(1).max(200),
    label: z.string().min(1).max(200),
    group_label: z.string().min(1).max(200).optional(),
    sort_order: z.number().int().min(-2147483648).max(2147483647).optional(),
    input_kind: z.enum(['boolean', 'count', 'text']).optional(),
  })
  .openapi('CreateInspectionFromTemplateCheck');

const CreateInspectionFromTemplateSetup = z
  .discriminatedUnion('mode', [
    z.object({
      mode: z.literal('final'),
      items: z.array(CreateInspectionFromTemplateItem).min(1).max(1000),
      checks: z.array(CreateInspectionFromTemplateCheck).max(1000),
    }),
    // Compatibility escape hatch for template schemas a client cannot render.
    // The server copies the complete template in the same transaction.
    z.object({ mode: z.literal('template') }),
  ])
  .openapi('CreateInspectionFromTemplateSetup');

const CreateInspectionFromTemplateBody = z
  .object({
    area_id: z.string().uuid(),
    tenancy_id: z.string().uuid().optional(),
    kind: InspectionKind,
    capture_mode: CaptureMode,
    template_id: z.string().uuid(),
    template_schema_hash: z.string().regex(/^[a-f0-9]{32}$/),
    performed_at: z.string().datetime().optional(),
    notes: z.string().max(20000).optional(),
    setup: CreateInspectionFromTemplateSetup,
  })
  .openapi('CreateInspectionFromTemplateBody');

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
    item_key: z.string().nullable(),
    group_label: z.string().nullable(),
    change_type: z.string().nullable(),
    sort_order: z.number().int().nullable(),
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
    item_key: z.string().min(1).max(200).optional(),
    group_label: z.string().min(1).max(200).optional(),
    change_type: ChangeType.optional(),
    sort_order: z.number().int().optional(),
  })
  .openapi('CreateInspectionItemBody');

const PatchItemBody = z
  .object({
    label: z.string().min(1).max(200).optional(),
    condition: z.string().nullable().optional(),
    notes: z.string().nullable().optional(),
    item_key: z.string().min(1).max(200).nullable().optional(),
    group_label: z.string().min(1).max(200).nullable().optional(),
    change_type: ChangeType.nullable().optional(),
    sort_order: z.number().int().nullable().optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: 'at least one field is required' })
  .openapi('PatchInspectionItemBody');

// --- inspection_checks (typed yes/no, scalar, count fields) -----------------

const InspectionCheck = z
  .object({
    id: z.string().uuid(),
    account_id: z.string().uuid(),
    inspection_id: z.string().uuid(),
    field_key: z.string(),
    label: z.string(),
    group_label: z.string().nullable(),
    value: z.unknown(),
    sort_order: z.number().int().nullable(),
    // Rendering hint carried from the template catalog ('boolean' | 'count' |
    // 'text'); null = legacy/unknown -> clients fall back to Yes/No.
    input_kind: z.string().nullable(),
    answered_by: z.string().uuid().nullable(),
    answered_at: z.string().nullable(),
    created_at: z.string(),
    updated_at: z.string(),
    deleted_at: z.string().nullable(),
  })
  .openapi('InspectionCheck');

const UpsertChecksBody = z
  .object({
    checks: z
      .array(
        z.object({
          field_key: z.string().min(1).max(200),
          label: z.string().min(1).max(200).optional(),
          group_label: z.string().min(1).max(200).optional(),
          value: z.unknown().optional(),
          sort_order: z.number().int().optional(),
          input_kind: z.enum(['boolean', 'count', 'text']).optional(),
        }),
      )
      .min(1)
      .max(1000),
  })
  .openapi('UpsertInspectionChecksBody');

const BatchItemsBody = z
  .object({
    items: z
      .array(
        z.object({
          item_key: z.string().min(1).max(200),
          label: z.string().min(1).max(200).optional(),
          condition: z.string().max(200).optional(),
          notes: z.string().max(5000).optional(),
          group_label: z.string().min(1).max(200).optional(),
          change_type: ChangeType.optional(),
          sort_order: z.number().int().optional(),
        }),
      )
      .min(1)
      .max(1000),
  })
  .openapi('BatchInspectionItemsBody');

const SeedFromTemplateBody = z
  .object({ template_id: z.string().uuid().optional() })
  .openapi('SeedInspectionFromTemplateBody');

const StartCheckoutBody = z
  .object({
    performed_at: z.string().datetime().optional(),
    template_id: z.string().uuid().optional(),
    notes: z.string().max(20000).optional(),
  })
  .openapi('StartCheckoutBody');

const VoidInspectionBody = z
  .object({ reason: z.string().min(1).max(2000) })
  .openapi('VoidInspectionBody');

const SeededRows = z
  .object({ items: z.array(InspectionItem), checks: z.array(InspectionCheck) })
  .openapi('SeededInspectionRows');

const CheckListResponse = z
  .object({ data: z.array(InspectionCheck) })
  .openapi('InspectionCheckListResponse');

const DiffRow = z
  .object({
    row_type: z.string(),
    key: z.string().nullable(),
    group_label: z.string().nullable(),
    label: z.string().nullable(),
    baseline_id: z.string().uuid().nullable(),
    checkout_id: z.string().uuid().nullable(),
    baseline_value: z.string().nullable(),
    checkout_value: z.string().nullable(),
    change_type: z.string().nullable(),
    status: z.string(),
    baseline_photo_count: z.number().int(),
    checkout_photo_count: z.number().int(),
  })
  .openapi('InspectionCheckoutDiffRow');

const DiffResponse = z.object({ data: z.array(DiffRow) }).openapi('InspectionCheckoutDiffResponse');

// Maps a SECURITY INVOKER RPC's pg error to the HTTP envelope. RLS denials
// (42501) surface as 404 so we never leak existence to a non-member.
function rpcError(error: { code?: string; message: string }): ApiError {
  if (error.code === 'P0002') return new ApiError(404, 'not_found', error.message);
  if (error.code === '23503') return new ApiError(404, 'not_found', error.message);
  if (error.code === '42501') return new ApiError(404, 'not_found', 'not found');
  if (error.code === '23514') return new ApiError(409, 'conflict', error.message);
  if (error.code === '23505') return new ApiError(409, 'conflict', error.message);
  return new ApiError(500, 'database_error', error.message);
}

// --- params ------------------------------------------------------------------

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
const InspectionAndItemParam = z.object({
  accountId: z
    .string()
    .uuid()
    .openapi({ param: { name: 'accountId', in: 'path' } }),
  inspectionId: z
    .string()
    .uuid()
    .openapi({ param: { name: 'inspectionId', in: 'path' } }),
  id: z
    .string()
    .uuid()
    .openapi({ param: { name: 'id', in: 'path' } }),
});
const InspectionParam = z.object({
  accountId: z
    .string()
    .uuid()
    .openapi({ param: { name: 'accountId', in: 'path' } }),
  inspectionId: z
    .string()
    .uuid()
    .openapi({ param: { name: 'inspectionId', in: 'path' } }),
});
const InspectionAndCheckParam = z.object({
  accountId: z
    .string()
    .uuid()
    .openapi({ param: { name: 'accountId', in: 'path' } }),
  id: z
    .string()
    .uuid()
    .openapi({ param: { name: 'id', in: 'path' } }),
  checkId: z
    .string()
    .uuid()
    .openapi({ param: { name: 'checkId', in: 'path' } }),
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
    // present only for move_in/move_out (which emit a tenant-facing document).
    document: z.record(z.unknown()).nullable(),
    document_version: z.record(z.unknown()).nullable(),
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

const inspList = createRoute({
  method: 'get',
  path: '/accounts/{accountId}/inspections',
  tags: ['inspections'],
  request: { params: AccountParam, query: InspectionListQuery },
  responses: {
    200: {
      description: 'page',
      content: { 'application/json': { schema: InspectionListResponse } },
    },
    ...errorResponses,
  },
});
const inspGet = createRoute({
  method: 'get',
  path: '/accounts/{accountId}/inspections/{id}',
  tags: ['inspections'],
  request: { params: AccountAndIdParam },
  responses: {
    200: {
      description: 'inspection',
      content: { 'application/json': { schema: InspectionDetail } },
    },
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
const inspCreateFromTemplate = createRoute({
  method: 'post',
  path: '/accounts/{accountId}/inspections/from-template',
  tags: ['inspections'],
  summary: 'Create a fully prepared inspection from the final trimmed template setup',
  description:
    'Creates the inspection, items, and checks in one transaction. The template schema hash prevents a stale Create-screen scratchpad from silently overwriting a newer template. Capture links remain a separate Share-step operation.',
  request: {
    params: AccountParam,
    body: {
      content: { 'application/json': { schema: CreateInspectionFromTemplateBody } },
      required: true,
    },
  },
  responses: {
    201: {
      description: 'fully prepared inspection',
      content: { 'application/json': { schema: InspectionDetail } },
    },
    ...conflictResponse,
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
  summary:
    'Mark an inspection complete; locks it AND stores the rendered PDF as a content-hashed attachment',
  request: { params: AccountAndIdParam },
  responses: {
    200: {
      description: 'completed',
      content: { 'application/json': { schema: CompleteResponse } },
    },
    ...errorResponses,
  },
});

export const inspectionsApp = newApiApp();

inspectionsApp.openapi(inspList, async (c) => {
  const { accountId } = c.req.valid('param');
  const { cursor, limit, area_id } = c.req.valid('query');
  const sb = getSb(c);
  let q = sb.from('inspections').select('*').eq('account_id', accountId).is('deleted_at', null);
  if (area_id) q = q.eq('area_id', area_id);
  const { items, next_cursor: nextCursor } = await keysetPage(q, { cursor, limit });
  return c.json(
    { data: items, next_cursor: nextCursor } as z.infer<typeof InspectionListResponse>,
    200,
  );
});

inspectionsApp.openapi(inspCreateFromTemplate, async (c) => {
  const { accountId } = c.req.valid('param');
  const body = c.req.valid('json');
  const claim = c.get('idempotencyClaim');
  if (!claim) {
    // Every account-scoped mutation reaches the idempotency middleware first.
    // Failing closed here protects the RPC's atomic retry guarantee if route
    // mounting is ever changed accidentally.
    throw new ApiError(500, 'database_error', 'idempotency claim is unavailable');
  }

  const sb = getSb(c);
  const { data, error } = await sb.rpc('create_inspection_from_template', {
    p_account_id: accountId,
    p_idempotency_key: claim.key,
    p_request_fingerprint: claim.fingerprint,
    p_payload: asJson(body),
  });
  if (error) {
    if (/template_schema_(?:changed|mismatch)/i.test(error.message)) {
      throw new ApiError(
        409,
        'template_changed',
        'the inspection template changed; refresh the Create screen and review it again',
      );
    }
    if (error.code === 'P0002' || error.code === '23503' || error.code === '42501') {
      throw new ApiError(404, 'not_found', 'area, tenancy, or template not found');
    }
    if (
      error.code === '23514' ||
      error.code === '23505' ||
      error.code === '22023' ||
      error.code === '22P02' ||
      error.code === '22003'
    ) {
      throw new ApiError(400, 'invalid_request', error.message);
    }
    throw new ApiError(500, 'database_error', error.message);
  }
  if (!data || Array.isArray(data)) {
    throw new ApiError(500, 'database_error', 'create_inspection_from_template returned no detail');
  }
  c.set('idempotencyCompletedAtomically', true);
  return c.json(data as z.infer<typeof InspectionDetail>, 201);
});

inspectionsApp.openapi(inspGet, async (c) => {
  const { accountId, id } = c.req.valid('param');
  const sb = getSb(c);
  const { data, error } = await sb
    .from('inspections')
    .select('*')
    .eq('account_id', accountId)
    .eq('id', id)
    .is('deleted_at', null)
    .maybeSingle();
  if (error) throw new ApiError(500, 'database_error', error.message);
  if (!data) throw new ApiError(404, 'not_found', 'not found');

  // Room progress is DERIVED (never stored) so it can't drift. Each distinct
  // item group_label is a room; items with a null/empty group_label fold into a
  // single "ungrouped" bucket (the FE shows it as "General"), keyed by a Symbol
  // so it can't collide with a real label. A room counts toward rooms_done when
  // the tenant did SOMETHING in it -- >=1 item with a condition, OR a matching
  // "confirmed good" row (a null-group confirmation targets the ungrouped
  // bucket). Iterating the room set bounds rooms_done <= rooms_total, so a stray
  // confirmation for a room with no items can't inflate it. Two small,
  // inspection-scoped queries on this low-QPS read.
  const UNGROUPED: unique symbol = Symbol('ungrouped');
  type RoomKey = string | typeof UNGROUPED;
  const roomKey = (g: string | null): RoomKey => (g == null || g === '' ? UNGROUPED : g);
  const [itemsRes, confirmsRes] = await Promise.all([
    sb
      .from('inspection_items')
      .select('group_label, condition')
      .eq('account_id', accountId)
      .eq('inspection_id', id)
      .is('deleted_at', null),
    sb
      .from('inspection_room_confirmations')
      .select('group_label')
      .eq('account_id', accountId)
      .eq('inspection_id', id)
      .is('deleted_at', null),
  ]);
  if (itemsRes.error) throw new ApiError(500, 'database_error', itemsRes.error.message);
  if (confirmsRes.error) throw new ApiError(500, 'database_error', confirmsRes.error.message);

  const roomsTotal = new Set<RoomKey>();
  const roomsWithContent = new Set<RoomKey>();
  for (const it of itemsRes.data ?? []) {
    const key = roomKey(it.group_label as string | null);
    roomsTotal.add(key);
    if (it.condition != null) roomsWithContent.add(key);
  }
  const confirmed = new Set<RoomKey>(
    (confirmsRes.data ?? []).map((r) => roomKey(r.group_label as string | null)),
  );
  let roomsDone = 0;
  for (const key of roomsTotal) {
    if (roomsWithContent.has(key) || confirmed.has(key)) roomsDone += 1;
  }

  const row = data as Record<string, unknown>;
  const detail = {
    ...row,
    engagement: {
      link_delivered_at: (row.link_delivered_at as string | null) ?? null,
      form_opened_at: (row.form_opened_at as string | null) ?? null,
      form_started_at: (row.form_started_at as string | null) ?? null,
      submitted_at: (row.submitted_at as string | null) ?? null,
      rooms_done: roomsDone,
      rooms_total: roomsTotal.size,
    },
  };
  return c.json(detail as z.infer<typeof InspectionDetail>, 200);
});

inspectionsApp.openapi(inspCreate, async (c) => {
  const { accountId } = c.req.valid('param');
  const body = c.req.valid('json');
  const sb = getSb(c);
  const auth = c.get('auth');
  const { data, error } = await sb
    .from('inspections')
    .insert({
      account_id: accountId,
      area_id: body.area_id,
      template_id: body.template_id ?? null,
      kind: body.kind ?? 'general',
      tenancy_id: body.tenancy_id ?? null,
      baseline_inspection_id: body.baseline_inspection_id ?? null,
      capture_mode: body.capture_mode ?? 'landlord',
      performed_by: auth.userId,
      performed_at: body.performed_at ?? null,
      notes: body.notes ?? null,
    })
    .select('*')
    .single();
  if (error) {
    // coherence trigger (kind/tenancy/area/baseline mismatch) raises check_violation.
    if (error.code === '23514') throw new ApiError(400, 'invalid_request', error.message);
    if (error.code === '23503')
      throw new ApiError(
        404,
        'not_found',
        'area_id, template_id, tenancy_id or baseline_inspection_id does not belong to this account',
      );
    throw new ApiError(500, 'database_error', error.message);
  }
  return c.json(data as z.infer<typeof Inspection>, 201);
});

inspectionsApp.openapi(inspPatch, async (c) => {
  const { accountId, id } = c.req.valid('param');
  const body = c.req.valid('json');
  const sb = getSb(c);
  const update: DbTableUpdate<'inspections'> = { updated_at: new Date().toISOString() };
  if (body.template_id !== undefined) update.template_id = body.template_id;
  if (body.performed_at !== undefined) update.performed_at = body.performed_at;
  if (body.notes !== undefined) update.notes = body.notes;
  const { data, error } = await sb
    .from('inspections')
    .update(update)
    .eq('account_id', accountId)
    .eq('id', id)
    .is('deleted_at', null)
    .select('*')
    .maybeSingle();
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
  const sb = getSb(c);

  // Build the frozen snapshots BEFORE the lock: the completion-lock trigger
  // forbids changing template_snapshot/subject_snapshot afterward, so they must
  // land atomically with completed_at. Only needed on the FIRST completion (a
  // retry finds completed_at already set and skips the lock update entirely).
  let templateSnapshot: Record<string, unknown> | null = null;
  let subjectSnapshot: Record<string, unknown> | null = null;
  const { data: pre, error: preErr } = await sb
    .from('inspections')
    .select('area_id, template_id, tenancy_id')
    .eq('account_id', accountId)
    .eq('id', id)
    .is('deleted_at', null)
    .is('completed_at', null)
    .maybeSingle();
  if (preErr) throw new ApiError(500, 'database_error', preErr.message);
  if (pre) {
    const p = pre as { area_id: string; template_id: string | null; tenancy_id: string | null };
    if (p.template_id) {
      const tpl = await sb
        .from('inspection_templates')
        .select('id, name, jurisdiction, version, catalog_id, schema_hash, schema')
        .eq('account_id', accountId)
        .eq('id', p.template_id)
        .maybeSingle();
      templateSnapshot = (tpl.data as Record<string, unknown> | null) ?? null;
    }
    const area = await sb
      .from('areas')
      .select('id, name, kind, property_id, properties(name, address)')
      .eq('account_id', accountId)
      .eq('id', p.area_id)
      .maybeSingle();
    subjectSnapshot = { area: (area.data as unknown) ?? null, tenancy: null as unknown };
    if (p.tenancy_id) {
      const ten = await sb
        .from('tenancies')
        .select('id, start_date, end_date, status')
        .eq('account_id', accountId)
        .eq('id', p.tenancy_id)
        .maybeSingle();
      subjectSnapshot.tenancy = (ten.data as unknown) ?? null;
    }
  }

  // Step 1: set completed_at + status + snapshots via the user-client
  // (RLS-scoped). This is the last report-data-relevant UPDATE the trigger allows.
  const completedAt = new Date().toISOString();
  const { data: locked, error: lockErr } = await sb
    .from('inspections')
    .update({
      completed_at: completedAt,
      status: 'completed',
      updated_at: completedAt,
      template_snapshot: asJson(templateSnapshot),
      subject_snapshot: asJson(subjectSnapshot),
    })
    .eq('account_id', accountId)
    .eq('id', id)
    .is('deleted_at', null)
    .is('completed_at', null)
    .neq('status', 'voided')
    .select('*')
    .maybeSingle();
  if (lockErr) throw new ApiError(500, 'database_error', lockErr.message);

  // Retry-safe: if we didn't win the lock the inspection may ALREADY be
  // completed (a prior call crashed after the lock but before emitting the
  // document). Re-fetch and continue idempotently rather than 404 the retry --
  // report-gen and document-emission are both idempotent.
  let inspection = locked as z.infer<typeof Inspection> | null;
  if (!inspection) {
    const { data: existing, error: exErr } = await sb
      .from('inspections')
      .select('*')
      .eq('account_id', accountId)
      .eq('id', id)
      .is('deleted_at', null)
      .maybeSingle();
    if (exErr) throw new ApiError(500, 'database_error', exErr.message);
    const ex = existing as z.infer<typeof Inspection> | null;
    if (!ex || !ex.completed_at || ex.status === 'voided') {
      throw new ApiError(404, 'not_found', 'inspection not found or not completable');
    }
    inspection = ex;
  }

  // Step 2: render + store the report (idempotent on content hash).
  const report = await generateAndStoreInspectionReport({ accountId, inspectionId: id });

  // Step 3: move-in/out reports become tenant-facing documents so the existing
  // magic-link review + acknowledge flow is the tenant sign-off surface.
  let document: Record<string, unknown> | null = null;
  let documentVersion: Record<string, unknown> | null = null;
  if (inspection.kind === 'move_in' || inspection.kind === 'move_out') {
    const title =
      inspection.kind === 'move_in' ? 'Move-in condition report' : 'Move-out condition report';
    const { data: emitted, error: emitErr } = await sb.rpc('emit_inspection_report_document', {
      p_account_id: accountId,
      p_inspection_id: id,
      p_attachment_id: report.attachment_id,
      p_content_hash: report.content_hash,
      p_size_bytes: report.size_bytes,
      p_title: title,
      p_requires_ack: true,
    });
    if (emitErr) throw rpcError(emitErr);
    const row = (Array.isArray(emitted) ? emitted[0] : emitted) as {
      document: Record<string, unknown>;
      version: Record<string, unknown>;
    } | null;
    document = row?.document ?? null;
    documentVersion = row?.version ?? null;
  }

  return c.json({ inspection, report, document, document_version: documentVersion }, 200);
});

// ----- condition-report actions (on inspectionsApp) -------------------------

const seedRoute = createRoute({
  method: 'post',
  path: '/accounts/{accountId}/inspections/{id}/seed-from-template',
  tags: ['inspections'],
  summary: 'Instantiate items + checks from the inspection (or given) template',
  request: {
    params: AccountAndIdParam,
    body: { content: { 'application/json': { schema: SeedFromTemplateBody } }, required: true },
  },
  responses: {
    200: { description: 'seeded', content: { 'application/json': { schema: SeededRows } } },
    ...errorResponses,
  },
});
inspectionsApp.openapi(seedRoute, async (c) => {
  const { accountId, id } = c.req.valid('param');
  const body = c.req.valid('json');
  const sb = getSb(c);
  const { data, error } = await sb.rpc('seed_inspection_items_from_template', {
    p_account_id: accountId,
    p_inspection_id: id,
    p_template_id: body.template_id,
  });
  if (error) throw rpcError(error);
  return c.json((data ?? { items: [], checks: [] }) as z.infer<typeof SeededRows>, 200);
});

const startCheckoutRoute = createRoute({
  method: 'post',
  path: '/accounts/{accountId}/inspections/{id}/start-checkout',
  tags: ['inspections'],
  summary: 'Start a move-out inspection pre-keyed from this completed check-in',
  request: {
    params: AccountAndIdParam,
    body: { content: { 'application/json': { schema: StartCheckoutBody } }, required: true },
  },
  responses: {
    201: { description: 'created', content: { 'application/json': { schema: Inspection } } },
    ...errorResponses,
  },
});
inspectionsApp.openapi(startCheckoutRoute, async (c) => {
  const { accountId, id } = c.req.valid('param');
  const body = c.req.valid('json');
  const sb = getSb(c);
  const { data, error } = await sb.rpc('start_checkout_from_checkin', {
    p_account_id: accountId,
    p_baseline_inspection_id: id,
    p_performed_at: body.performed_at,
    p_template_id: body.template_id,
    p_notes: body.notes,
  });
  if (error) throw rpcError(error);
  const row = (Array.isArray(data) ? data[0] : data) as z.infer<typeof Inspection> | null;
  if (!row) throw new ApiError(500, 'database_error', 'no inspection returned');
  return c.json(row, 201);
});

const diffRoute = createRoute({
  method: 'get',
  path: '/accounts/{accountId}/inspections/{id}/checkout-diff',
  tags: ['inspections'],
  summary: 'Item + check diff of a move-out vs its baseline check-in',
  request: { params: AccountAndIdParam },
  responses: {
    200: { description: 'diff', content: { 'application/json': { schema: DiffResponse } } },
    ...errorResponses,
  },
});
inspectionsApp.openapi(diffRoute, async (c) => {
  const { accountId, id } = c.req.valid('param');
  const sb = getSb(c);
  const { data, error } = await sb.rpc('inspection_checkout_diff', {
    p_account_id: accountId,
    p_checkout_inspection_id: id,
  });
  if (error) throw rpcError(error);
  return c.json({ data: (data ?? []) as z.infer<typeof DiffRow>[] }, 200);
});

const reviewRoute = createRoute({
  method: 'post',
  path: '/accounts/{accountId}/inspections/{id}/review',
  tags: ['inspections'],
  summary: 'Mark a tenant-submitted inspection as landlord-reviewed',
  request: { params: AccountAndIdParam },
  responses: {
    200: { description: 'reviewed', content: { 'application/json': { schema: Inspection } } },
    ...errorResponses,
  },
});
inspectionsApp.openapi(reviewRoute, async (c) => {
  const { accountId, id } = c.req.valid('param');
  const sb = getSb(c);
  const { data, error } = await sb
    .from('inspections')
    .update({ status: 'landlord_reviewed', updated_at: new Date().toISOString() })
    .eq('account_id', accountId)
    .eq('id', id)
    .is('deleted_at', null)
    .is('completed_at', null)
    .in('status', ['draft', 'tenant_submitted'])
    .select('*')
    .maybeSingle();
  if (error) throw new ApiError(500, 'database_error', error.message);
  if (!data) throw new ApiError(404, 'not_found', 'inspection not found or not reviewable');
  return c.json(data as z.infer<typeof Inspection>, 200);
});

const voidRoute = createRoute({
  method: 'post',
  path: '/accounts/{accountId}/inspections/{id}/void',
  tags: ['inspections'],
  summary: 'Void an inspection (correction path; never deletes evidence)',
  request: {
    params: AccountAndIdParam,
    body: { content: { 'application/json': { schema: VoidInspectionBody } }, required: true },
  },
  responses: {
    200: { description: 'voided', content: { 'application/json': { schema: Inspection } } },
    ...errorResponses,
  },
});
inspectionsApp.openapi(voidRoute, async (c) => {
  const { accountId, id } = c.req.valid('param');
  const body = c.req.valid('json');
  const sb = getSb(c);
  const { data, error } = await sb.rpc('void_inspection', {
    p_account_id: accountId,
    p_inspection_id: id,
    p_reason: body.reason,
  });
  if (error) throw rpcError(error);
  const row = (Array.isArray(data) ? data[0] : data) as z.infer<typeof Inspection> | null;
  if (!row) throw new ApiError(404, 'not_found', 'inspection not found');
  return c.json(row, 200);
});

const checksListRoute = createRoute({
  method: 'get',
  path: '/accounts/{accountId}/inspections/{id}/checks',
  tags: ['inspection_checks'],
  request: { params: AccountAndIdParam },
  responses: {
    200: { description: 'checks', content: { 'application/json': { schema: CheckListResponse } } },
    ...errorResponses,
  },
});
inspectionsApp.openapi(checksListRoute, async (c) => {
  const { accountId, id } = c.req.valid('param');
  const sb = getSb(c);
  const { data, error } = await sb
    .from('inspection_checks')
    .select('*')
    .eq('account_id', accountId)
    .eq('inspection_id', id)
    .is('deleted_at', null)
    .order('sort_order', { ascending: true, nullsFirst: false })
    .order('created_at', { ascending: true });
  if (error) throw new ApiError(500, 'database_error', error.message);
  return c.json({ data: (data ?? []) as z.infer<typeof InspectionCheck>[] }, 200);
});

const checksUpsertRoute = createRoute({
  method: 'post',
  path: '/accounts/{accountId}/inspections/{id}/checks',
  tags: ['inspection_checks'],
  summary: 'Batch upsert typed checks by field_key',
  request: {
    params: AccountAndIdParam,
    body: { content: { 'application/json': { schema: UpsertChecksBody } }, required: true },
  },
  responses: {
    200: {
      description: 'upserted',
      content: { 'application/json': { schema: CheckListResponse } },
    },
    ...errorResponses,
  },
});
inspectionsApp.openapi(checksUpsertRoute, async (c) => {
  const { accountId, id } = c.req.valid('param');
  const body = c.req.valid('json');
  const sb = getSb(c);
  const { data, error } = await sb.rpc('upsert_inspection_checks', {
    p_account_id: accountId,
    p_inspection_id: id,
    p_checks: asJson(body.checks),
  });
  if (error) throw rpcError(error);
  return c.json({ data: (data ?? []) as z.infer<typeof InspectionCheck>[] }, 200);
});

// Checks were add/rename-only until templates repeating a field_key across
// sections minted permanent duplicate rows (FE §17). Soft-delete mirrors
// itemRemove; the partial unique index frees the field_key for a later
// re-seed (which will re-mint template-seeded checks -- per-unit trimming is
// the area-inspection-layout's job, not a per-inspection delete's).
const checksRemoveRoute = createRoute({
  method: 'delete',
  path: '/accounts/{accountId}/inspections/{id}/checks/{checkId}',
  tags: ['inspection_checks'],
  summary:
    'Soft-delete an inspection check (rejected with 409 if the parent inspection is completed)',
  request: { params: InspectionAndCheckParam },
  responses: {
    204: { description: 'deleted' },
    ...errorResponses,
  },
});
inspectionsApp.openapi(checksRemoveRoute, async (c) => {
  const { accountId, id, checkId } = c.req.valid('param');
  const sb = getSb(c);
  const { data, error } = await sb
    .from('inspection_checks')
    .update(softDeleteStamp())
    .eq('account_id', accountId)
    .eq('inspection_id', id)
    .eq('id', checkId)
    .is('deleted_at', null)
    .select('id')
    .maybeSingle();
  if (error) {
    if (/parent inspection .* is completed/i.test(error.message)) {
      throw new ApiError(409, 'conflict', 'parent inspection is completed; checks are immutable');
    }
    throw new ApiError(500, 'database_error', error.message);
  }
  if (!data) throw new ApiError(404, 'not_found', 'not found');
  return c.body(null, 204);
});

// Mint a tenant capture magic link for this inspection (landlord-authenticated).
// The raw secret is returned ONCE to the caller to share; only its hash is
// stored. Re-call to issue a fresh link (e.g. to satisfy a renewal request).
const CaptureLinkBody = z
  .object({
    tenant_id: z.string().uuid().optional(),
    expires_in_minutes: z.coerce
      .number()
      .int()
      .positive()
      .max(MAX_CAPTURE_TTL_MIN)
      .default(DEFAULT_CAPTURE_TTL_MIN),
  })
  .openapi('CreateCaptureLinkBody');
const MintedCaptureLink = z
  .object({
    id: z.string().uuid(),
    secret: z.string(),
    account_id: z.string().uuid(),
    inspection_id: z.string().uuid(),
    tenant_id: z.string().uuid().nullable(),
    expires_at: z.string(),
    created_at: z.string(),
  })
  .openapi('MintedCaptureLink');
const captureLinkRoute = createRoute({
  method: 'post',
  path: '/accounts/{accountId}/inspections/{id}/capture-links',
  tags: ['inspections'],
  summary: 'Mint a tenant capture magic link for this inspection',
  request: {
    params: AccountAndIdParam,
    body: { content: { 'application/json': { schema: CaptureLinkBody } }, required: true },
  },
  responses: {
    201: { description: 'minted', content: { 'application/json': { schema: MintedCaptureLink } } },
    ...errorResponses,
  },
});
inspectionsApp.openapi(captureLinkRoute, async (c) => {
  const { accountId, id } = c.req.valid('param');
  const body = c.req.valid('json');
  const sb = getSb(c);
  const auth = c.get('auth');
  const secret = generateCaptureSecret();
  const expiresAt = new Date(Date.now() + body.expires_in_minutes * 60 * 1000).toISOString();
  const { data, error } = await sb
    .from('inspection_capture_tokens')
    .insert({
      account_id: accountId,
      inspection_id: id,
      tenant_id: body.tenant_id ?? null,
      secret_hash: '\\x' + hashCaptureSecret(secret).toString('hex'),
      expires_at: expiresAt,
      created_by: auth.userId,
    })
    .select('id, account_id, inspection_id, tenant_id, expires_at, created_at')
    .single();
  if (error) {
    if (error.code === '23503')
      throw new ApiError(404, 'not_found', 'inspection or tenant not found in this account');
    throw new ApiError(500, 'database_error', error.message);
  }
  return c.json({ ...(data as object), secret } as z.infer<typeof MintedCaptureLink>, 201);
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
  summary:
    'Soft-delete an inspection item (rejected with 409 if the parent inspection is completed)',
  request: { params: InspectionAndItemParam },
  responses: {
    204: { description: 'deleted' },
    ...errorResponses,
  },
});

export const inspectionItemsApp = newApiApp();

inspectionItemsApp.openapi(itemList, async (c) => {
  const { accountId, inspectionId } = c.req.valid('param');
  const sb = getSb(c);
  const { data, error } = await sb
    .from('inspection_items')
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
  const sb = getSb(c);
  const { data, error } = await sb
    .from('inspection_items')
    .insert({
      account_id: accountId,
      inspection_id: inspectionId,
      label: body.label,
      condition: body.condition ?? null,
      notes: body.notes ?? null,
      item_key: body.item_key ?? null,
      group_label: body.group_label ?? null,
      change_type: body.change_type ?? null,
      sort_order: body.sort_order ?? null,
    })
    .select('*')
    .single();
  if (error) {
    if (/parent inspection .* is completed/i.test(error.message)) {
      throw new ApiError(409, 'conflict', 'parent inspection is completed; items are immutable');
    }
    if (error.code === '23505')
      throw new ApiError(
        409,
        'conflict',
        'an item with this item_key already exists for this inspection',
      );
    if (error.code === '23503')
      throw new ApiError(404, 'not_found', 'inspection not found in this account');
    throw new ApiError(500, 'database_error', error.message);
  }
  return c.json(data as z.infer<typeof InspectionItem>, 201);
});

inspectionItemsApp.openapi(itemPatch, async (c) => {
  const { accountId, inspectionId, id } = c.req.valid('param');
  const body = c.req.valid('json');
  const sb = getSb(c);
  const update: DbTableUpdate<'inspection_items'> = { updated_at: new Date().toISOString() };
  if (body.label !== undefined) update.label = body.label;
  if (body.condition !== undefined) update.condition = body.condition;
  if (body.notes !== undefined) update.notes = body.notes;
  if (body.item_key !== undefined) update.item_key = body.item_key;
  if (body.group_label !== undefined) update.group_label = body.group_label;
  if (body.change_type !== undefined) update.change_type = body.change_type;
  if (body.sort_order !== undefined) update.sort_order = body.sort_order;
  const { data, error } = await sb
    .from('inspection_items')
    .update(update)
    .eq('account_id', accountId)
    .eq('inspection_id', inspectionId)
    .eq('id', id)
    .is('deleted_at', null)
    .select('*')
    .maybeSingle();
  if (error) {
    if (/parent inspection .* is completed/i.test(error.message)) {
      throw new ApiError(409, 'conflict', 'parent inspection is completed; items are immutable');
    }
    if (error.code === '23505')
      throw new ApiError(
        409,
        'conflict',
        'an item with this item_key already exists for this inspection',
      );
    throw new ApiError(500, 'database_error', error.message);
  }
  if (!data) throw new ApiError(404, 'not_found', 'not found');
  return c.json(data as z.infer<typeof InspectionItem>, 200);
});

inspectionItemsApp.openapi(itemRemove, async (c) => {
  const { accountId, inspectionId, id } = c.req.valid('param');
  const sb = getSb(c);
  const { data, error } = await sb
    .from('inspection_items')
    .update(softDeleteStamp())
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

// Batch upsert items by item_key (offline / field re-sync). Convergent on
// item_key so a retried sync doesn't double-insert.
const itemsBatchRoute = createRoute({
  method: 'post',
  path: '/accounts/{accountId}/inspections/{inspectionId}/items/batch',
  tags: ['inspection_items'],
  summary: 'Batch upsert inspection items by item_key',
  request: {
    params: InspectionParam,
    body: { content: { 'application/json': { schema: BatchItemsBody } }, required: true },
  },
  responses: {
    200: { description: 'upserted', content: { 'application/json': { schema: ItemListResponse } } },
    ...errorResponses,
  },
});
inspectionItemsApp.openapi(itemsBatchRoute, async (c) => {
  const { accountId, inspectionId } = c.req.valid('param');
  const body = c.req.valid('json');
  const sb = getSb(c);
  const { data, error } = await sb.rpc('upsert_inspection_items', {
    p_account_id: accountId,
    p_inspection_id: inspectionId,
    p_items: body.items,
  });
  if (error) throw rpcError(error);
  return c.json({ data: (data ?? []) as z.infer<typeof InspectionItem>[] }, 200);
});
