import { createRoute, z } from '@hono/zod-openapi';
import { newApiApp } from './_lib/app';
import { getSb } from '../supabase/request-client';
import { nullableRpcArg, type DbFunctionArgs, type DbTableUpdate } from '../supabase/db-types';
import { ApiError, dbError, errorResponses } from './_lib/error';
import { keysetPage } from './_lib/cursor';
import { parseCsvEnum } from './_lib/csv-enum';

// Maintenance requests come from two sources:
//   * landlord-initiated (POST below; opened_by = the JWT's user_id)
//   * tenant intake     (Phase 7 admin path; opened_by = null,
//                        intake_token = 'tenant:<token_id>')
//
// Status transitions are SERVER-ENFORCED. A bare PATCH that tries to jump
// from 'open' straight to 'closed' is rejected. This is the audit-grade
// requirement: every state change is a recorded step, not an arbitrary
// edit.

// Triage-actionable buckets. emergency = drop everything (habitability
// emergency: heat in winter, flood, gas). urgent = today/tomorrow.
// routine = schedule.
const Severity = z.enum(['emergency', 'urgent', 'routine']);
const Status = z.enum(['open', 'triaged', 'in_progress', 'resolved', 'closed']);
const ReporterPartyType = z.enum([
  'tenant',
  'landlord_user',
  'vendor',
  'agent',
  'inspector',
  'other',
  'unknown',
]);
const ReportChannel = z.enum([
  'in_person',
  'phone',
  'voicemail',
  'sms',
  'email',
  'letter',
  'in_app',
]);

const ReportedBy = z
  .object({
    source: z.literal('interaction'),
    interaction_id: z.string().uuid(),
    party_type: ReporterPartyType,
    party_id: z.string().uuid().nullable(),
    label: z.string().nullable(),
    address: z.string().nullable(),
    channel: ReportChannel,
    reported_at: z.string(),
    attestation: z.enum(['provider_verified', 'attested', 'imported']).nullable(),
  })
  .openapi('MaintenanceReportedBy');

// Allowed forward transitions. 'closed' is terminal. There's no path from
// terminal back to non-terminal; reopen = create a new request.
const ALLOWED: Record<z.infer<typeof Status>, ReadonlyArray<z.infer<typeof Status>>> = {
  open: ['triaged', 'in_progress', 'closed'],
  triaged: ['in_progress', 'closed'],
  in_progress: ['resolved', 'closed'],
  resolved: ['closed'],
  closed: [],
};

const MaintenanceRequest = z
  .object({
    id: z.string().uuid(),
    account_id: z.string().uuid(),
    area_id: z.string().uuid(),
    asset_id: z.string().uuid().nullable(),
    opened_by: z.string().uuid().nullable(),
    intake_token: z.string().nullable(),
    title: z.string(),
    description: z.string().nullable(),
    severity: Severity,
    status: Status,
    reported_by: ReportedBy.nullable().openapi({
      description:
        'Derived from the earliest linked inbound root interaction and its immutable sender cast. ' +
        'Null means no structured report interaction exists.',
    }),
    created_at: z.string(),
    updated_at: z.string(),
    deleted_at: z.string().nullable(),
  })
  .openapi('MaintenanceRequest');

const CreateBody = z
  .object({
    area_id: z.string().uuid(),
    asset_id: z.string().uuid().optional(),
    title: z.string().min(1).max(200),
    description: z.string().max(5000).optional(),
    severity: Severity,
    report: z
      .object({
        party_type: ReporterPartyType,
        party_id: z.string().uuid().optional(),
        label: z.string().min(1).max(200).optional(),
        address: z.string().min(3).max(320).optional(),
        channel: ReportChannel,
        reported_at: z.string().datetime().optional(),
        body: z.string().max(20000).optional().openapi({
          description: 'The reporter’s wording when it differs from the request description.',
        }),
      })
      .refine(
        (report) =>
          report.party_id !== undefined ||
          report.label !== undefined ||
          report.address !== undefined,
        { message: 'report needs at least one of party_id, label, or address' },
      )
      .optional()
      .openapi({
        description:
          'Optional report provenance. When present, request + inbound interaction + sender cast ' +
          'are committed atomically. Reporter identity is not copied onto the mutable request row.',
      }),
  })
  .openapi('CreateMaintenanceRequestBody');

const PatchBody = z
  .object({
    description: z.string().max(5000).nullable().optional(),
    severity: Severity.optional(),
    status: Status.optional(),
    asset_id: z.string().uuid().nullable().optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: 'at least one field is required' })
  .openapi('PatchMaintenanceRequestBody');

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
  area_id: z.string().uuid().optional(),
  // Single status or a comma-separated set — a single value keeps its exact
  // pre-existing behaviour; a multi-value filter widens to an IN. Validated in
  // the handler (parseCsvEnum) so an unknown member is a 400 with fieldErrors,
  // not a silent empty page.
  status: z.string().optional().openapi({
    description:
      "Status or comma-separated statuses. Allowed values: open, triaged, in_progress, resolved, closed. Example: 'open,triaged'.",
    example: 'open,triaged',
  }),
});
const ListResponse = z
  .object({ data: z.array(MaintenanceRequest), next_cursor: z.string().nullable() })
  .openapi('MaintenanceRequestListResponse');

const list = createRoute({
  method: 'get',
  path: '/accounts/{accountId}/maintenance-requests',
  tags: ['maintenance_requests'],
  request: { params: AccountParam, query: ListQuery },
  responses: {
    200: { description: 'page', content: { 'application/json': { schema: ListResponse } } },
    ...errorResponses,
  },
});
const get = createRoute({
  method: 'get',
  path: '/accounts/{accountId}/maintenance-requests/{id}',
  tags: ['maintenance_requests'],
  request: { params: AccountAndIdParam },
  responses: {
    200: {
      description: 'request',
      content: { 'application/json': { schema: MaintenanceRequest } },
    },
    ...errorResponses,
  },
});
const create = createRoute({
  method: 'post',
  path: '/accounts/{accountId}/maintenance-requests',
  tags: ['maintenance_requests'],
  request: {
    params: AccountParam,
    body: { content: { 'application/json': { schema: CreateBody } }, required: true },
  },
  responses: {
    201: {
      description: 'created',
      content: { 'application/json': { schema: MaintenanceRequest } },
    },
    ...errorResponses,
  },
});
const patch = createRoute({
  method: 'patch',
  path: '/accounts/{accountId}/maintenance-requests/{id}',
  tags: ['maintenance_requests'],
  summary: 'Update a maintenance request (status changes go through server-enforced transitions)',
  request: {
    params: AccountAndIdParam,
    body: { content: { 'application/json': { schema: PatchBody } }, required: true },
  },
  responses: {
    200: {
      description: 'updated',
      content: { 'application/json': { schema: MaintenanceRequest } },
    },
    ...errorResponses,
  },
});

export const maintenanceRequestsApp = newApiApp();

interface MaintenanceReadRow extends Record<string, unknown> {
  id: string;
  reporter_interaction_id?: string | null;
  reporter_party_type?: string | null;
  reporter_party_id?: string | null;
  reporter_label?: string | null;
  reporter_address?: string | null;
  reporter_channel?: string | null;
  reported_at?: string | null;
  reporter_attestation?: string | null;
}

function maintenanceResponse(row: MaintenanceReadRow): z.infer<typeof MaintenanceRequest> {
  const {
    reporter_interaction_id,
    reporter_party_type,
    reporter_party_id,
    reporter_label,
    reporter_address,
    reporter_channel,
    reported_at,
    reporter_attestation,
    ...request
  } = row;
  return {
    ...request,
    reported_by:
      reporter_interaction_id && reporter_party_type && reporter_channel && reported_at
        ? {
            source: 'interaction',
            interaction_id: reporter_interaction_id,
            party_type: reporter_party_type,
            party_id: reporter_party_id ?? null,
            label: reporter_label ?? null,
            address: reporter_address ?? null,
            channel: reporter_channel,
            reported_at,
            attestation: reporter_attestation ?? null,
          }
        : null,
  } as z.infer<typeof MaintenanceRequest>;
}

async function fetchMaintenanceRequest(
  sb: ReturnType<typeof getSb>,
  accountId: string,
  id: string,
): Promise<z.infer<typeof MaintenanceRequest>> {
  const { data, error } = await sb
    .from('maintenance_requests_with_reporter')
    .select('*')
    .eq('account_id', accountId)
    .eq('id', id)
    .is('deleted_at', null)
    .maybeSingle();
  if (error) throw new ApiError(500, 'database_error', error.message);
  if (!data) throw new ApiError(404, 'not_found', 'not found');
  return maintenanceResponse(data as unknown as MaintenanceReadRow);
}

maintenanceRequestsApp.openapi(list, async (c) => {
  const { accountId } = c.req.valid('param');
  const { cursor, limit, area_id, status } = c.req.valid('query');
  const sb = getSb(c);
  let q = sb
    .from('maintenance_requests_with_reporter')
    .select('*')
    .eq('account_id', accountId)
    .is('deleted_at', null);
  if (area_id) q = q.eq('area_id', area_id);
  const statuses = parseCsvEnum(status, Status.options, 'status');
  if (statuses) {
    const [only] = statuses;
    q = statuses.length === 1 && only ? q.eq('status', only) : q.in('status', statuses);
  }
  const { items, next_cursor: nextCursor } = await keysetPage(q, { cursor, limit });
  return c.json(
    {
      data: items.map((item) => maintenanceResponse(item as unknown as MaintenanceReadRow)),
      next_cursor: nextCursor,
    } as z.infer<typeof ListResponse>,
    200,
  );
});

maintenanceRequestsApp.openapi(get, async (c) => {
  const { accountId, id } = c.req.valid('param');
  const sb = getSb(c);
  return c.json(await fetchMaintenanceRequest(sb, accountId, id), 200);
});

maintenanceRequestsApp.openapi(create, async (c) => {
  const { accountId } = c.req.valid('param');
  const body = c.req.valid('json');
  const sb = getSb(c);
  const auth = c.get('auth');
  let createdId: string;

  if (body.report) {
    const params: DbFunctionArgs<'create_maintenance_request_with_report'> = {
      p_account_id: accountId,
      p_area_id: body.area_id,
      p_asset_id: nullableRpcArg(body.asset_id ?? null),
      p_title: body.title,
      p_description: nullableRpcArg(body.description ?? null),
      p_severity: body.severity,
      p_report_party_type: body.report.party_type,
      p_report_party_id: nullableRpcArg(body.report.party_id ?? null),
      p_report_label: nullableRpcArg(body.report.label ?? null),
      p_report_address: nullableRpcArg(body.report.address ?? null),
      p_report_channel: body.report.channel,
      p_reported_at: nullableRpcArg(body.report.reported_at ?? null),
      p_report_body: nullableRpcArg(body.report.body ?? null),
    };
    const { data, error } = await sb.rpc('create_maintenance_request_with_report', params);
    if (error) {
      const message = error.message ?? '';
      if (message.startsWith('not_found:')) {
        throw new ApiError(404, 'not_found', message.slice('not_found:'.length).trim());
      }
      if (message.startsWith('invalid:')) {
        throw new ApiError(400, 'invalid_request', message.slice('invalid:'.length).trim());
      }
      throw dbError(error);
    }
    const result = data as { maintenance_request_id?: unknown } | null;
    if (!result || typeof result.maintenance_request_id !== 'string') {
      throw new ApiError(500, 'database_error', 'report workflow returned no request id');
    }
    createdId = result.maintenance_request_id;
  } else {
    const { data, error } = await sb
      .from('maintenance_requests')
      .insert({
        account_id: accountId,
        area_id: body.area_id,
        asset_id: body.asset_id ?? null,
        opened_by: auth.userId,
        title: body.title,
        description: body.description ?? null,
        severity: body.severity,
        status: 'open',
      })
      .select('id')
      .single();
    if (error) {
      if (error.code === '23503') {
        throw new ApiError(404, 'not_found', 'area_id or asset_id does not belong to this account');
      }
      throw new ApiError(500, 'database_error', error.message);
    }
    createdId = data.id;
  }

  return c.json(await fetchMaintenanceRequest(sb, accountId, createdId), 201);
});

maintenanceRequestsApp.openapi(patch, async (c) => {
  const { accountId, id } = c.req.valid('param');
  const body = c.req.valid('json');
  const sb = getSb(c);

  // Server-enforced status transitions: fetch the current status, validate
  // the requested next state is reachable. Doing this in the handler (rather
  // than a DB trigger) keeps the error mapping clean -- 409 conflict on
  // bad transition, 404 on row-not-found.
  if (body.status !== undefined) {
    const { data: current, error: curErr } = await sb
      .from('maintenance_requests')
      .select('status')
      .eq('account_id', accountId)
      .eq('id', id)
      .is('deleted_at', null)
      .maybeSingle();
    if (curErr) throw new ApiError(500, 'database_error', curErr.message);
    if (!current) throw new ApiError(404, 'not_found', 'not found');
    const allowed = ALLOWED[current.status as z.infer<typeof Status>] ?? [];
    if (current.status !== body.status && !allowed.includes(body.status)) {
      throw new ApiError(
        409,
        'conflict',
        `status transition ${current.status} -> ${body.status} is not allowed`,
      );
    }
  }

  const update: DbTableUpdate<'maintenance_requests'> = { updated_at: new Date().toISOString() };
  if (body.description !== undefined) update.description = body.description;
  if (body.severity !== undefined) update.severity = body.severity;
  if (body.status !== undefined) update.status = body.status;
  if (body.asset_id !== undefined) update.asset_id = body.asset_id;

  const { data, error } = await sb
    .from('maintenance_requests')
    .update(update)
    .eq('account_id', accountId)
    .eq('id', id)
    .is('deleted_at', null)
    .select('id')
    .maybeSingle();
  if (error) throw new ApiError(500, 'database_error', error.message);
  if (!data) throw new ApiError(404, 'not_found', 'not found');
  return c.json(await fetchMaintenanceRequest(sb, accountId, data.id), 200);
});
