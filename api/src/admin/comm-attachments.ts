// Comm attachment store (admin-side, service-role) — persona plan, phase 7.
//
// Durable blobs for attachments on comm-captured journal rows. Same posture
// as the evidence archive (evidence.ts): the private 'comm-attachments'
// bucket has NO authenticated storage policies, so bytes move only through
// this module; paths are server-constructed and content-addressed
// (`<account>/<interaction>/<sha256>`), so callers never choose where bytes
// land and identical payloads dedupe per message.
//
// The metadata row lives on the existing polymorphic `attachments` table
// (entity_type='interactions'); members read rows under the normal RLS
// policy — only the BYTES are service-mediated (download below re-checks the
// row's account before touching storage).

import { createHash } from 'node:crypto';
import { getAdminClient } from './supabase-admin';
import { ApiError } from '../routes/_lib/error';

const BUCKET = 'comm-attachments';

/** Per-file cap. Mail providers top out near 25 MiB per MESSAGE; a single
 *  oversized part is the transport's problem to drop, not ours to store. */
export const MAX_COMM_ATTACHMENT_BYTES = 10 * 1024 * 1024; // 10 MiB
/** Per-message cap — matches the capture media[] cap. */
export const MAX_COMM_ATTACHMENTS_PER_MESSAGE = 10;

export interface CommAttachmentRow {
  id: string;
  filename: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  content_hash: string;
  created_at: string;
}

const ATTACHMENT_COLS = 'id, filename, mime_type, size_bytes, content_hash, created_at';

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

  const { data, error } = await admin
    .from('attachments')
    .insert({
      account_id: accountId,
      entity_type: 'interactions',
      entity_id: interactionId,
      storage_path: storagePath,
      content_hash: sha256,
      mime_type: contentType || null,
      size_bytes: bytes.byteLength,
      filename,
    })
    .select(ATTACHMENT_COLS)
    .single();
  if (error) {
    if (error.code === '23505') {
      // Same content already attached to this interaction: idempotent.
      const { data: existing, error: exErr } = await admin
        .from('attachments')
        .select(ATTACHMENT_COLS)
        .eq('account_id', accountId)
        .eq('entity_type', 'interactions')
        .eq('entity_id', interactionId)
        .eq('content_hash', sha256)
        // The content-idempotency unique index is PARTIAL on `deleted_at is
        // null`, so after a soft-delete + re-upload of identical bytes a
        // tombstone and a live row coexist for this (interaction, content);
        // filtering to the live row keeps `.single()` matching exactly one.
        .is('deleted_at', null)
        .single();
      if (exErr) throw new ApiError(500, 'database_error', exErr.message);
      return existing as CommAttachmentRow;
    }
    throw new ApiError(500, 'database_error', `attachment row insert failed: ${error.message}`);
  }
  return data as CommAttachmentRow;
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
    .select('storage_path, mime_type, filename')
    .eq('account_id', accountId)
    .eq('entity_type', 'interactions')
    .eq('entity_id', interactionId)
    .eq('id', attachmentId)
    .is('deleted_at', null)
    .maybeSingle();
  if (error) throw new ApiError(500, 'database_error', error.message);
  if (!row) throw new ApiError(404, 'not_found', 'not found');

  const { data: blob, error: dlErr } = await admin.storage
    .from(BUCKET)
    .download(row.storage_path as string);
  if (dlErr || !blob) {
    throw new ApiError(500, 'database_error', `attachment download failed: ${dlErr?.message}`);
  }
  return {
    bytes: new Uint8Array(await blob.arrayBuffer()),
    mimeType: (row.mime_type as string | null) ?? 'application/octet-stream',
    filename: (row.filename as string | null) ?? 'attachment',
  };
}
