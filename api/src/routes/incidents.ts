import { createRoute, z } from '@hono/zod-openapi';
import { newApiApp } from './_lib/app';
import { getSb } from '../supabase/request-client';
import type { DbTableInsert, DbTableRow, DbTableUpdate } from '../supabase/db-types';
import { ApiError, dbError, errorResponses, conflictResponse } from './_lib/error';
import { keysetPage } from './_lib/cursor';
import { paginated } from './_lib/list-response';
import { softDeleteStamp } from './_lib/soft-delete';
import { requireManager } from './_lib/guards';

// An incident is an evidence-grade case record: the landlord's contemporaneous
// testimony that something happened on a tenancy (noise, unauthorized
// occupant, damage, ...) plus citations to the journal rows it rests on.
// Three rules shape every handler below (migration 20260801000002 is the
// enforcement layer for all of them):
//
// 1. Writes are HUMAN-ONLY. requireManager denies the agent principal
//    (role='agent') and viewers; reads stay member-wide so the agent can
//    reference incidents without ever authoring testimony.
// 2. Testimony is written in pen. description / occurred_at / tenancy_id are
//    DB-frozen after capture, so PATCH exposes only classification and
//    outcome (category, resolved_at, resolution_note). Corrections are
//    appended as journal notes, never edits; dismissal is an audited soft
//    delete.
// 3. Citations (incident_items) are insert + soft-unlink only: a citation is
//    a fact about what the record-keeper relied on, so it is never re-pointed
//    or erased. A live citation also freezes the cited journal entry's
//    probative fields (DB trigger on interactions).

// Canonical slot list: interaction | maintenance_request | notice |
// inspection. Adding a slot type = 4 sites: the migration CHECK, this list
// (which drives the Zod refine + insert), the hydration block in the items
// list handler, and the export renderer.
const SLOT_COLUMNS = [
  'interaction_id',
  'maintenance_request_id',
  'notice_id',
  'inspection_id',
] as const;
type SlotColumn = (typeof SLOT_COLUMNS)[number];

// Mirrors the category CHECK in migration 20260801000002 exactly.
const IncidentCategory = z
  .enum([
    'noise',
    'nonpayment',
    'property_damage',
    'unauthorized_occupant',
    'unauthorized_pet',
    'smoking',
    'illegal_activity',
    'harassment',
    'sanitation',
    'unauthorized_sublet',
    'access_refusal',
    'unauthorized_alteration',
    'injury_claim',
    'abandonment',
    'holdover',
    'police_activity',
    'hoa_violation',
    'other',
  ])
  .openapi('IncidentCategory');

const Incident = z
  .object({
    id: z.string().uuid(),
    account_id: z.string().uuid(),
    tenancy_id: z.string().uuid(),
    category: IncidentCategory.nullable().openapi({
      description:
        'null = not yet classified. Deferred classification is a designed ' +
        'workflow: capture first, PATCH category later.',
    }),
    description: z.string(),
    occurred_at: z.string(),
    resolved_at: z.string().nullable(),
    resolution_note: z.string().nullable(),
    created_at: z.string(),
    updated_at: z.string(),
    deleted_at: z.string().nullable(),
  })
  .openapi('Incident');

// Raw citation row (the pointer, not the cited content).
const IncidentItem = z
  .object({
    id: z.string().uuid(),
    account_id: z.string().uuid(),
    incident_id: z.string().uuid(),
    interaction_id: z.string().uuid().nullable(),
    maintenance_request_id: z.string().uuid().nullable(),
    notice_id: z.string().uuid().nullable(),
    inspection_id: z.string().uuid().nullable(),
    created_at: z.string(),
    updated_at: z.string(),
    deleted_at: z.string().nullable(),
  })
  .openapi('IncidentItem');

const EXACTLY_ONE_SLOT =
  'exactly one of interaction_id | maintenance_request_id | notice_id | inspection_id is required';

const CitationSlots = z.object({
  interaction_id: z.string().uuid().optional(),
  maintenance_request_id: z.string().uuid().optional(),
  notice_id: z.string().uuid().optional(),
  inspection_id: z.string().uuid().optional(),
});

function pickSlot(b: Partial<Record<SlotColumn, string>>): SlotColumn | null {
  const present = SLOT_COLUMNS.filter((k) => b[k] !== undefined);
  return present.length === 1 ? (present[0] as SlotColumn) : null;
}

const IncidentSource = CitationSlots.refine((b) => pickSlot(b) !== null, {
  message: EXACTLY_ONE_SLOT,
}).openapi('IncidentSource');

const CreateIncidentItemBody = CitationSlots.refine((b) => pickSlot(b) !== null, {
  message: EXACTLY_ONE_SLOT,
}).openapi('CreateIncidentItemBody');

const CreateIncidentBody = z
  .object({
    tenancy_id: z.string().uuid(),
    description: z.string().min(1).max(5000).openapi({
      description: 'The testimony. Frozen after capture; corrections are appended as journal notes.',
    }),
    category: IncidentCategory.optional(),
    occurred_at: z
      .string()
      .datetime()
      .optional()
      .refine((v) => v === undefined || Date.parse(v) <= Date.now() + 5 * 60 * 1000, {
        message: 'occurred_at cannot be in the future',
      })
      .openapi({
        description:
          'When the incident happened; defaults to now. Frozen after capture. ' +
          'Must not be in the future (beyond 5 minutes of clock skew) — a ' +
          'record of a future event is never valid testimony.',
      }),
    source: IncidentSource.optional().openapi({
      description:
        'Optional origin evidence to cite in the same call (exactly one slot). ' +
        'A failed link never loses the capture: the incident is still created ' +
        'and the failure is reported in warnings.',
    }),
  })
  .openapi('CreateIncidentBody');

const CreateIncidentResponse = z
  .object({
    incident: Incident,
    origin_item: IncidentItem.nullable(),
    warnings: z
      .array(z.string())
      .optional()
      .openapi({
        description:
          "Present when a best-effort side write failed (e.g. 'source_link_failed: ...'). " +
          'The incident itself was created; re-cite via POST /incidents/{id}/items.',
      }),
  })
  .openapi('CreateIncidentResponse');

// description / occurred_at / tenancy_id are DELIBERATELY absent: testimony
// is frozen. This schema is the polite refusal; the DB frozen-fields trigger
// rejects them too (defense in depth).
const PatchIncidentBody = z
  .object({
    // Set-only: un-classifying (category -> null) is not a workflow; use
    // 'other' when nothing fits.
    category: IncidentCategory.optional(),
    resolved_at: z.string().datetime().nullable().optional().openapi({
      description: 'Set to mark the outcome; null reopens the incident.',
    }),
    resolution_note: z.string().min(1).max(2000).nullable().optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: 'at least one field is required' })
  .openapi('PatchIncidentBody');

// Compact projections of cited rows: enough to render an evidence list
// without a follow-up fetch per row.
const CitedInteraction = z
  .object({
    id: z.string().uuid(),
    kind: z.string(),
    channel: z.string(),
    direction: z.string(),
    body: z.string().nullable(),
    occurred_at: z.string(),
    logged_at: z.string(),
    party_type: z.string(),
    party_label: z.string().nullable(),
    attestation: z.string().nullable(),
    thread_id: z.string().uuid().nullable(),
    // Non-null when the cited journal entry was retracted (retract-before-cite
    // or retract-after-unlink history rows). Clients should suppress the body
    // the way the evidence export does ("(retracted journal entry)").
    deleted_at: z.string().nullable(),
  })
  .openapi('IncidentCitedInteraction');

const CitedMaintenanceRequest = z
  .object({
    id: z.string().uuid(),
    title: z.string(),
    description: z.string().nullable(),
    severity: z.string(),
    status: z.string(),
    created_at: z.string(),
  })
  .openapi('IncidentCitedMaintenanceRequest');

const CitedNotice = z
  .object({
    id: z.string().uuid(),
    notice_type: z.string(),
    served_at: z.string().nullable(),
    served_method: z.string().nullable(),
    created_at: z.string(),
  })
  .openapi('IncidentCitedNotice');

const CitedInspection = z
  .object({
    id: z.string().uuid(),
    kind: z.string(),
    status: z.string(),
    performed_at: z.string().nullable(),
    completed_at: z.string().nullable(),
    created_at: z.string(),
  })
  .openapi('IncidentCitedInspection');

const IncidentItemHydrated = z
  .object({
    id: z.string().uuid(),
    created_at: z.string(),
    unlinked_at: z.string().nullable().openapi({
      description: 'Soft-unlink timestamp; null while the citation is live.',
    }),
    interaction: CitedInteraction.optional(),
    maintenance_request: CitedMaintenanceRequest.optional(),
    notice: CitedNotice.optional(),
    inspection: CitedInspection.optional(),
  })
  .openapi('IncidentItemHydrated');

const IncidentRecurrence = z
  .object({
    category: IncidentCategory,
    window_months: z.number().int(),
    count: z.number().int().openapi({
      description: 'Total matching incidents in the window (may exceed the listed 50).',
    }),
    incidents: z
      .array(
        z.object({
          id: z.string().uuid(),
          occurred_at: z.string(),
          description: z.string().openapi({ description: 'Truncated to 200 characters.' }),
          resolved_at: z.string().nullable(),
        }),
      )
      .openapi({ description: 'Newest first by occurred_at; capped at 50 rows.' }),
  })
  .openapi('IncidentRecurrence');

const IncidentListResponse = paginated(Incident).openapi('IncidentListResponse');
const IncidentItemListResponse = paginated(IncidentItemHydrated).openapi(
  'IncidentItemListResponse',
);

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
const AccountIdAndItemParam = z.object({
  accountId: z
    .string()
    .uuid()
    .openapi({ param: { name: 'accountId', in: 'path' } }),
  id: z
    .string()
    .uuid()
    .openapi({ param: { name: 'id', in: 'path' } }),
  itemId: z
    .string()
    .uuid()
    .openapi({ param: { name: 'itemId', in: 'path' } }),
});

const ListQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().positive().max(100).default(50),
  tenancy_id: z.string().uuid().optional(),
  category: IncidentCategory.optional(),
  open: z
    .enum(['true', 'false'])
    .optional()
    .openapi({
      description: "'true' → unresolved only (resolved_at is null); 'false' → resolved only.",
    }),
});

const ItemListQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().positive().max(100).default(50),
  include_unlinked: z.enum(['true', 'false']).default('false').openapi({
    description: 'Include soft-unlinked citations (citation history) in the page.',
  }),
});

const RecurrenceQuery = z.object({
  window_months: z.coerce.number().int().min(1).max(36).default(12),
});

const list = createRoute({
  method: 'get',
  path: '/accounts/{accountId}/incidents',
  tags: ['incidents'],
  summary: 'List incidents (filterable by tenancy_id, category, open state)',
  description:
    'Member-wide read (viewers and the agent principal included). Dismissed ' +
    'incidents are excluded.',
  request: { params: AccountParam, query: ListQuery },
  responses: {
    200: {
      description: 'page',
      content: { 'application/json': { schema: IncidentListResponse } },
    },
    ...errorResponses,
  },
});
const create = createRoute({
  method: 'post',
  path: '/accounts/{accountId}/incidents',
  tags: ['incidents'],
  summary: 'Capture an incident (human-only; testimony freezes on write)',
  description:
    'Owner/manager only: incidents are human testimony, so the agent principal ' +
    'and viewers are denied (403). description and occurred_at are frozen at ' +
    'capture by a DB trigger — corrections are appended as journal notes, never ' +
    'edits. An optional source cites the originating evidence row (exactly one ' +
    'of interaction_id | maintenance_request_id | notice_id | inspection_id) in ' +
    'the same call; if that link fails the incident is STILL created (201) with ' +
    'origin_item null and a warnings entry — a capture is never lost to a bad ' +
    'link.',
  request: {
    params: AccountParam,
    body: { content: { 'application/json': { schema: CreateIncidentBody } }, required: true },
  },
  responses: {
    201: {
      description: 'created',
      content: { 'application/json': { schema: CreateIncidentResponse } },
    },
    ...errorResponses,
  },
});
const get = createRoute({
  method: 'get',
  path: '/accounts/{accountId}/incidents/{id}',
  tags: ['incidents'],
  summary: 'Get one incident',
  request: { params: AccountAndIdParam },
  responses: {
    200: { description: 'incident', content: { 'application/json': { schema: Incident } } },
    ...errorResponses,
  },
});
const patch = createRoute({
  method: 'patch',
  path: '/accounts/{accountId}/incidents/{id}',
  tags: ['incidents'],
  summary: 'Classify or resolve an incident (testimony fields are frozen)',
  description:
    'Owner/manager only. Only classification and outcome are mutable: category ' +
    '(set-only), resolved_at (null reopens) and resolution_note. description, ' +
    'occurred_at and tenancy_id are testimony written in pen — they are absent ' +
    'from this schema and a DB trigger rejects them as well.',
  request: {
    params: AccountAndIdParam,
    body: { content: { 'application/json': { schema: PatchIncidentBody } }, required: true },
  },
  responses: {
    200: { description: 'updated', content: { 'application/json': { schema: Incident } } },
    ...errorResponses,
  },
});
const remove = createRoute({
  method: 'delete',
  path: '/accounts/{accountId}/incidents/{id}',
  tags: ['incidents'],
  summary: 'Dismiss an incident (audited soft delete)',
  description:
    'Owner/manager only. Dismissal is a soft delete: the row and its audit ' +
    'events are preserved; the incident just leaves the working set. Its ' +
    'citations stay live and cited journal entries stay frozen — unlink items ' +
    'first (they remain readable via GET items) if evidence must be released.',
  request: { params: AccountAndIdParam },
  responses: {
    204: { description: 'dismissed' },
    ...errorResponses,
  },
});
const createItem = createRoute({
  method: 'post',
  path: '/accounts/{accountId}/incidents/{id}/items',
  tags: ['incidents'],
  summary: 'Cite an evidence row (exactly one slot; insert-only)',
  description:
    'Owner/manager only. Cites exactly one existing row (interaction_id | ' +
    'maintenance_request_id | notice_id | inspection_id) as evidence. While the ' +
    'citation is live, the cited journal entry’s probative fields are frozen by ' +
    'a DB trigger. Citations are never edited or re-pointed — unlink and cite ' +
    'again instead. 409 already_cited when the same row is already ' +
    'live-cited by this incident.',
  request: {
    params: AccountAndIdParam,
    body: {
      content: { 'application/json': { schema: CreateIncidentItemBody } },
      required: true,
    },
  },
  responses: {
    201: { description: 'cited', content: { 'application/json': { schema: IncidentItem } } },
    ...errorResponses,
    ...conflictResponse,
  },
});
const listItems = createRoute({
  method: 'get',
  path: '/accounts/{accountId}/incidents/{id}/items',
  tags: ['incidents'],
  summary: 'List cited evidence, hydrated',
  description:
    'Member-wide read. Each row carries exactly one populated evidence object ' +
    '(interaction | maintenance_request | notice | inspection) — a compact ' +
    'projection of the cited record. Soft-unlinked citations are excluded ' +
    'unless include_unlinked=true (unlinked rows are citation history, with ' +
    'unlinked_at set). A missing or dismissed incident yields an empty page — ' +
    'deliberately, so a dismissed incident’s citation history stays readable.',
  request: { params: AccountAndIdParam, query: ItemListQuery },
  responses: {
    200: {
      description: 'page',
      content: { 'application/json': { schema: IncidentItemListResponse } },
    },
    ...errorResponses,
  },
});
const removeItem = createRoute({
  method: 'delete',
  path: '/accounts/{accountId}/incidents/{id}/items/{itemId}',
  tags: ['incidents'],
  summary: 'Unlink a citation (soft; the pointer row is kept as history)',
  description:
    'Owner/manager only. Unlink is the ONLY permitted change to a citation: it ' +
    'releases the freeze on the cited journal entry and keeps the pointer row ' +
    '(visible via include_unlinked=true). 409 already_unlinked on a second ' +
    'unlink.',
  request: { params: AccountIdAndItemParam },
  responses: {
    204: { description: 'unlinked' },
    ...errorResponses,
    ...conflictResponse,
  },
});
const recurrence = createRoute({
  method: 'get',
  path: '/accounts/{accountId}/incidents/{id}/recurrence',
  tags: ['incidents'],
  summary: 'Count same-category incidents on the tenancy in a trailing window',
  description:
    'Member-wide read. Counts live incidents with the SAME tenancy and SAME ' +
    'category whose occurred_at falls in the trailing window measured back ' +
    'from NOW (not from this incident’s occurred_at); the incident itself is ' +
    'included when in-window. Because occurred_at is frozen at capture, the ' +
    'count cannot be manufactured after the fact. 409 unclassified until the ' +
    'incident has a category. Window arithmetic is calendar-month based: on ' +
    'month-end days the cutoff can land up to 3 days late (a slight, always ' +
    'conservative undercount).',
  request: { params: AccountAndIdParam, query: RecurrenceQuery },
  responses: {
    200: {
      description: 'recurrence summary',
      content: { 'application/json': { schema: IncidentRecurrence } },
    },
    ...errorResponses,
    ...conflictResponse,
  },
});

export const incidentsApp = newApiApp();

incidentsApp.openapi(list, async (c) => {
  const { accountId } = c.req.valid('param');
  const { cursor, limit, tenancy_id, category, open } = c.req.valid('query');
  const sb = getSb(c);
  let q = sb.from('incidents').select('*').eq('account_id', accountId).is('deleted_at', null);
  if (tenancy_id) q = q.eq('tenancy_id', tenancy_id);
  if (category) q = q.eq('category', category);
  if (open === 'true') q = q.is('resolved_at', null);
  if (open === 'false') q = q.not('resolved_at', 'is', null);
  const { items, next_cursor } = await keysetPage<z.infer<typeof Incident>>(q, { cursor, limit });
  return c.json({ data: items, next_cursor }, 200);
});

incidentsApp.openapi(create, async (c) => {
  requireManager(c);
  const { accountId } = c.req.valid('param');
  const body = c.req.valid('json');
  const sb = getSb(c);

  const insert: DbTableInsert<'incidents'> = {
    account_id: accountId,
    tenancy_id: body.tenancy_id,
    description: body.description,
    category: body.category ?? null,
  };
  if (body.occurred_at !== undefined) insert.occurred_at = body.occurred_at;
  const { data: incident, error } = await sb.from('incidents').insert(insert).select('*').single();
  if (error) {
    if (error.code === '23503') {
      throw new ApiError(404, 'not_found', 'tenancy_id does not belong to this account');
    }
    if (error.code === '23514') {
      throw new ApiError(400, 'invalid_request', error.message);
    }
    throw dbError(error);
  }

  // Second insert, best-effort: the capture must never be lost to a bad link.
  // A cross-account or nonexistent source id surfaces as FK 23503 -- that is
  // a warning on the created incident, not a 500.
  let originItem: DbTableRow<'incident_items'> | null = null;
  const warnings: string[] = [];
  if (body.source) {
    const slot = pickSlot(body.source);
    if (slot) {
      const itemInsert: DbTableInsert<'incident_items'> = {
        account_id: accountId,
        incident_id: incident.id,
      };
      itemInsert[slot] = body.source[slot];
      const { data: item, error: linkErr } = await sb
        .from('incident_items')
        .insert(itemInsert)
        .select('*')
        .single();
      if (linkErr) {
        const reason =
          linkErr.code === '23503'
            ? 'cited record not found in this account'
            : linkErr.message;
        warnings.push(`source_link_failed: ${reason}`);
      } else {
        originItem = item;
      }
    }
  }

  const response: z.infer<typeof CreateIncidentResponse> = {
    incident: incident as z.infer<typeof Incident>,
    origin_item: originItem,
  };
  if (warnings.length > 0) response.warnings = warnings;
  return c.json(response, 201);
});

incidentsApp.openapi(get, async (c) => {
  const { accountId, id } = c.req.valid('param');
  const sb = getSb(c);
  const { data, error } = await sb
    .from('incidents')
    .select('*')
    .eq('account_id', accountId)
    .eq('id', id)
    .is('deleted_at', null)
    .maybeSingle();
  if (error) throw dbError(error);
  if (!data) throw new ApiError(404, 'not_found', 'not found');
  return c.json(data as z.infer<typeof Incident>, 200);
});

incidentsApp.openapi(patch, async (c) => {
  requireManager(c);
  const { accountId, id } = c.req.valid('param');
  const body = c.req.valid('json');
  const sb = getSb(c);
  // Only classification/outcome ever appear here; the frozen-fields DB
  // trigger would reject anything else even if this handler drifted.
  const update: DbTableUpdate<'incidents'> = { updated_at: new Date().toISOString() };
  if (body.category !== undefined) update.category = body.category;
  if (body.resolved_at !== undefined) update.resolved_at = body.resolved_at;
  if (body.resolution_note !== undefined) update.resolution_note = body.resolution_note;
  const { data, error } = await sb
    .from('incidents')
    .update(update)
    .eq('account_id', accountId)
    .eq('id', id)
    .is('deleted_at', null)
    .select('*')
    .maybeSingle();
  if (error) {
    if (error.code === '23514') {
      throw new ApiError(400, 'invalid_request', error.message);
    }
    throw dbError(error);
  }
  if (!data) throw new ApiError(404, 'not_found', 'not found');
  return c.json(data as z.infer<typeof Incident>, 200);
});

incidentsApp.openapi(remove, async (c) => {
  requireManager(c);
  const { accountId, id } = c.req.valid('param');
  const sb = getSb(c);
  const { data, error } = await sb
    .from('incidents')
    .update(softDeleteStamp())
    .eq('account_id', accountId)
    .eq('id', id)
    .is('deleted_at', null)
    .select('id')
    .maybeSingle();
  if (error) throw dbError(error);
  if (!data) throw new ApiError(404, 'not_found', 'not found');
  return c.body(null, 204);
});

incidentsApp.openapi(createItem, async (c) => {
  requireManager(c);
  const { accountId, id } = c.req.valid('param');
  const body = c.req.valid('json');
  const sb = getSb(c);

  // Citing evidence on a dismissed (or foreign) incident is a 404, not a
  // silent FK failure: the incident must be live in this account.
  const { data: incident, error: incErr } = await sb
    .from('incidents')
    .select('id')
    .eq('account_id', accountId)
    .eq('id', id)
    .is('deleted_at', null)
    .maybeSingle();
  if (incErr) throw dbError(incErr);
  if (!incident) throw new ApiError(404, 'not_found', 'not found');

  const slot = pickSlot(body);
  if (!slot) throw new ApiError(400, 'invalid_request', EXACTLY_ONE_SLOT);
  const insert: DbTableInsert<'incident_items'> = {
    account_id: accountId,
    incident_id: id,
  };
  insert[slot] = body[slot];
  const { data, error } = await sb.from('incident_items').insert(insert).select('*').single();
  if (error) {
    if (error.code === '23503') {
      throw new ApiError(404, 'not_found', 'cited record not found in this account');
    }
    if (error.code === '23505') {
      throw new ApiError(409, 'already_cited', 'already cited by this incident');
    }
    if (error.code === '23514') {
      throw new ApiError(400, 'invalid_request', error.message);
    }
    throw dbError(error);
  }
  return c.json(data as z.infer<typeof IncidentItem>, 201);
});

incidentsApp.openapi(listItems, async (c) => {
  const { accountId, id } = c.req.valid('param');
  const { cursor, limit, include_unlinked } = c.req.valid('query');
  const sb = getSb(c);
  let q = sb
    .from('incident_items')
    .select('*')
    .eq('account_id', accountId)
    .eq('incident_id', id);
  if (include_unlinked !== 'true') q = q.is('deleted_at', null);
  const { items, next_cursor } = await keysetPage<DbTableRow<'incident_items'>>(q, {
    cursor,
    limit,
  });

  // Hydration: one batched lookup per evidence table. limit is capped at 100,
  // so each per-slot id list stays within the 100-id ceiling for a single
  // PostgREST IN() -- no chunking needed. The lookups do NOT filter
  // deleted_at: a citation is history, the composite FK (RESTRICT + no hard
  // deletes) guarantees the cited row still exists, and soft-deleted evidence
  // still belongs in the record.
  const idsFor = (col: SlotColumn): string[] => [
    ...new Set(items.map((r) => r[col]).filter((v): v is string => v !== null)),
  ];
  const interactionIds = idsFor('interaction_id');
  const maintenanceIds = idsFor('maintenance_request_id');
  const noticeIds = idsFor('notice_id');
  const inspectionIds = idsFor('inspection_id');
  const empty = Promise.resolve({ data: null, error: null });

  const [interactionsRes, maintenanceRes, noticesRes, inspectionsRes] = await Promise.all([
    interactionIds.length
      ? sb
          .from('interactions')
          .select(
            'id, kind, channel, direction, body, occurred_at, logged_at, party_type, party_label, attestation, thread_id, deleted_at',
          )
          .eq('account_id', accountId)
          .in('id', interactionIds)
      : empty,
    maintenanceIds.length
      ? sb
          .from('maintenance_requests')
          .select('id, title, description, severity, status, created_at')
          .eq('account_id', accountId)
          .in('id', maintenanceIds)
      : empty,
    noticeIds.length
      ? sb
          .from('notices')
          .select('id, notice_type, served_at, served_method, created_at')
          .eq('account_id', accountId)
          .in('id', noticeIds)
      : empty,
    inspectionIds.length
      ? sb
          .from('inspections')
          .select('id, kind, status, performed_at, completed_at, created_at')
          .eq('account_id', accountId)
          .in('id', inspectionIds)
      : empty,
  ]);
  for (const res of [interactionsRes, maintenanceRes, noticesRes, inspectionsRes]) {
    if (res.error) throw dbError(res.error);
  }
  const interactionsById = new Map((interactionsRes.data ?? []).map((r) => [r.id, r]));
  const maintenanceById = new Map((maintenanceRes.data ?? []).map((r) => [r.id, r]));
  const noticesById = new Map((noticesRes.data ?? []).map((r) => [r.id, r]));
  const inspectionsById = new Map((inspectionsRes.data ?? []).map((r) => [r.id, r]));

  const data = items.map((it) => {
    const row: z.infer<typeof IncidentItemHydrated> = {
      id: it.id,
      created_at: it.created_at,
      unlinked_at: it.deleted_at,
    };
    if (it.interaction_id !== null) {
      row.interaction = interactionsById.get(it.interaction_id);
    } else if (it.maintenance_request_id !== null) {
      row.maintenance_request = maintenanceById.get(it.maintenance_request_id);
    } else if (it.notice_id !== null) {
      row.notice = noticesById.get(it.notice_id);
    } else if (it.inspection_id !== null) {
      row.inspection = inspectionsById.get(it.inspection_id);
    }
    return row;
  });
  return c.json({ data, next_cursor }, 200);
});

incidentsApp.openapi(removeItem, async (c) => {
  requireManager(c);
  const { accountId, id, itemId } = c.req.valid('param');
  const sb = getSb(c);

  // Probe first so a repeat unlink answers 409 (nothing to do, don't retry)
  // instead of a misleading 404.
  const { data: existing, error: exErr } = await sb
    .from('incident_items')
    .select('id, deleted_at')
    .eq('account_id', accountId)
    .eq('incident_id', id)
    .eq('id', itemId)
    .maybeSingle();
  if (exErr) throw dbError(exErr);
  if (!existing) throw new ApiError(404, 'not_found', 'not found');
  if (existing.deleted_at !== null) {
    throw new ApiError(409, 'already_unlinked', 'citation is already unlinked');
  }

  const { data, error } = await sb
    .from('incident_items')
    .update(softDeleteStamp())
    .eq('account_id', accountId)
    .eq('id', itemId)
    .is('deleted_at', null)
    .select('id')
    .maybeSingle();
  if (error) throw dbError(error);
  // Raced with a concurrent unlink between probe and write: same outcome.
  if (!data) throw new ApiError(409, 'already_unlinked', 'citation is already unlinked');
  return c.body(null, 204);
});

incidentsApp.openapi(recurrence, async (c) => {
  const { accountId, id } = c.req.valid('param');
  const { window_months } = c.req.valid('query');
  const sb = getSb(c);

  const { data: incident, error } = await sb
    .from('incidents')
    .select('id, tenancy_id, category, occurred_at')
    .eq('account_id', accountId)
    .eq('id', id)
    .is('deleted_at', null)
    .maybeSingle();
  if (error) throw dbError(error);
  if (!incident) throw new ApiError(404, 'not_found', 'not found');
  if (incident.category === null) {
    throw new ApiError(409, 'unclassified', 'classify the incident before counting recurrence');
  }

  // Trailing calendar window measured back from NOW, not from this incident's
  // occurred_at: "3 noise incidents in the last 12 months" is the claim a
  // landlord actually makes. The incident itself counts when in-window.
  const cutoff = new Date();
  cutoff.setUTCMonth(cutoff.getUTCMonth() - window_months);

  const {
    data: siblings,
    error: sibErr,
    count,
  } = await sb
    .from('incidents')
    .select('id, occurred_at, description, resolved_at', { count: 'exact' })
    .eq('account_id', accountId)
    .eq('tenancy_id', incident.tenancy_id)
    .eq('category', incident.category)
    .is('deleted_at', null)
    .gte('occurred_at', cutoff.toISOString())
    .order('occurred_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(50);
  if (sibErr) throw dbError(sibErr);

  const response: z.infer<typeof IncidentRecurrence> = {
    category: incident.category as z.infer<typeof IncidentCategory>,
    window_months,
    count: count ?? (siblings ?? []).length,
    incidents: (siblings ?? []).map((r) => ({
      id: r.id,
      occurred_at: r.occurred_at,
      description: r.description.length > 200 ? r.description.slice(0, 200) : r.description,
      resolved_at: r.resolved_at,
    })),
  };
  return c.json(response, 200);
});
