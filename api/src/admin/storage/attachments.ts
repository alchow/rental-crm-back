import { createHash } from 'node:crypto';
import { getAdminClient } from '../supabase-admin';
import { ApiError } from '../../routes/_lib/error';
import {
  ALLOWED_ENTITY_TYPES,
  BUCKET,
  processAndStoreBytes,
  safeFilename,
  type StoragePut,
} from './blobs';

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
  /**
   * true when identical bytes were already attached to this entity and the
   * existing row was returned instead of inserting a duplicate (the caller
   * surfaces this as HTTP 200 vs 201).
   */
  deduped: boolean;
}

// Look up a LIVE attachment whose bytes (content_hash) are already attached to
// this exact entity -- the basis for content-addressed upload idempotency. The
// order + limit(1) is deterministic even before the unique index exists (i.e.
// if historical duplicates remain), preferring the earliest row.
async function findLiveAttachmentByContent(
  admin: ReturnType<typeof getAdminClient>,
  input: UploadInput,
  contentHash: string,
): Promise<{ primary: AttachmentRow; derivative: AttachmentRow | null } | null> {
  const { data: primary } = await admin
    .from('attachments')
    .select('*')
    .eq('account_id', input.accountId)
    .eq('entity_type', input.entityType)
    .eq('entity_id', input.entityId)
    .eq('content_hash', contentHash)
    .is('deleted_at', null)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (!primary) return null;
  const { data: derivative } = await admin
    .from('attachments')
    .select('*')
    .eq('account_id', input.accountId)
    .eq('derived_from', (primary as AttachmentRow).id)
    .is('deleted_at', null)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  return {
    primary: primary as AttachmentRow,
    derivative: (derivative as AttachmentRow | null) ?? null,
  };
}

async function ensureDerivativeAttachment(
  admin: ReturnType<typeof getAdminClient>,
  input: UploadInput,
  primaryId: string,
  derivative: StoragePut,
): Promise<AttachmentRow> {
  const { data, error } = await admin
    .from('attachments')
    .insert({
      account_id: input.accountId,
      entity_type: input.entityType,
      entity_id: input.entityId,
      storage_path: derivative.storagePath,
      content_hash: derivative.hash,
      mime_type: derivative.mimeType,
      size_bytes: derivative.sizeBytes,
      uploaded_by: input.uploadedBy ?? null,
      derived_from: primaryId,
    })
    .select('*')
    .single();
  if (!error && data) return data as AttachmentRow;

  // A concurrent retry may have healed the same provenance edge first.
  if (error?.code === '23505') {
    const { data: won } = await admin
      .from('attachments')
      .select('*')
      .eq('account_id', input.accountId)
      .eq('derived_from', primaryId)
      .is('deleted_at', null)
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle();
    if (won) return won as AttachmentRow;
  }
  throw new ApiError(
    500,
    'database_error',
    error?.message ?? 'JPEG derivative provenance row was not created',
  );
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

  // Content idempotency: if this exact blob is already attached (live) to this
  // exact entity, return that row instead of inserting a duplicate. The bytes
  // were already (idempotently) stored above, so re-storing them was a no-op.
  const existing = await findLiveAttachmentByContent(admin, input, stored.primary.hash);
  if (existing) {
    let derivative = existing.derivative;
    if (!derivative && stored.derivative) {
      // Heal an original-only row left by an older deployment or by a prior
      // derivative-row DB failure. A retry must converge to complete
      // provenance, not upload an orphan JPEG and return early.
      derivative = await ensureDerivativeAttachment(
        admin,
        input,
        existing.primary.id,
        stored.derivative,
      );
    }
    return { primary: existing.primary, derivative, deduped: true };
  }

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
    // Race: a concurrent identical upload won the unique index. Its row owns the
    // (shared, content-addressed) bytes -- return it WITHOUT removing them.
    if (insErr?.code === '23505') {
      const won = await findLiveAttachmentByContent(admin, input, stored.primary.hash);
      if (won) {
        let derivative = won.derivative;
        if (!derivative && stored.derivative) {
          derivative = await ensureDerivativeAttachment(
            admin,
            input,
            won.primary.id,
            stored.derivative,
          );
        }
        return { primary: won.primary, derivative, deduped: true };
      }
    }
    // Content-addressed objects may already back another attachment or be in
    // use by a concurrent insert. Never delete them as request rollback; a
    // future reference-aware janitor can safely reclaim true orphans.
    if (insErr?.code === '23503') {
      throw new ApiError(404, 'not_found', 'referenced entity not found in this account');
    }
    // Post-completion attachment lock (Phase 27): the parent inspection/item is
    // frozen, so a new photo is rejected by the BEFORE INSERT trigger.
    if (insErr?.code === '23514' && /completed/i.test(insErr.message)) {
      throw new ApiError(
        409,
        'conflict',
        'parent inspection is completed; attachments are immutable',
      );
    }
    throw new ApiError(500, 'database_error', insErr?.message ?? 'no row returned');
  }

  let derivativeRow: AttachmentRow | null = null;
  if (stored.derivative) {
    // If this fails, answer 500 and let the idempotent retry path above repair
    // the already-committed primary row. Never report a successful HEIC upload
    // while silently omitting its usable rendition.
    derivativeRow = await ensureDerivativeAttachment(
      admin,
      input,
      (primaryRow as AttachmentRow).id,
      stored.derivative,
    );
  }

  void safeFilename(input.filename, input.mimeType);
  return { primary: primaryRow as AttachmentRow, derivative: derivativeRow, deduped: false };
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
    throw new ApiError(
      500,
      'database_error',
      `storage download failed: ${dlErr?.message ?? 'no data'}`,
    );
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
