import { z } from '@hono/zod-openapi';
import { ApiError } from '../_lib/error';

// A "completed" inspection is locked: the DB triggers
// _reject_completed_inspection_update + _reject_item_update_on_completed_
// inspection refuse any change. Corrections happen via NEW events under
// the audit spine, never edits to the report bytes. Phase 8's contribution
// is the COMPLETE endpoint -- it sets completed_at AND renders the PDF
// (deterministically) AND stores it as a content-hashed attachment of
// entity_type='inspection_report'.

// --- inspection_templates ---------------------------------------------------

export const InspectionTemplate = z
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

export const CreateTemplateBody = z
  .object({
    name: z.string().min(1).max(200),
    schema: z.record(z.unknown()).optional(),
  })
  .openapi('CreateInspectionTemplateBody');

export const PatchTemplateBody = z
  .object({
    name: z.string().min(1).max(200).optional(),
    schema: z.record(z.unknown()).optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: 'at least one field is required' })
  .openapi('PatchInspectionTemplateBody');

// --- inspections ------------------------------------------------------------

export const Inspection = z
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
export const InspectionEngagement = z
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
export const InspectionDetail = Inspection.extend({
  engagement: InspectionEngagement,
}).openapi('InspectionDetail');

export const InspectionKind = z.enum(['move_in', 'move_out', 'periodic', 'general']);
export const CaptureMode = z.enum(['landlord', 'tenant', 'collaborative']);
export const ChangeType = z.enum([
  'unchanged',
  'normal_wear',
  'damage',
  'not_present_at_baseline',
  'new_at_checkout',
]);

export const CreateInspectionBody = z
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
export const CreateInspectionFromTemplateItem = z
  .object({
    item_key: z.string().min(1).max(200),
    label: z.string().min(1).max(200),
    group_label: z.string().min(1).max(200).optional(),
    sort_order: z.number().int().min(-2147483648).max(2147483647).optional(),
  })
  .openapi('CreateInspectionFromTemplateItem');

export const CreateInspectionFromTemplateCheck = z
  .object({
    field_key: z.string().min(1).max(200),
    label: z.string().min(1).max(200),
    group_label: z.string().min(1).max(200).optional(),
    sort_order: z.number().int().min(-2147483648).max(2147483647).optional(),
    input_kind: z.enum(['boolean', 'count', 'text']).optional(),
  })
  .openapi('CreateInspectionFromTemplateCheck');

export const CreateInspectionFromTemplateSetup = z
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

export const CreateInspectionFromTemplateBody = z
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

export const PatchInspectionBody = z
  .object({
    template_id: z.string().uuid().nullable().optional(),
    performed_at: z.string().datetime().nullable().optional(),
    notes: z.string().nullable().optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: 'at least one field is required' })
  .openapi('PatchInspectionBody');

// --- inspection_items -------------------------------------------------------

export const InspectionItem = z
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

export const CreateItemBody = z
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

export const PatchItemBody = z
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

export const InspectionCheck = z
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

export const UpsertChecksBody = z
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

export const BatchItemsBody = z
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

export const SeedFromTemplateBody = z
  .object({ template_id: z.string().uuid().optional() })
  .openapi('SeedInspectionFromTemplateBody');

export const StartCheckoutBody = z
  .object({
    performed_at: z.string().datetime().optional(),
    template_id: z.string().uuid().optional(),
    notes: z.string().max(20000).optional(),
  })
  .openapi('StartCheckoutBody');

export const VoidInspectionBody = z
  .object({ reason: z.string().min(1).max(2000) })
  .openapi('VoidInspectionBody');

export const SeededRows = z
  .object({ items: z.array(InspectionItem), checks: z.array(InspectionCheck) })
  .openapi('SeededInspectionRows');

export const CheckListResponse = z
  .object({ data: z.array(InspectionCheck) })
  .openapi('InspectionCheckListResponse');

export const DiffRow = z
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

export const DiffResponse = z
  .object({ data: z.array(DiffRow) })
  .openapi('InspectionCheckoutDiffResponse');

// Maps a SECURITY INVOKER RPC's pg error to the HTTP envelope. RLS denials
// (42501) surface as 404 so we never leak existence to a non-member.
export function rpcError(error: { code?: string; message: string }): ApiError {
  if (error.code === 'P0002') return new ApiError(404, 'not_found', error.message);
  if (error.code === '23503') return new ApiError(404, 'not_found', error.message);
  if (error.code === '42501') return new ApiError(404, 'not_found', 'not found');
  if (error.code === '23514') return new ApiError(409, 'conflict', error.message);
  if (error.code === '23505') return new ApiError(409, 'conflict', error.message);
  return new ApiError(500, 'database_error', error.message);
}

// --- params ------------------------------------------------------------------

export const AccountParam = z.object({
  accountId: z
    .string()
    .uuid()
    .openapi({ param: { name: 'accountId', in: 'path' } }),
});
export const AccountAndIdParam = z.object({
  accountId: z
    .string()
    .uuid()
    .openapi({ param: { name: 'accountId', in: 'path' } }),
  id: z
    .string()
    .uuid()
    .openapi({ param: { name: 'id', in: 'path' } }),
});
export const InspectionAndItemParam = z.object({
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
export const InspectionParam = z.object({
  accountId: z
    .string()
    .uuid()
    .openapi({ param: { name: 'accountId', in: 'path' } }),
  inspectionId: z
    .string()
    .uuid()
    .openapi({ param: { name: 'inspectionId', in: 'path' } }),
});
export const InspectionAndCheckParam = z.object({
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

export const ListQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().positive().max(100).default(50),
});
export const InspectionListQuery = ListQuery.extend({
  area_id: z.string().uuid().optional(),
});
export const TemplateListResponse = z
  .object({ data: z.array(InspectionTemplate), next_cursor: z.string().nullable() })
  .openapi('InspectionTemplateListResponse');
export const InspectionListResponse = z
  .object({ data: z.array(Inspection), next_cursor: z.string().nullable() })
  .openapi('InspectionListResponse');
export const ItemListResponse = z
  .object({ data: z.array(InspectionItem) })
  .openapi('InspectionItemListResponse');

export const CompleteResponse = z
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
