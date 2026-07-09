import { createRoute } from '@hono/zod-openapi';
import type { z } from '@hono/zod-openapi';
import { getSb } from '../../supabase/request-client';
import { ApiError, errorResponses } from '../_lib/error';
import {
  downloadCommAttachment,
  MAX_COMM_ATTACHMENTS_PER_MESSAGE,
  storeCommAttachment,
} from '../../admin/comm-attachments';
import {
  CommAttachment,
  CommAttachmentListResponse,
  InteractionAttachmentParams,
  UploadCommAttachmentBody,
} from './schemas';
import { commDbError, requireTransport, type CommsApp } from './shared';

export function registerAttachmentRoutes(app: CommsApp): void {
  const uploadInteractionAttachment = createRoute({
    method: 'post',
    path: '/accounts/{accountId}/interactions/{interactionId}/attachments',
    tags: ['comms'],
    summary:
      'Attach original file bytes to a comm-captured journal row (transport). ' +
      'Only rows written by the verified capture paths accept attachments; the ' +
      'transport uploads AFTER capture using the returned interaction_id (skip ' +
      'on duplicate). Idempotent per (interaction, content): a retry returns ' +
      'the existing attachment.',
    request: {
      params: InteractionAttachmentParams,
      body: {
        content: { 'application/json': { schema: UploadCommAttachmentBody } },
        required: true,
      },
    },
    responses: {
      201: {
        description: 'stored attachment',
        content: { 'application/json': { schema: CommAttachment } },
      },
      ...errorResponses,
    },
  });

  const listInteractionAttachments = createRoute({
    method: 'get',
    path: '/accounts/{accountId}/interactions/{interactionId}/attachments',
    tags: ['comms'],
    summary:
      "An interaction's stored attachments (any member). Bytes stream from " +
      'GET …/attachments/{attachmentId}/download.',
    request: { params: InteractionAttachmentParams },
    responses: {
      200: {
        description: 'attachments',
        content: { 'application/json': { schema: CommAttachmentListResponse } },
      },
      ...errorResponses,
    },
  });

  // capture paths only (a manually-journaled row has no provider-delivered
  // bytes to vouch for).
  const COMM_CAPTURE_ACTORS = [
    'system:comm-inbound',
    'system:comm-persona',
    'system:comm-persona-cc',
  ];

  app.openapi(uploadInteractionAttachment, async (c) => {
    requireTransport(c);
    const { accountId, interactionId } = c.req.valid('param');
    const body = c.req.valid('json');
    const sb = getSb(c);

    if (body.data_b64.length % 4 !== 0) {
      throw new ApiError(400, 'invalid_request', 'data_b64 is not valid base64', {
        fieldErrors: { data_b64: ['not valid base64 (length not a multiple of 4)'] },
      });
    }
    const bytes = Buffer.from(body.data_b64, 'base64');

    // Only verified comm captures accept attachments.
    const { data: interaction, error } = await sb
      .from('interactions')
      .select('id, actor, attestation')
      .eq('account_id', accountId)
      .eq('id', interactionId)
      .maybeSingle();
    if (error) throw commDbError(error);
    if (!interaction) throw new ApiError(404, 'not_found', 'not found');
    if (
      !COMM_CAPTURE_ACTORS.includes(interaction.actor as string) ||
      interaction.attestation !== 'provider_verified'
    ) {
      throw new ApiError(
        400,
        'invalid_request',
        'attachments may only be stored on provider-verified comm captures',
      );
    }

    const { count, error: cntErr } = await sb
      .from('attachments')
      .select('id', { count: 'exact', head: true })
      .eq('account_id', accountId)
      .eq('entity_type', 'interactions')
      .eq('entity_id', interactionId)
      .is('deleted_at', null);
    if (cntErr) throw commDbError(cntErr);
    if ((count ?? 0) >= MAX_COMM_ATTACHMENTS_PER_MESSAGE) {
      throw new ApiError(
        400,
        'invalid_request',
        `a message carries at most ${MAX_COMM_ATTACHMENTS_PER_MESSAGE} stored attachments`,
      );
    }

    const row = await storeCommAttachment(
      accountId,
      interactionId,
      body.filename,
      body.content_type,
      bytes,
    );
    return c.json(row, 201);
  });

  app.openapi(listInteractionAttachments, async (c) => {
    const { accountId, interactionId } = c.req.valid('param');
    const sb = getSb(c);
    const { data, error } = await sb
      .from('attachments')
      .select('id, filename, mime_type, size_bytes, content_hash, created_at')
      .eq('account_id', accountId)
      .eq('entity_type', 'interactions')
      .eq('entity_id', interactionId)
      .is('deleted_at', null)
      .order('created_at', { ascending: true });
    if (error) throw commDbError(error);
    return c.json({ data: (data ?? []) as z.infer<typeof CommAttachment>[] }, 200);
  });

  // Binary download proxy (NOT openapi — mirrors the documents/inspection
  // pattern): forced Content-Disposition, nosniff, CSP sandbox. The account
  // middleware stack (auth + membership) has already run for /accounts/*; the
  // admin module re-checks the row's account before touching the bucket.
  app.get(
    '/accounts/:accountId/interactions/:interactionId/attachments/:attachmentId/download',
    async (c) => {
      const accountId = c.req.param('accountId');
      const interactionId = c.req.param('interactionId');
      const attachmentId = c.req.param('attachmentId');
      const dl = await downloadCommAttachment(accountId, interactionId, attachmentId);
      return new Response(dl.bytes, {
        status: 200,
        headers: {
          'content-type': dl.mimeType,
          'content-disposition': `attachment; filename="${dl.filename.replace(/"/g, '')}"`,
          'content-length': String(dl.bytes.byteLength),
          'cache-control': 'private, no-store',
          'x-content-type-options': 'nosniff',
          'content-security-policy': "default-src 'none'; sandbox",
        },
      });
    },
  );
}
