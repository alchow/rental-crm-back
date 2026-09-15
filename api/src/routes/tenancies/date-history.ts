import { createRoute, z } from '@hono/zod-openapi';
import { newApiApp } from '../_lib/app';
import { errorResponses, conflictResponse } from '../_lib/error';
import { keysetPage } from '../_lib/cursor';
import { getSb } from '../../supabase/request-client';
import { AccountAndTenancyParam, ContextFingerprint, DateFacts, DateReasonCode, SelectedDateContext, Tenancy } from './schemas';
import { atomicDateArgs, dateRpc } from './rpc';

const SourceDocumentSnapshot = z
  .object({
    id: z.string().uuid(),
    title: z.string().nullable(),
    versions: z.array(z.object({
      id: z.string().uuid(),
      content_hash: z.string().nullable(),
      version_no: z.number().int(),
      attachment_id: z.string().uuid().nullable(),
      created_at: z.string(),
    })),
    reference_kind: z.enum(['content_hashes', 'unversioned_reference']),
  })
  .nullable();

export const TenancyDateRecord = z
  .object({
    id: z.string().uuid(),
    account_id: z.string().uuid(),
    tenancy_id: z.string().uuid(),
    kind: z.enum(['correction', 'explanation']),
    before_facts: DateFacts,
    after_facts: DateFacts,
    context_snapshot: z.record(z.unknown()),
    context_fingerprint: z.string(),
    reason_code: DateReasonCode,
    reason_note: z.string(),
    source_document_id: z.string().uuid().nullable(),
    source_document_snapshot: SourceDocumentSnapshot,
    created_by: z.string().uuid(),
    created_at: z.string(),
  })
  .openapi('TenancyDateRecord');

export const TenancyDateCommandResponse = z
  .object({ tenancy: Tenancy, record: TenancyDateRecord })
  .openapi('TenancyDateCommandResponse');

const ExplainBody = z
  .object({
    expected_context_fingerprint: ContextFingerprint,
    ...SelectedDateContext,
    reason_code: DateReasonCode,
    reason_note: z.string().trim().min(1).max(2000),
    source_document_id: z.string().uuid().optional(),
  })
  .openapi('RecordTenancyDateExplanationBody');

const HistoryQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().positive().max(100).default(50),
});
const HistoryResponse = z
  .object({ data: z.array(TenancyDateRecord), next_cursor: z.string().nullable() })
  .openapi('TenancyDateHistoryResponse');

const explain = createRoute({
  method: 'post', path: '/accounts/{accountId}/tenancies/{tenancyId}/date-explanations',
  tags: ['tenancies'], summary: 'Explain the selected tenancy dates without changing them',
  request: { params: AccountAndTenancyParam, body: { required: true, content: { 'application/json': { schema: ExplainBody } } } },
  responses: { 200: { description: 'recorded', content: { 'application/json': { schema: TenancyDateCommandResponse } } }, ...errorResponses, ...conflictResponse },
});
const history = createRoute({
  method: 'get', path: '/accounts/{accountId}/tenancies/{tenancyId}/date-history',
  tags: ['tenancies'], summary: 'List immutable tenancy date corrections and explanations',
  request: { params: AccountAndTenancyParam, query: HistoryQuery },
  responses: { 200: { description: 'page', content: { 'application/json': { schema: HistoryResponse } } }, ...errorResponses },
});

export const tenancyDateHistoryApp = newApiApp();

tenancyDateHistoryApp.openapi(explain, async (c) => {
  const { accountId, tenancyId } = c.req.valid('param');
  const body = c.req.valid('json');
  const data = await dateRpc<z.infer<typeof TenancyDateCommandResponse>>(
    c, 'record_tenancy_date_explanation',
    { p_account_id: accountId, p_tenancy_id: tenancyId, ...atomicDateArgs(c, body) },
  );
  c.set('idempotencyCompletedAtomically', true);
  return c.json(data, 200);
});

tenancyDateHistoryApp.openapi(history, async (c) => {
  const { accountId, tenancyId } = c.req.valid('param');
  const { cursor, limit } = c.req.valid('query');
  const sb = getSb(c);
  const query = sb.from('tenancy_date_records').select(
    'id,account_id,tenancy_id,kind,before_facts,after_facts,context_snapshot,context_fingerprint,reason_code,reason_note,source_document_id,source_document_snapshot,created_by,created_at',
  ).eq('account_id', accountId).eq('tenancy_id', tenancyId);
  const { items, next_cursor } = await keysetPage(query, { cursor, limit });
  return c.json({ data: items, next_cursor } as z.infer<typeof HistoryResponse>, 200);
});
