import { createRoute, z } from '@hono/zod-openapi';
import { getSb } from '../../supabase/request-client';
import { asJson } from '../../supabase/db-types';
import { ApiError, errorResponses } from '../_lib/error';
import { keysetPage } from '../_lib/cursor';
import {
  AccountAndIdParam,
  AccountParam,
  CommPolicy,
  CommPolicyKind,
  CommPolicyStatus,
  CreatePolicyBody,
  PolicyListResponse,
} from './schemas';
import { commDbError, requireAgentOrManager, requireManager, type CommsApp } from './shared';

export function registerPolicyRoutes(app: CommsApp): void {
  const listPolicies = createRoute({
    method: 'get',
    path: '/accounts/{accountId}/comms/policies',
    tags: ['comms'],
    summary: 'List standing communication policies (transport + landlord).',
    request: {
      params: AccountParam,
      query: z.object({
        cursor: z.string().optional(),
        limit: z.coerce.number().int().positive().max(100).default(50),
        status: CommPolicyStatus.optional(),
        policy_kind: CommPolicyKind.optional(),
      }),
    },
    responses: {
      200: { description: 'page', content: { 'application/json': { schema: PolicyListResponse } } },
      ...errorResponses,
    },
  });

  const createPolicy = createRoute({
    method: 'post',
    path: '/accounts/{accountId}/comms/policies',
    tags: ['comms'],
    summary:
      'Create a standing grant (landlord, owner|manager). Creation IS the ' +
      'approval act: approved_by is stamped from the caller. Sends made under it ' +
      "carry approval_ref='grant:<id>' with approved_by null — the journal stays " +
      'honest that no human read those specific messages.',
    request: {
      params: AccountParam,
      body: { content: { 'application/json': { schema: CreatePolicyBody } }, required: true },
    },
    responses: {
      201: { description: 'created', content: { 'application/json': { schema: CommPolicy } } },
      ...errorResponses,
    },
  });

  const revokePolicy = createRoute({
    method: 'post',
    path: '/accounts/{accountId}/comms/policies/{id}/revoke',
    tags: ['comms'],
    summary:
      'Revoke a standing grant (landlord, owner|manager). Already-queued sends ' +
      'authorized by it are cancelled where still unsent.',
    request: { params: AccountAndIdParam },
    responses: {
      200: {
        description: 'revoked policy',
        content: { 'application/json': { schema: CommPolicy } },
      },
      ...errorResponses,
    },
  });

  const RENT_REMINDER_PARAMS = z
    .object({
      days_before: z.number().int().min(0).max(60),
      monthly_cap: z.number().int().min(1).max(100),
    })
    .strict();

  function validatePolicyParams(kind: string, params: Record<string, unknown>): void {
    if (kind === 'rent_reminder') {
      const parsed = RENT_REMINDER_PARAMS.safeParse(params);
      if (!parsed.success) {
        throw new ApiError(
          400,
          'invalid_request',
          'rent_reminder params must be exactly { days_before: number, monthly_cap: number }',
          { fieldErrors: { params: [parsed.error.issues.map((i) => i.message).join('; ')] } },
        );
      }
    }
    // thread_autonomy / voice_autonomy: no canonical params agreed yet;
    // pass-through until the coordinator publishes their shapes.
  }

  app.openapi(listPolicies, async (c) => {
    // Transport + landlord: the transport reads active grants for send
    // provenance (grant:<id> approval_ref). Create/revoke stay manager-only.
    requireAgentOrManager(c);
    const { accountId } = c.req.valid('param');
    const { cursor, limit, status, policy_kind } = c.req.valid('query');
    const sb = getSb(c);
    let q = sb.from('comm_policies').select('*').eq('account_id', accountId);
    if (status !== undefined) q = q.eq('status', status);
    if (policy_kind !== undefined) q = q.eq('policy_kind', policy_kind);
    const { items, next_cursor } = await keysetPage<z.infer<typeof CommPolicy>>(q, {
      cursor,
      limit,
      descending: true,
    });
    return c.json({ data: items, next_cursor }, 200);
  });

  app.openapi(createPolicy, async (c) => {
    requireManager(c);
    const { accountId } = c.req.valid('param');
    const body = c.req.valid('json');
    validatePolicyParams(body.policy_kind, body.params);
    const sb = getSb(c);
    const { data, error } = await sb
      .from('comm_policies')
      .insert({
        account_id: accountId,
        policy_kind: body.policy_kind,
        channel: body.channel,
        template_id: body.template_id ?? null,
        params: asJson(body.params),
        quiet_hours: asJson(body.quiet_hours ?? null),
        // Creation IS the approval act.
        approved_by: c.get('auth').userId,
      })
      .select('*')
      .single();
    if (error) throw commDbError(error);
    return c.json(data as z.infer<typeof CommPolicy>, 201);
  });

  app.openapi(revokePolicy, async (c) => {
    requireManager(c);
    const { accountId, id } = c.req.valid('param');
    const sb = getSb(c);
    const userId = c.get('auth').userId;

    const { data: existing, error: exErr } = await sb
      .from('comm_policies')
      .select('*')
      .eq('account_id', accountId)
      .eq('id', id)
      .maybeSingle();
    if (exErr) throw commDbError(exErr);
    if (!existing) throw new ApiError(404, 'not_found', 'not found');
    // Replay-friendly: revoking a revoked policy returns it unchanged.
    if (existing.status === 'revoked') {
      return c.json(existing as z.infer<typeof CommPolicy>, 200);
    }

    const { data: revoked, error } = await sb
      .from('comm_policies')
      .update({ status: 'revoked', revoked_by: userId, revoked_at: new Date().toISOString() })
      .eq('account_id', accountId)
      .eq('id', id)
      .eq('status', 'active')
      .select('*')
      .maybeSingle();
    if (error) throw commDbError(error);
    // Lost a concurrent-revoke race (the status='active' filter matched zero
    // rows): stay replay-friendly — re-read and return the already-revoked row
    // rather than surfacing a spurious 500 from a single-row expectation.
    if (!revoked) {
      const { data: current, error: reErr } = await sb
        .from('comm_policies')
        .select('*')
        .eq('account_id', accountId)
        .eq('id', id)
        .maybeSingle();
      if (reErr) throw commDbError(reErr);
      if (!current) throw new ApiError(404, 'not_found', 'not found');
      return c.json(current as z.infer<typeof CommPolicy>, 200);
    }

    // Queued-but-unsent intents authorized by this grant die with it. 'sending'
    // rows are mid-flight (the transport re-checks policy status before dialing
    // new work, and delivery callbacks still land).
    const { error: parkErr } = await sb
      .from('comm_outbox')
      .update({
        status: 'undeliverable',
        error_code: 'policy_revoked',
        error_message: 'standing grant revoked before dispatch',
      })
      .eq('account_id', accountId)
      .eq('status', 'queued')
      .eq('approval_ref', `grant:${id}`);
    if (parkErr) throw commDbError(parkErr);

    return c.json(revoked as z.infer<typeof CommPolicy>, 200);
  });
}
