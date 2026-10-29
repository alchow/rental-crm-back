import { createRoute, z } from '@hono/zod-openapi';
import { getSb } from '../../supabase/request-client';
import { reportCommMediaOutcome } from '../../admin/comm-media';
import { ApiError, errorResponses } from '../_lib/error';
import {
  CommMediaOutcomeBody,
  CommMessageMedia,
  CommMessageMediaList,
  InteractionAttachmentParams,
} from './schema/attachments';
import { loadMessageMedia } from './media-read';
import { commDbError, requireTransport, type CommsApp } from './shared';

export function registerMediaRoutes(app: CommsApp): void {
  app.openapi(
    createRoute({
      method: 'get',
      path: '/accounts/{accountId}/interactions/{interactionId}/media',
      tags: ['comms'],
      summary: 'Current provider media outcomes and stored files from the record chain root.',
      request: { params: InteractionAttachmentParams },
      responses: {
        200: {
          description: 'media',
          content: { 'application/json': { schema: CommMessageMediaList } },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const { accountId, interactionId } = c.req.valid('param');
      const sb = getSb(c);
      const parent = await sb
        .from('interactions')
        .select('id, deleted_at')
        .eq('account_id', accountId)
        .eq('id', interactionId)
        .maybeSingle();
      if (parent.error) throw commDbError(parent.error);
      if (!parent.data) throw new ApiError(404, 'not_found', 'not found');
      const root = await sb.rpc('interaction_media_root', {
        p_account_id: accountId,
        p_interaction_id: interactionId,
      });
      if (root.error) throw commDbError(root.error);
      const rootId = root.data;
      const media =
        parent.data.deleted_at || !rootId
          ? []
          : ((await loadMessageMedia(sb, accountId, [rootId])).get(rootId) ?? []);
      return c.json({ data: media }, 200);
    },
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: '/accounts/{accountId}/interactions/{interactionId}/media/{mediaSlotId}/outcome',
      tags: ['comms'],
      summary: 'Report a transport media outcome; saved and rejected outcomes cannot regress.',
      request: {
        params: InteractionAttachmentParams.extend({ mediaSlotId: z.string().uuid() }),
        body: { content: { 'application/json': { schema: CommMediaOutcomeBody } }, required: true },
      },
      responses: {
        200: {
          description: 'media outcome',
          content: { 'application/json': { schema: CommMessageMedia } },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      requireTransport(c);
      const { accountId, interactionId, mediaSlotId } = c.req.valid('param');
      const body = c.req.valid('json');
      await reportCommMediaOutcome({
        accountId,
        interactionId,
        slotId: mediaSlotId,
        state: body.state,
        failureCode: body.failure_code,
        attemptGeneration: body.attempt_generation,
      });
      const media = (await loadMessageMedia(getSb(c), accountId, [interactionId]))
        .get(interactionId)
        ?.find((m) => m.id === mediaSlotId);
      if (!media) throw new ApiError(404, 'not_found', 'not found');
      return c.json(media, 200);
    },
  );
}
