import { createRoute, z } from '@hono/zod-openapi';
import { newApiApp } from './_lib/app';
import { getSb } from '../supabase/request-client';
import { ApiError, errorResponses } from './_lib/error';
import {
  enableAgentForAccount,
  revokeAgentGrant,
} from '../admin/agent-grants';

// Authenticated routes for managing agent grants. The enable/revoke endpoints
// are owner/manager-only. The list endpoint is available to any member.
// All privileged work (service-role writes) is delegated to the admin helper;
// this file never touches supabase-admin.ts directly.

const AgentGrantRow = z
  .object({
    id: z.string().uuid(),
    account_id: z.string().uuid(),
    agent_principal_id: z.string().uuid(),
    agent_user_id: z.string().uuid(),
    scopes: z.array(z.string()),
    granted_by: z.string().uuid().nullable(),
    granted_at: z.string(),
    revoked_at: z.string().nullable(),
    revoked_by: z.string().uuid().nullable(),
  })
  .openapi('AgentGrantRow');

const ListResponse = z
  .object({ data: z.array(AgentGrantRow) })
  .openapi('AgentGrantListResponse');

const RevokeResponse = z
  .object({ id: z.string().uuid(), revoked_at: z.string() })
  .openapi('AgentGrantRevokeResponse');

const AccountParam = z.object({
  accountId: z.string().uuid().openapi({ param: { name: 'accountId', in: 'path' } }),
});
const GrantParam = z.object({
  accountId: z.string().uuid().openapi({ param: { name: 'accountId', in: 'path' } }),
  id: z.string().uuid().openapi({ param: { name: 'id', in: 'path' } }),
});

const list = createRoute({
  method: 'get',
  path: '/accounts/{accountId}/agent-grants',
  tags: ['agent-grants'],
  summary: "List an account's agent grants (active and revoked)",
  request: { params: AccountParam },
  responses: {
    200: { description: 'list', content: { 'application/json': { schema: ListResponse } } },
    ...errorResponses,
  },
});

const enable = createRoute({
  method: 'post',
  path: '/accounts/{accountId}/agent-grants',
  tags: ['agent-grants'],
  summary: 'Enable the agent for an account (owner/manager only)',
  request: { params: AccountParam },
  responses: {
    201: { description: 'enabled', content: { 'application/json': { schema: AgentGrantRow } } },
    ...errorResponses,
  },
});

const revoke = createRoute({
  method: 'post',
  path: '/accounts/{accountId}/agent-grants/{id}/revoke',
  tags: ['agent-grants'],
  summary: 'Revoke an active agent grant (owner/manager only)',
  request: { params: GrantParam },
  responses: {
    200: { description: 'revoked', content: { 'application/json': { schema: RevokeResponse } } },
    ...errorResponses,
  },
});

export const agentGrantsApp = newApiApp();

agentGrantsApp.openapi(list, async (c) => {
  const { accountId } = c.req.valid('param');
  const sb = getSb(c);
  const { data, error } = await sb
    .from('agent_grants')
    .select(
      'id, account_id, agent_principal_id, agent_user_id, scopes, granted_by, granted_at, revoked_at, revoked_by',
    )
    .eq('account_id', accountId)
    .order('granted_at', { ascending: false });
  if (error) throw new ApiError(500, 'database_error', error.message);
  return c.json({ data: (data ?? []) as z.infer<typeof AgentGrantRow>[] }, 200);
});

agentGrantsApp.openapi(enable, async (c) => {
  const { accountId } = c.req.valid('param');
  const role = c.get('account').role;
  if (role !== 'owner' && role !== 'manager') {
    throw new ApiError(403, 'forbidden', 'only an owner or manager may enable the agent');
  }
  const grant = await enableAgentForAccount(accountId, c.get('auth').userId);
  return c.json(grant, 201);
});

agentGrantsApp.openapi(revoke, async (c) => {
  const { accountId, id } = c.req.valid('param');
  const role = c.get('account').role;
  if (role !== 'owner' && role !== 'manager') {
    throw new ApiError(403, 'forbidden', 'only an owner or manager may revoke the agent');
  }
  const result = await revokeAgentGrant(accountId, id, c.get('auth').userId);
  return c.json(result, 200);
});
