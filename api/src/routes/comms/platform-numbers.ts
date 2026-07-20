import { createRoute, z } from '@hono/zod-openapi';
import { getSb } from '../../supabase/request-client';
import { ApiError, errorResponses } from '../_lib/error';
import {
  AccountParam,
  PlatformNumber,
  PlatformNumberListResponse,
  RecordPlatformNumberBody,
} from './schemas';
import { commDbError, requireAgentOrManager, requireTransport, type CommsApp } from './shared';

// Ordered newest-first and capped: an account holds a handful of numbers (one
// in practice), so this is a bounded read with no cursor rather than a page.
const MAX_NUMBERS = 100;

export function registerPlatformNumberRoutes(app: CommsApp): void {
  const listPlatformNumbers = createRoute({
    method: 'get',
    path: '/accounts/{accountId}/comms/platform-numbers',
    tags: ['comms'],
    summary:
      "List the account's provider numbers (transport + landlord). The " +
      'transport reads these to route inbound messages to an account and to ' +
      'pick the From number for outbound sends; the landlord reads them to ' +
      'know whether texting is switched on. Filter status=active for routing — ' +
      'a released number must not resolve to the account that used to hold it.',
    request: {
      params: AccountParam,
      query: z.object({ status: z.enum(['active', 'released']).optional() }),
    },
    responses: {
      200: {
        description: 'numbers',
        content: { 'application/json': { schema: PlatformNumberListResponse } },
      },
      ...errorResponses,
    },
  });

  const recordPlatformNumber = createRoute({
    method: 'post',
    path: '/accounts/{accountId}/comms/platform-numbers',
    tags: ['comms'],
    summary:
      'Register a number the transport ordered from the carrier (transport ' +
      'only). Idempotent on (account, number) so a replayed provisioning step ' +
      'is a no-op, and re-activates a released number. A number already held ' +
      'by another account is a 409, never a reassignment.',
    request: {
      params: AccountParam,
      body: { content: { 'application/json': { schema: RecordPlatformNumberBody } }, required: true },
    },
    responses: {
      201: {
        description: 'registered',
        content: { 'application/json': { schema: PlatformNumber } },
      },
      ...errorResponses,
    },
  });

  app.openapi(listPlatformNumbers, async (c) => {
    requireAgentOrManager(c);
    const { accountId } = c.req.valid('param');
    const { status } = c.req.valid('query');
    const sb = getSb(c);
    let q = sb
      .from('platform_numbers')
      .select('*')
      .eq('account_id', accountId)
      .order('created_at', { ascending: false })
      .limit(MAX_NUMBERS);
    if (status !== undefined) q = q.eq('status', status);
    const { data, error } = await q;
    if (error) throw commDbError(error);
    return c.json({ data: (data ?? []) as z.infer<typeof PlatformNumber>[] }, 200);
  });

  app.openapi(recordPlatformNumber, async (c) => {
    requireTransport(c);
    const { accountId } = c.req.valid('param');
    const body = c.req.valid('json');
    const sb = getSb(c);
    // The RPC is SECURITY DEFINER and re-asserts the agent principal itself:
    // platform_numbers is force-RLS with no member write policy, so this is the
    // only write door. Empty capabilities coalesce to {sms} inside the RPC.
    const { data, error } = await sb.rpc('record_platform_number', {
      p_account_id: accountId,
      p_number: body.number,
      p_provider: body.provider,
      p_capabilities: body.capabilities ?? [],
    });
    if (error) {
      // The generic 23505 text from commDbError ("provider_sid or routing key")
      // would be actively misleading here — the only unique a registration can
      // collide with across accounts is the global number key.
      if (error.code === '23505') {
        throw new ApiError(
          409,
          'conflict',
          'that number is already registered to another account',
        );
      }
      throw commDbError(error);
    }
    return c.json(data as z.infer<typeof PlatformNumber>, 201);
  });
}
