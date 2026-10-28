import type { z } from '@hono/zod-openapi';
import type { AppSupabaseClient } from '../../supabase/db-types';
import type { CommMessageMedia, CommAttachment } from './schema/attachments';
import { commDbError } from './shared';

type Media = z.infer<typeof CommMessageMedia>;
const SLOT_COLS =
  'id, interaction_id, provider_media_index, state, failure_code, updated_at, attachment_id';
const FILE_COLS = 'id, filename, mime_type, size_bytes, content_hash, created_at';

/** Current media state deliberately ignores the history page's creation snapshot. */
export async function loadMessageMedia(
  sb: AppSupabaseClient,
  accountId: string,
  interactionIds: string[],
): Promise<Map<string, Media[]>> {
  const result = new Map<string, Media[]>();
  for (let offset = 0; offset < interactionIds.length; offset += 10) {
    const ids = interactionIds.slice(offset, offset + 10);
    const slots = await sb
      .from('comm_message_media')
      .select(SLOT_COLS)
      .eq('account_id', accountId)
      .in('interaction_id', ids)
      .order('provider_media_index');
    if (slots.error) throw commDbError(slots.error);
    const attachmentIds = [
      ...new Set((slots.data ?? []).flatMap((s) => (s.attachment_id ? [s.attachment_id] : []))),
    ];
    const files = new Map<string, z.infer<typeof CommAttachment>>();
    for (let i = 0; i < attachmentIds.length; i += 100) {
      const rows = await sb
        .from('attachments')
        .select(FILE_COLS)
        .eq('account_id', accountId)
        .in('id', attachmentIds.slice(i, i + 100))
        .is('deleted_at', null);
      if (rows.error) throw commDbError(rows.error);
      for (const row of rows.data ?? []) files.set(row.id, row);
    }
    for (const slot of slots.data ?? []) {
      if (!slot.interaction_id) continue;
      const attachment = slot.attachment_id ? (files.get(slot.attachment_id) ?? null) : null;
      const media: Media = {
        id: slot.id,
        provider_media_index: slot.provider_media_index,
        state: slot.state as Media['state'],
        failure_code: slot.failure_code as Media['failure_code'],
        updated_at: slot.updated_at,
        attachment,
      };
      const list = result.get(slot.interaction_id) ?? [];
      list.push(media);
      result.set(slot.interaction_id, list);
    }
  }
  return result;
}
