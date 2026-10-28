import { createHash } from 'node:crypto';
import { getAdminClient } from './supabase-admin';
import { readAttachmentBytes } from './storage/locator';
import { commDbError } from '../routes/comms/shared';
import { ApiError } from '../routes/_lib/error';

const BUCKET = 'comm-attachments';

/** Per-file cap. Mail providers top out near 25 MiB per MESSAGE; a single
 *  oversized part is the transport's problem to drop, not ours to store. */
export const MAX_COMM_ATTACHMENT_BYTES = 10 * 1024 * 1024; // 10 MiB
/** Distinct stored files; excess provider slots retain rejected outcomes. */
export const MAX_COMM_ATTACHMENTS_PER_MESSAGE = 10;

export interface CommAttachmentRow {
  id: string;
  filename: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  content_hash: string;
  created_at: string;
}

/**
 * Store one attachment for a comm-captured interaction: bytes into the
 * private bucket (hash-addressed, upsert-safe), metadata row onto
 * `attachments`. Idempotent per (interaction, content): a duplicate upload
 * returns the existing row (the 20260629000001 per-entity content-hash
 * uniqueness), so transport retries never double-store.
 */
export async function storeCommAttachment(
  accountId: string,
  interactionId: string,
  filename: string,
  contentType: string,
  bytes: Uint8Array,
  mediaSlotId?: string,
): Promise<CommAttachmentRow> {
  if (bytes.byteLength === 0) {
    throw new ApiError(400, 'invalid_request', 'attachment decodes to zero bytes');
  }
  if (bytes.byteLength > MAX_COMM_ATTACHMENT_BYTES) {
    throw new ApiError(
      400,
      'invalid_request',
      `attachment exceeds max size (${bytes.byteLength} > ${MAX_COMM_ATTACHMENT_BYTES} bytes)`,
    );
  }
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const storagePath = `${accountId}/${interactionId}/${sha256}`;
  const admin = getAdminClient();

  // Bytes first (hash-addressed: an overwrite writes identical bytes), then
  // the row — a crash between the two heals on retry, and a row never points
  // at bytes that are not there.
  const { error: upErr } = await admin.storage.from(BUCKET).upload(storagePath, bytes, {
    contentType: contentType || 'application/octet-stream',
    upsert: true,
  });
  if (upErr) {
    throw new ApiError(500, 'database_error', `attachment upload failed: ${upErr.message}`);
  }

  const { data, error } = await admin.rpc('store_comm_attachment', {
    p_account_id: accountId,
    p_interaction_id: interactionId,
    p_filename: filename,
    p_content_type: contentType,
    p_storage_path: storagePath,
    p_content_hash: sha256,
    p_size_bytes: bytes.byteLength,
    p_media_slot_id: mediaSlotId,
  });
  if (error) throw commDbError(error);
  const row = data as CommAttachmentRow;
  return {
    id: row.id,
    filename: row.filename,
    mime_type: row.mime_type,
    size_bytes: row.size_bytes,
    content_hash: row.content_hash,
    created_at: row.created_at,
  };
}

export interface CommAttachmentDownload {
  bytes: Uint8Array;
  mimeType: string;
  filename: string;
}

/**
 * Fetch one attachment's bytes for a member read. The ROUTE has already
 * asserted account membership; this re-checks that the row belongs to the
 * account and is an interactions attachment before touching the bucket
 * (defense in depth for the service-role storage read).
 */
export async function downloadCommAttachment(
  accountId: string,
  interactionId: string,
  attachmentId: string,
): Promise<CommAttachmentDownload> {
  const admin = getAdminClient();
  const { data: row, error } = await admin
    .from('attachments')
    .select('account_id, storage_bucket, storage_path, content_hash, mime_type, filename')
    .eq('account_id', accountId)
    .eq('entity_type', 'interactions')
    .eq('entity_id', interactionId)
    .eq('id', attachmentId)
    .is('deleted_at', null)
    .maybeSingle();
  if (error) throw new ApiError(500, 'database_error', error.message);
  if (!row) throw new ApiError(404, 'not_found', 'not found');

  const bytes = await readAttachmentBytes(row);
  return {
    bytes,
    mimeType: (row.mime_type as string | null) ?? 'application/octet-stream',
    filename: (row.filename as string | null) ?? 'attachment',
  };
}
