import { createHash } from 'node:crypto';
import { getAdminClient } from './supabase-admin';
import { ApiError } from '../routes/_lib/error';

// ============================================================================
// Attachment storage helpers (admin-side, service-role).
// ============================================================================
//
// Why admin-side: Supabase Storage with our RLS policies grants SELECT to
// account members (member-read) but NOT INSERT / UPDATE / DELETE. All
// writes route through this module so that:
//
//   (1) the content hash is computed SERVER-SIDE from the bytes we actually
//       store (a client-supplied hash is worthless for tamper evidence);
//   (2) the path is server-constructed; submitters never get to choose
//       which account / entity their file lands under;
//   (3) the storage path is byte-identical to <hash>.<ext>, so even if a
//       second upload of the SAME bytes happens, the path collides and we
//       can dedupe (or just accept the upsert).
//
// Reads also route through the API (a tiny proxy below) so we can force
// Content-Disposition: attachment + a safe Content-Type. Serving an
// uploaded HTML / SVG inline from the app origin would be stored-XSS;
// proxying with explicit headers removes that path.

const BUCKET = 'attachments';
export const MAX_BYTES = 20 * 1024 * 1024; // 20 MiB

// Allow-list of MIME types we accept. Tight on purpose -- a broader list
// without scanning is a malware vector. Phase 8 ships with the records
// people actually photograph (jpeg/png/webp/heic) plus PDF for the
// generated inspection report.
export const ALLOWED_MIME_TYPES = new Set<string>([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
  'application/pdf',
]);

// entity_type values the API will accept on the attachments table.
// Other entity_types would let an upload land "anywhere" semantically;
// keeping it tight makes audit reads predictable.
export const ALLOWED_ENTITY_TYPES = new Set<string>([
  'maintenance_requests',
  'inspections',
  'inspection_report',
  'interactions',
]);

function mimeToExt(mime: string): string {
  switch (mime) {
    case 'image/jpeg': return 'jpg';
    case 'image/png':  return 'png';
    case 'image/webp': return 'webp';
    case 'image/heic': return 'heic';
    case 'image/heif': return 'heif';
    case 'application/pdf': return 'pdf';
    default: return 'bin';
  }
}

function safeFilename(original: string | undefined, mime: string): string {
  // Strip anything that isn't [A-Za-z0-9._-], cap length, and ensure an
  // extension matching the MIME type. The filename only ever appears in
  // Content-Disposition on download; it never affects storage path or
  // entity_type.
  const base = (original ?? 'attachment').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 100);
  const ext = mimeToExt(mime);
  return base.toLowerCase().endsWith('.' + ext) ? base : `${base}.${ext}`;
}

export interface UploadInput {
  accountId: string;
  entityType: string;
  entityId: string;
  bytes: Uint8Array;
  mimeType: string;
  filename?: string;
  uploadedBy?: string | null;
  /** For the intake path: actor='tenant:<token_id>'. Goes into audit. */
  auditActor?: string;
}

export interface AttachmentRow {
  id: string;
  account_id: string;
  entity_type: string;
  entity_id: string;
  storage_path: string;
  content_hash: string;
  mime_type: string | null;
  size_bytes: number | null;
  uploaded_by: string | null;
  received_at: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

/**
 * Uploads the given bytes to private storage at an account-scoped path and
 * inserts the attachments row. Always hashes the bytes we're about to write
 * -- a client-supplied hash is never trusted.
 *
 * Throws ApiError(400) for size/type validation; ApiError(404) if the
 * referenced entity doesn't exist in the account; otherwise 500.
 */
export async function uploadAttachment(input: UploadInput): Promise<AttachmentRow> {
  if (!ALLOWED_ENTITY_TYPES.has(input.entityType)) {
    throw new ApiError(400, 'invalid_request', `entity_type ${input.entityType} is not allowed`);
  }
  if (input.bytes.byteLength === 0) {
    throw new ApiError(400, 'invalid_request', 'empty upload');
  }
  if (input.bytes.byteLength > MAX_BYTES) {
    throw new ApiError(
      400,
      'invalid_request',
      `attachment exceeds max size (${input.bytes.byteLength} > ${MAX_BYTES} bytes)`,
    );
  }
  if (!ALLOWED_MIME_TYPES.has(input.mimeType)) {
    throw new ApiError(400, 'invalid_request', `unsupported mime_type ${input.mimeType}`);
  }

  const admin = getAdminClient();

  // Content hash is over the ACTUAL bytes we'll persist. The client never
  // gets to provide this.
  const hash = createHash('sha256').update(input.bytes).digest('hex');
  const ext = mimeToExt(input.mimeType);

  // Server-constructed path. The first segment is the account_id (the
  // storage RLS policy keys off this). The hash forms the filename so two
  // uploads of identical bytes deduplicate.
  const storagePath =
    `${input.accountId}/${input.entityType}/${input.entityId}/${hash}.${ext}`;

  // Audit attribution note: when the intake path uploads, audit.actor
  // needs to be 'tenant:<token_id>' so the attachment INSERT trigger
  // records the right actor. Intake's submit_intake RPC sets the GUC
  // for the maintenance_request + interaction inserts, but the attachment
  // INSERT happens through supabase-js (separate connection), so its
  // audit row gets actor='system' instead. For Phase 8 we accept this
  // gap on the intake-attachment path; the parent maintenance_request's
  // audit event already carries tenant:<id>, and the attachment row's
  // entity_id links it to that request. Phase 9 will move the attachment
  // INSERT into the submit_intake RPC so both rows land under the same
  // audit actor.
  void input.auditActor;

  // Upload. upsert: true so identical bytes (same hash) reuse the same path
  // without erroring.
  const { error: upErr } = await admin.storage.from(BUCKET).upload(
    storagePath,
    input.bytes,
    {
      contentType: input.mimeType,
      upsert: true,
    },
  );
  if (upErr) {
    throw new ApiError(500, 'database_error', `storage upload failed: ${upErr.message}`);
  }

  // Insert the row. We don't need to pre-create with audit.actor here
  // because the audit trigger is per-table; setting audit.actor on the
  // session before the insert is the right hook. Use a fresh transaction
  // via supabase-js (limited control) -- the intake path's submit_intake
  // RPC already sets actor via the right txn-scoped GUC.
  // For NON-intake uploads (landlord-driven), auth.uid() is non-null and
  // Phase 4 actor-integrity makes audit.actor irrelevant on that path.
  // For intake uploads, the caller (admin/intake.ts) wraps the upload in
  // an RPC that sets audit.actor; the attachment INSERT inside that RPC
  // picks it up.

  const { data, error: insErr } = await admin
    .from('attachments')
    .insert({
      account_id: input.accountId,
      entity_type: input.entityType,
      entity_id: input.entityId,
      storage_path: storagePath,
      content_hash: hash,
      mime_type: input.mimeType,
      size_bytes: input.bytes.byteLength,
      uploaded_by: input.uploadedBy ?? null,
    })
    .select('*')
    .single();
  if (insErr || !data) {
    // Best-effort rollback of the storage object so we don't leak bytes.
    await admin.storage.from(BUCKET).remove([storagePath]).catch(() => {});
    if (insErr?.code === '23503') {
      throw new ApiError(404, 'not_found', 'referenced entity not found in this account');
    }
    throw new ApiError(500, 'database_error', insErr?.message ?? 'no row returned');
  }
  void safeFilename(input.filename, input.mimeType); // (filename surfaces on download)
  return data as AttachmentRow;
}

export interface DownloadResult {
  bytes: Uint8Array;
  mimeType: string;
  filename: string;
  contentHash: string;
}

/**
 * Pulls an attachment's bytes back from storage so the API can stream them
 * with the right Content-Disposition + Content-Type. Callers MUST have
 * verified the account membership already (this helper trusts that and
 * scopes by account_id + id).
 */
export async function downloadAttachment(
  accountId: string,
  attachmentId: string,
): Promise<DownloadResult> {
  const admin = getAdminClient();
  const { data: row, error: metaErr } = await admin
    .from('attachments')
    .select('id, account_id, entity_type, entity_id, storage_path, content_hash, mime_type')
    .eq('account_id', accountId)
    .eq('id', attachmentId)
    .is('deleted_at', null)
    .maybeSingle();
  if (metaErr) throw new ApiError(500, 'database_error', metaErr.message);
  if (!row) throw new ApiError(404, 'not_found', 'attachment not found');

  const { data: blob, error: dlErr } = await admin.storage
    .from(BUCKET)
    .download(row.storage_path as string);
  if (dlErr || !blob) {
    throw new ApiError(500, 'database_error', `storage download failed: ${dlErr?.message ?? 'no data'}`);
  }
  const buf = new Uint8Array(await blob.arrayBuffer());
  const mime = (row.mime_type as string | null) ?? 'application/octet-stream';
  return {
    bytes: buf,
    mimeType: mime,
    // The on-disk filename is the hash; on download we surface a
    // sanitized human-readable name based on the entity_type.
    filename: safeFilename(`${row.entity_type}-${row.id}`, mime),
    contentHash: row.content_hash as string,
  };
}

/**
 * Soft-deletes an attachment. Storage bytes stay (the audit trail's
 * tombstone-without-tomb pattern -- the row stays referenced, you can
 * always re-derive what existed). A cron in Phase 9 can purge orphaned
 * bytes if disk pressure ever matters.
 */
export async function softDeleteAttachment(
  accountId: string,
  attachmentId: string,
): Promise<{ id: string }> {
  const admin = getAdminClient();
  const { data, error } = await admin
    .from('attachments')
    .update({ deleted_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('account_id', accountId)
    .eq('id', attachmentId)
    .is('deleted_at', null)
    .select('id')
    .maybeSingle();
  if (error) throw new ApiError(500, 'database_error', error.message);
  if (!data) throw new ApiError(404, 'not_found', 'attachment not found');
  return { id: data.id as string };
}

/**
 * Server-side sha256 of the given bytes. Exposed so tests can compute the
 * expected hash without importing node:crypto themselves.
 */
export function sha256Bytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
