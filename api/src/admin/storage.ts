import { getLogger } from '../log';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { getAdminClient } from './supabase-admin';
import { heicSupported } from './heic-probe';
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
//   (3) the storage path is content-addressed: <account>/<hash>.<ext> .
//       The hash IS the path filename, so even if a second upload of the
//       SAME bytes happens, the path collides and we dedupe (upsert).
//       Putting the entity_id in the path was the Phase 8 scheme; we
//       dropped it in Phase 9 so that the intake flow can compute the path
//       BEFORE the maintenance_request_id exists -- the path is now a
//       pure function of (accountId, hash, ext).
//
// HEIC handling (Phase 9):
//
// iPhones shoot HEIC by default. A HEIC stored as-is renders as a black
// placeholder in pdfkit -- so the inspection report PDF (the single most
// probative artifact in a habitability dispute) silently loses the
// photo. We can't strip HEIC because that destroys evidence. So at upload
// we keep BOTH:
//
//   * the original HEIC bytes (hashed, stored, attachments row #1)
//   * a derived JPEG (hashed, stored, attachments row #2 with
//     derived_from = #1)
//
// The derivation is server-side and recorded in the DB, so chain of
// custody for the JPEG is explicit: "this JPEG was computed from that
// HEIC at upload by the server, no human in the loop".
//
// Reads also route through the API (a tiny proxy below) so we can force
// Content-Disposition: attachment + a safe Content-Type. Serving an
// uploaded HTML / SVG inline from the app origin would be stored-XSS;
// proxying with explicit headers removes that path.

const BUCKET = 'attachments';
export const MAX_BYTES = 20 * 1024 * 1024; // 20 MiB

export const ALLOWED_MIME_TYPES = new Set<string>([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
  'application/pdf',
]);

export const ALLOWED_ENTITY_TYPES = new Set<string>([
  'maintenance_requests',
  'inspections',
  'inspection_items',
  'inspection_report',
  'interactions',
  'document_versions',
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

function isHeicLike(mime: string): boolean {
  return mime === 'image/heic' || mime === 'image/heif';
}

function safeFilename(original: string | undefined, mime: string): string {
  const base = (original ?? 'attachment').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 100);
  const ext = mimeToExt(mime);
  return base.toLowerCase().endsWith('.' + ext) ? base : `${base}.${ext}`;
}

export interface StoragePut {
  /** sha256 hex of the bytes that landed in storage. */
  hash: string;
  /** account-scoped storage object name: `<account>/<hash>.<ext>`. */
  storagePath: string;
  mimeType: string;
  sizeBytes: number;
}

export interface StoragePutResult {
  primary: StoragePut;
  /** Set iff the primary was HEIC and we successfully transcoded a JPEG. */
  derivative: StoragePut | null;
}

/**
 * Validates inputs, hashes server-side, uploads the bytes to private
 * storage, and -- if the input is HEIC -- transcodes a JPEG derivative and
 * uploads that too. Does NOT touch the attachments DB table; callers are
 * responsible for the row INSERT (either directly or via a SECURITY
 * DEFINER RPC like submit_intake_with_attachment).
 *
 * Two-step separation makes the intake path atomic: the caller computes
 * paths via this helper, calls the RPC (one txn for request + interaction
 * + attachment + derivative rows), and only THEN uploads the bytes. An
 * RPC failure leaves zero rows AND zero storage objects in a final state
 * that needs cleanup; a bytes-upload-success-rpc-failure path leaves
 * orphan objects, which a future cron can prune by storage_path ∉
 * attachments.
 */
export async function processAndStoreBytes(
  accountId: string,
  bytes: Uint8Array,
  mimeType: string,
): Promise<StoragePutResult> {
  if (bytes.byteLength === 0) {
    throw new ApiError(400, 'invalid_request', 'empty upload');
  }
  if (bytes.byteLength > MAX_BYTES) {
    throw new ApiError(
      400,
      'invalid_request',
      `attachment exceeds max size (${bytes.byteLength} > ${MAX_BYTES} bytes)`,
    );
  }
  if (!ALLOWED_MIME_TYPES.has(mimeType)) {
    throw new ApiError(400, 'invalid_request', `unsupported mime_type ${mimeType}`);
  }

  const admin = getAdminClient();
  const primary = await uploadBytes(admin, accountId, bytes, mimeType);

  let derivative: StoragePut | null = null;
  if (isHeicLike(mimeType)) {
    // The boot-time probe in heic-probe.ts already loud-warned ops if
    // libheif was missing. Per-occurrence warnings here surface in the
    // request log so each affected upload is visible too -- silent
    // degradation of evidence rendering is exactly the failure mode
    // we're defending against. If the probe said unsupported, we skip
    // the transcode entirely (no point spending CPU on a guaranteed
    // failure) but log the upload so ops can quantify the gap.
    if (heicSupported() === false) {
      getLogger().warn(
        `[WARN][heic] HEIC upload landed (sha=${createHash('sha256').update(bytes).digest('hex').slice(0, 12)}…) ` +
        `but libheif is unavailable on this host; NO JPEG derivative was created. ` +
        `The inspection-report PDF will placeholder this photo.`,
      );
    } else {
      try {
        const jpegBuf = await sharp(Buffer.from(bytes))
          .rotate() // apply EXIF orientation so portrait/landscape renders right
          .withMetadata() // KEEP EXIF on the derivative -- date/GPS preserved
          .jpeg({ quality: 85 })
          .toBuffer();
        derivative = await uploadBytes(
          admin,
          accountId,
          new Uint8Array(jpegBuf.buffer, jpegBuf.byteOffset, jpegBuf.byteLength),
          'image/jpeg',
        );
      } catch (e) {
        // The probe said supported but THIS specific decode still failed
        // (e.g. corrupt HEIC, unusual codec variant). Loud-warn -- this
        // is the case the user told us to track.
        const sha12 = createHash('sha256').update(bytes).digest('hex').slice(0, 12);
        getLogger().warn(
          `[WARN][heic] HEIC decode FAILED for upload (sha=${sha12}…). ` +
          `Original is stored; derivative skipped; PDF will placeholder. ` +
          `sharp error: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
  }

  return { primary, derivative };
}

async function uploadBytes(
  admin: ReturnType<typeof getAdminClient>,
  accountId: string,
  bytes: Uint8Array,
  mimeType: string,
): Promise<StoragePut> {
  const hash = createHash('sha256').update(bytes).digest('hex');
  const ext = mimeToExt(mimeType);
  const storagePath = `${accountId}/${hash}.${ext}`;

  const { error: upErr } = await admin.storage.from(BUCKET).upload(
    storagePath,
    bytes,
    { contentType: mimeType, upsert: true },
  );
  if (upErr) {
    throw new ApiError(500, 'database_error', `storage upload failed: ${upErr.message}`);
  }
  return { hash, storagePath, mimeType, sizeBytes: bytes.byteLength };
}

export interface UploadInput {
  accountId: string;
  entityType: string;
  entityId: string;
  bytes: Uint8Array;
  mimeType: string;
  filename?: string;
  uploadedBy?: string | null;
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
  derived_from: string | null;
  received_at: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface UploadResult {
  primary: AttachmentRow;
  /** Set iff the primary was HEIC and a JPEG derivative was created. */
  derivative: AttachmentRow | null;
}

/**
 * Landlord-facing upload: stores bytes (+ HEIC derivative when applicable)
 * and inserts the corresponding attachment row(s). For HEIC uploads two
 * rows land: the original and a JPEG with derived_from pointing at the
 * original.
 *
 * Throws ApiError(400) for size/type validation; ApiError(404) if the
 * referenced entity doesn't exist in the account; otherwise 500.
 */
export async function uploadAttachment(input: UploadInput): Promise<UploadResult> {
  if (!ALLOWED_ENTITY_TYPES.has(input.entityType)) {
    throw new ApiError(400, 'invalid_request', `entity_type ${input.entityType} is not allowed`);
  }

  const stored = await processAndStoreBytes(input.accountId, input.bytes, input.mimeType);

  const admin = getAdminClient();
  const { data: primaryRow, error: insErr } = await admin
    .from('attachments')
    .insert({
      account_id: input.accountId,
      entity_type: input.entityType,
      entity_id: input.entityId,
      storage_path: stored.primary.storagePath,
      content_hash: stored.primary.hash,
      mime_type: stored.primary.mimeType,
      size_bytes: stored.primary.sizeBytes,
      uploaded_by: input.uploadedBy ?? null,
    })
    .select('*')
    .single();
  if (insErr || !primaryRow) {
    await admin.storage.from(BUCKET).remove([stored.primary.storagePath]).catch(() => {});
    if (stored.derivative) {
      await admin.storage.from(BUCKET).remove([stored.derivative.storagePath]).catch(() => {});
    }
    if (insErr?.code === '23503') {
      throw new ApiError(404, 'not_found', 'referenced entity not found in this account');
    }
    // Post-completion attachment lock (Phase 27): the parent inspection/item is
    // frozen, so a new photo is rejected by the BEFORE INSERT trigger.
    if (insErr?.code === '23514' && /completed/i.test(insErr.message)) {
      throw new ApiError(409, 'conflict', 'parent inspection is completed; attachments are immutable');
    }
    throw new ApiError(500, 'database_error', insErr?.message ?? 'no row returned');
  }

  let derivativeRow: AttachmentRow | null = null;
  if (stored.derivative) {
    const { data, error } = await admin
      .from('attachments')
      .insert({
        account_id: input.accountId,
        entity_type: input.entityType,
        entity_id: input.entityId,
        storage_path: stored.derivative.storagePath,
        content_hash: stored.derivative.hash,
        mime_type: stored.derivative.mimeType,
        size_bytes: stored.derivative.sizeBytes,
        uploaded_by: input.uploadedBy ?? null,
        derived_from: (primaryRow as AttachmentRow).id,
      })
      .select('*')
      .single();
    if (error || !data) {
      // Best effort: the original lives on. The PDF renderer will
      // placeholder this slot. Don't fail the whole upload over this.
      void error;
    } else {
      derivativeRow = data as AttachmentRow;
    }
  }

  void safeFilename(input.filename, input.mimeType);
  return { primary: primaryRow as AttachmentRow, derivative: derivativeRow };
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
    filename: safeFilename(`${row.entity_type}-${row.id}`, mime),
    contentHash: row.content_hash as string,
  };
}

/**
 * Soft-deletes an attachment. INVARIANT: storage bytes stay; only the row
 * flips `deleted_at`. This invariant is REQUIRED for safety under the
 * Phase 9 content-addressed path scheme (`<account>/<hash>.<ext>`): two
 * logically-distinct attachment rows can reference the same storage
 * object if their bytes happen to match. Removing bytes on soft-delete
 * would orphan another attachment's storage. If a future garbage-collection
 * cron prunes storage objects, it MUST reference-count by
 * (account_id, content_hash) over live attachments rows -- not just by
 * storage_path -- and never delete an object that is still referenced
 * (even by a soft-deleted row, if cross-generation evidence-preservation
 * matters).
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

/**
 * Best-effort removal of a freshly-stored object whose owning DB row(s) failed
 * to commit (e.g. an atomic create RPC threw AFTER the bytes were uploaded).
 * Reference-counted by the content-addressed path: under the Phase 9 scheme
 * (`<account>/<hash>.<ext>`) two attachment rows can share one storage object,
 * so we only delete the object when NO live attachments row references it --
 * otherwise we would orphan another attachment's bytes. Safe to call when the
 * caller's own row never landed (the common failure case).
 */
export async function removeOrphanStoredObject(
  accountId: string,
  storagePath: string,
): Promise<void> {
  const admin = getAdminClient();
  const { data } = await admin
    .from('attachments')
    .select('id')
    .eq('account_id', accountId)
    .eq('storage_path', storagePath)
    .is('deleted_at', null)
    .limit(1);
  if (data && data.length > 0) return;
  await admin.storage.from(BUCKET).remove([storagePath]).catch(() => {});
}
