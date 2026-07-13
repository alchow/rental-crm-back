import { getLogger } from '../log';
import { createHash, randomUUID } from 'node:crypto';
import { getAdminClient } from './supabase-admin';
import { ApiError } from '../routes/_lib/error';
import {
  recordHeicRenditionFailure,
  recordHeicRenditionSuccess,
} from './heic-capability';

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
//   (3) ordinary attachment paths are content-addressed. Document staging
//       paths also include a service-authored receipt id, so cleanup of one
//       abandoned upload cannot race another upload of identical bytes.
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
// Generated reports/exports aggregate many already-accepted photos and have a
// different DOS profile from untrusted uploads. Keep a separate bounded cap.
export const MAX_GENERATED_BYTES = 200 * 1024 * 1024; // 200 MiB
const STORAGE_RENDITION_EDGE = 2500;
const STORAGE_TRANSFORM_TIMEOUT_MS = 20_000;
const STORAGE_VERIFY_BASE_TIMEOUT_MS = 5_000;
const STORAGE_VERIFY_BYTES_PER_SECOND = 5 * 1024 * 1024;
const STORAGE_VERIFY_MAX_TIMEOUT_MS = 60_000;
const STORAGE_TRANSIENT_RETRY_DELAYS_MS = [0, 100, 300] as const;

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
  // Rent-change instruments: a signed renewal-lease PDF or a served-notice
  // scan. content_hash + received_at on the attachment make them evidence-grade
  // (the same chain-of-custody every other attachment gets). Both tables carry
  // id + account_id + deleted_at, so the generic entity-existence check in the
  // upload path scopes them correctly under RLS.
  'leases',
  'notices',
]);

function mimeToExt(mime: string): string {
  switch (mime) {
    case 'image/jpeg':
      return 'jpg';
    case 'image/png':
      return 'png';
    case 'image/webp':
      return 'webp';
    case 'image/heic':
      return 'heic';
    case 'image/heif':
      return 'heif';
    case 'application/pdf':
      return 'pdf';
    default:
      return 'bin';
  }
}

function isHeicLike(mime: string): boolean {
  return mime === 'image/heic' || mime === 'image/heif';
}

const HEIF_BRANDS = new Set([
  'heic',
  'heix',
  'hevc',
  'hevx',
  'heim',
  'heis',
  'hevm',
  'hevs',
  'mif1',
  'msf1',
]);

/** Cheap ISO-BMFF container check before asking the rendition dependency. */
export function hasHeicContainerSignature(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 12) return false;
  const ascii = (offset: number) =>
    String.fromCharCode(bytes[offset]!, bytes[offset + 1]!, bytes[offset + 2]!, bytes[offset + 3]!);
  if (ascii(4) !== 'ftyp') return false;
  const declaredSize =
    ((bytes[0]! << 24) | (bytes[1]! << 16) | (bytes[2]! << 8) | bytes[3]!) >>> 0;
  const boxEnd = Math.min(bytes.byteLength, declaredSize >= 12 ? declaredSize : bytes.byteLength);
  for (let offset = 8; offset + 3 < boxEnd; offset += 4) {
    if (HEIF_BRANDS.has(ascii(offset))) return true;
  }
  return false;
}

function safeFilename(original: string | undefined, mime: string): string {
  const base = (original ?? 'attachment').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 100);
  const ext = mimeToExt(mime);
  return base.toLowerCase().endsWith('.' + ext) ? base : `${base}.${ext}`;
}

export interface StoragePut {
  /** sha256 hex of the bytes that landed in storage. */
  hash: string;
  /** Server-constructed, account-scoped storage object name. */
  storagePath: string;
  mimeType: string;
  sizeBytes: number;
}

export interface AttestedStoragePut extends StoragePut {
  /** Service-authored receipt consumed by the caller-JWT document RPC. */
  receiptId: string;
}

export interface StoragePutResult {
  primary: StoragePut;
  /** Set iff the primary was HEIC and we successfully transcoded a JPEG. */
  derivative: StoragePut | null;
}

function isStorageObjectAlreadyPresent(error: {
  status?: string | number;
  statusCode?: string | number;
  message?: string;
} | null): boolean {
  const status = Number(error?.status);
  const statusCode = Number(error?.statusCode);
  if (status >= 500) return false;
  if (status === 409 || statusCode === 409) return true;
  const duplicateCode = String(error?.statusCode ?? '').toLowerCase() === 'duplicate';
  const duplicateMessage = /already exists|duplicate|resource exists/i.test(error?.message ?? '');
  return status === 400 && (duplicateCode || duplicateMessage);
}

/**
 * Store exactly the supplied bytes, with server-computed hash/path metadata.
 * Unlike processAndStoreBytes this does not create an automatic HEIC->JPEG
 * rendition. Document ingestion uses it because its only rendition is the
 * PDF that becomes the document version; recording an unused JPEG would leave
 * an orphaned provenance branch.
 */
export async function storeExactBytes(
  accountId: string,
  bytes: Uint8Array,
  mimeType: string,
): Promise<StoragePut> {
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
  return uploadBytes(getAdminClient(), accountId, bytes, mimeType);
}

/** Store a trusted server-generated artifact without the 20 MiB upload cap. */
export async function storeGeneratedArtifactBytes(
  accountId: string,
  bytes: Uint8Array,
  mimeType: string,
): Promise<StoragePut> {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_GENERATED_BYTES) {
    throw new ApiError(
      500,
      'database_error',
      `generated artifact is empty or exceeds ${MAX_GENERATED_BYTES} bytes`,
    );
  }
  if (!ALLOWED_MIME_TYPES.has(mimeType)) {
    throw new ApiError(500, 'database_error', `unsupported generated mime_type ${mimeType}`);
  }
  return uploadBytes(getAdminClient(), accountId, bytes, mimeType);
}

/**
 * Attest metadata before storing bytes, upload to the exact derived path, then
 * mark the receipt consumable. An incomplete receipt cannot create evidence.
 * If any step fails, the age-gated janitor clears the receipt/object pair.
 */
export async function stageDocumentUpload(
  accountId: string,
  uploadedBy: string,
  bytes: Uint8Array,
  mimeType: string,
  derivedFromReceiptId?: string,
): Promise<AttestedStoragePut> {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_BYTES) {
    throw new ApiError(400, 'invalid_request', 'document file is empty or exceeds 20 MiB');
  }
  if (!ALLOWED_MIME_TYPES.has(mimeType)) {
    throw new ApiError(400, 'invalid_request', `unsupported mime_type ${mimeType}`);
  }

  const admin = getAdminClient();
  // Document staging paths are receipt-unique, not shared by content hash.
  // This lets the orphan janitor delete one abandoned upload without racing a
  // concurrent upload of identical bytes that would otherwise share a path.
  const receiptId = randomUUID();
  const described = describeBytes(accountId, bytes, mimeType);
  const put: StoragePut = {
    ...described,
    storagePath: `${accountId}/document-uploads/${receiptId}/${described.hash}.${mimeToExt(mimeType)}`,
  };
  const { data: receipt, error: receiptError } = await admin
    .from('document_upload_receipts')
    .insert({
      id: receiptId,
      account_id: accountId,
      content_hash: put.hash,
      storage_path: put.storagePath,
      mime_type: put.mimeType,
      size_bytes: put.sizeBytes,
      uploaded_by: uploadedBy,
      derived_from_receipt_id: derivedFromReceiptId ?? null,
    })
    .select('id')
    .single();
  if (receiptError || !receipt) {
    throw new ApiError(
      500,
      'database_error',
      receiptError?.message ?? 'document upload receipt was not created',
    );
  }

  await uploadDescribedBytes(admin, put, bytes, { allowExisting: false });
  const { data: completed, error: completeError } = await admin
    .from('document_upload_receipts')
    .update({ stored_at: new Date().toISOString() })
    .eq('id', receipt.id as string)
    .is('stored_at', null)
    .select('id')
    .single();
  if (completeError || !completed) {
    throw new ApiError(
      500,
      'database_error',
      completeError?.message ?? 'document upload receipt was not completed',
    );
  }
  return { ...put, receiptId: receipt.id as string };
}

/**
 * Ask Supabase Storage's imgproxy tier to decode and bound an already-stored
 * image. Hosted Storage supports HEIC sources up to 50 MP, so normal iPhone
 * photos never expand into RGBA inside the 512 MB API process. The returned
 * JPEG is a rendition only; the exact original remains the evidence identity.
 */
export async function renderStoredImageToJpeg(
  storagePath: string,
  sourceBytes: Uint8Array,
): Promise<Uint8Array> {
  if (!hasHeicContainerSignature(sourceBytes)) {
    throw new ApiError(
      422,
      'invalid_request',
      'image bytes do not contain a recognized HEIC/HEIF container',
      { fieldErrors: { file: ['image bytes do not match the declared HEIC/HEIF type'] } },
    );
  }
  try {
    const { data, error } = await getAdminClient()
      .storage.from(BUCKET)
      .download(
        storagePath,
        {
          transform: {
            width: STORAGE_RENDITION_EDGE,
            height: STORAGE_RENDITION_EDGE,
            resize: 'contain',
            quality: 92,
          },
        },
        { signal: AbortSignal.timeout(STORAGE_TRANSFORM_TIMEOUT_MS) },
      );
    if (error || !data) {
      const statusCode = Number((error as { statusCode?: string | number } | null)?.statusCode);
      const message = error?.message ?? 'no transformed bytes returned';
      const invalidSource =
        [400, 415, 422].includes(statusCode) &&
        /decode|format|image|invalid|unsupported/i.test(message) &&
        !/billing|enabled|plan|transform/i.test(message);
      throw new ApiError(
        invalidSource ? 422 : 503,
        invalidSource ? 'invalid_request' : 'service_unavailable',
        invalidSource
          ? `image could not be decoded: ${message}`
          : `image rendition service unavailable: ${message}`,
        invalidSource
          ? { fieldErrors: { file: ['image bytes are invalid or use an unsupported codec'] } }
          : undefined,
      );
    }
    const bytes = new Uint8Array(await data.arrayBuffer());
    if (
      data.type !== 'image/jpeg' ||
      bytes.byteLength < 3 ||
      bytes[0] !== 0xff ||
      bytes[1] !== 0xd8 ||
      bytes[2] !== 0xff
    ) {
      throw new ApiError(
        503,
        'service_unavailable',
        `image rendition service returned ${data.type || 'an unknown format'} instead of JPEG`,
      );
    }
    recordHeicRenditionSuccess();
    return bytes;
  } catch (error) {
    const mapped =
      error instanceof ApiError
        ? error
        : new ApiError(
            503,
            'service_unavailable',
            `image rendition service unavailable: ${error instanceof Error ? error.message : String(error)}`,
          );
    if (mapped.status === 503) recordHeicRenditionFailure(mapped);
    throw mapped;
  }
}

async function renderStoredImageToJpegWithRetry(
  storagePath: string,
  sourceBytes: Uint8Array,
): Promise<Uint8Array> {
  let lastError: unknown;
  for (const delayMs of STORAGE_TRANSIENT_RETRY_DELAYS_MS) {
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    try {
      return await renderStoredImageToJpeg(storagePath, sourceBytes);
    } catch (renderError) {
      lastError = renderError;
      if (!(renderError instanceof ApiError) || renderError.status !== 503) throw renderError;
    }
  }
  throw lastError;
}

/** End-to-end startup probe for the same hosted Storage path uploads use. */
export async function probeStoredHeicRendition(bytes: Uint8Array): Promise<void> {
  const admin = getAdminClient();
  const hash = createHash('sha256').update(bytes).digest('hex');
  // One immutable system object avoids per-deploy origin-transform billing and
  // cannot collide with an account UUID path. It is deliberately retained.
  const storagePath = `_system/heic-probe/${hash}.heic`;
  try {
    await uploadDescribedBytes(
      admin,
      { hash, storagePath, mimeType: 'image/heic', sizeBytes: bytes.byteLength },
      bytes,
    );
  } catch (error) {
    recordHeicRenditionFailure(error);
    throw error;
  }

  // Parallel test workers and rolling deploys can observe a brief Storage edge
  // race while the first writer's immutable object becomes transformable.
  // Retry only dependency failures; an invalid fixture must fail immediately.
  await renderStoredImageToJpegWithRetry(storagePath, bytes);
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
  const admin = getAdminClient();
  const primary = await storeExactBytes(accountId, bytes, mimeType);

  let derivative: StoragePut | null = null;
  if (isHeicLike(mimeType)) {
    try {
      const jpegBytes = await renderStoredImageToJpegWithRetry(primary.storagePath, bytes);
      derivative = await uploadBytes(admin, accountId, jpegBytes, 'image/jpeg');
    } catch (error) {
      // A dependency outage is retryable and must not commit an original-only
      // attachment row. Idempotency middleware releases 5xx claims; retrying
      // reuses the content-addressed original and completes provenance.
      if (error instanceof ApiError && error.status >= 500) throw error;

      // The exact original is already content-addressed in private storage.
      // Keep corrupt/mislabeled input as evidence, but do not claim it has a
      // usable rendition.
      const sha12 = primary.hash.slice(0, 12);
      getLogger().warn(
        `[WARN][heic] HEIC rendition FAILED for upload (sha=${sha12}…). ` +
          `Original is stored; derivative skipped; PDF will placeholder. ` +
          `rendition error: ${error instanceof Error ? error.message : String(error)}`,
      );
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
  const put = describeBytes(accountId, bytes, mimeType);
  // Ordinary paths are content-addressed, so an already-verified object is a
  // safe immutable dedupe hit rather than an upload failure.
  await uploadDescribedBytes(admin, put, bytes);
  return put;
}

function describeBytes(accountId: string, bytes: Uint8Array, mimeType: string): StoragePut {
  const hash = createHash('sha256').update(bytes).digest('hex');
  const ext = mimeToExt(mimeType);
  const storagePath = `${accountId}/${hash}.${ext}`;
  return { hash, storagePath, mimeType, sizeBytes: bytes.byteLength };
}

async function uploadDescribedBytes(
  admin: ReturnType<typeof getAdminClient>,
  put: StoragePut,
  bytes: Uint8Array,
  options: { allowExisting?: boolean } = {},
): Promise<void> {
  const allowExisting = options.allowExisting ?? true;
  const { error: upErr } = await admin.storage
    .from(BUCKET)
    // Never rewrite an object in place: document staging paths require a fresh
    // receipt, while content-addressed callers verify an existing duplicate.
    .upload(put.storagePath, bytes, { contentType: put.mimeType, upsert: false });
  if (!upErr) return;
  if (allowExisting && isStorageObjectAlreadyPresent(upErr)) {
    await verifyStoredObject(admin, put);
    return;
  }
  if (upErr) {
    throw new ApiError(500, 'database_error', `storage upload failed: ${upErr.message}`);
  }
}

async function withinDeadline<T>(
  operation: Promise<T>,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function verifyStoredObject(
  admin: ReturnType<typeof getAdminClient>,
  put: StoragePut,
): Promise<void> {
  const timeoutMs = Math.min(
    STORAGE_VERIFY_MAX_TIMEOUT_MS,
    STORAGE_VERIFY_BASE_TIMEOUT_MS +
      Math.ceil(put.sizeBytes / STORAGE_VERIFY_BYTES_PER_SECOND) * 1_000,
  );
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  for (const delayMs of STORAGE_TRANSIENT_RETRY_DELAYS_MS) {
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    try {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) throw new Error('stored object verification timed out');
      const { data, error } = await withinDeadline(
        admin.storage
          .from(BUCKET)
          .createSignedUrl(put.storagePath, Math.max(60, Math.ceil(remainingMs / 1_000) + 10)),
        remainingMs,
        'stored object signing timed out',
      );
      if (error || !data?.signedUrl) {
        throw new Error(error?.message ?? 'stored object returned no signed URL');
      }
      const downloadRemainingMs = deadline - Date.now();
      if (downloadRemainingMs <= 0) throw new Error('stored object verification timed out');
      const response = await fetch(data.signedUrl, {
        signal: AbortSignal.timeout(downloadRemainingMs),
      });
      if (!response.ok || !response.body) {
        throw new Error(`stored object download returned HTTP ${response.status}`);
      }
      const hash = createHash('sha256');
      const reader = response.body.getReader();
      let sizeBytes = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        sizeBytes += value.byteLength;
        if (sizeBytes > put.sizeBytes) {
          await reader.cancel().catch(() => {});
          throw new ApiError(
            500,
            'database_error',
            `content-addressed storage object exceeds its attested size: ${put.storagePath}`,
          );
        }
        hash.update(value);
      }
      const actualHash = hash.digest('hex');
      if (sizeBytes !== put.sizeBytes || actualHash !== put.hash) {
        throw new ApiError(
          500,
          'database_error',
          `content-addressed storage object failed integrity verification: ${put.storagePath}`,
        );
      }
      return;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      lastError = error;
    }
  }
  throw new ApiError(
    503,
    'service_unavailable',
    `stored object could not be verified: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

const DOCUMENT_RECEIPT_GRACE_HOURS = 48;
const DOCUMENT_RECEIPT_PRUNE_BATCH = 100;
const DOCUMENT_RECEIPT_PRUNE_MAX = 10_000;
const DOCUMENT_REFERENCE_QUERY_CHUNK = 20;

interface DocumentReceiptForPrune {
  id: string;
  account_id: string;
  storage_path: string;
  derived_from_receipt_id: string | null;
  created_at: string;
}

/**
 * Reclaim only receipt-unique storage objects backed by an expired service
 * receipt and by no attachment row (live or soft-deleted). RPCs accept
 * receipts for 24 hours; the 48-hour threshold adds a retry buffer. Because a
 * path contains its receipt id, an identical concurrent upload cannot share
 * the object being removed.
 */
export async function pruneDocumentUploadOrphans(): Promise<number> {
  const admin = getAdminClient();
  const cutoff = new Date(Date.now() - DOCUMENT_RECEIPT_GRACE_HOURS * 60 * 60 * 1000).toISOString();
  let pruned = 0;
  let scanned = 0;
  let cursor: Pick<DocumentReceiptForPrune, 'created_at' | 'id'> | null = null;
  while (scanned < DOCUMENT_RECEIPT_PRUNE_MAX) {
    let query = admin
      .from('document_upload_receipts')
      .select('id, account_id, storage_path, derived_from_receipt_id, created_at')
      .lt('created_at', cutoff)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .limit(Math.min(DOCUMENT_RECEIPT_PRUNE_BATCH, DOCUMENT_RECEIPT_PRUNE_MAX - scanned));
    if (cursor) {
      query = query.or(
        `created_at.gt.${cursor.created_at},and(created_at.eq.${cursor.created_at},id.gt.${cursor.id})`,
      );
    }
    const { data, error } = await query;
    if (error) {
      throw new ApiError(500, 'database_error', `document receipt scan failed: ${error.message}`);
    }
    const receipts = (data ?? []) as DocumentReceiptForPrune[];
    if (receipts.length === 0) break;
    scanned += receipts.length;
    const last = receipts.at(-1)!;
    cursor = { created_at: last.created_at, id: last.id };

    for (const accountId of new Set(receipts.map((row) => row.account_id))) {
      const accountReceipts = receipts.filter((row) => row.account_id === accountId);
      const paths = [...new Set(accountReceipts.map((row) => row.storage_path))];
      const referenced = new Set<string>();
      for (let offset = 0; offset < paths.length; offset += DOCUMENT_REFERENCE_QUERY_CHUNK) {
        const pathChunk = paths.slice(offset, offset + DOCUMENT_REFERENCE_QUERY_CHUNK);
        const { data: references, error: referenceError } = await admin
          .from('attachments')
          .select('storage_path')
          .eq('account_id', accountId)
          .in('storage_path', pathChunk);
        if (referenceError) {
          throw new ApiError(
            500,
            'database_error',
            `document orphan reference check failed: ${referenceError.message}`,
          );
        }
        for (const row of references ?? []) referenced.add(row.storage_path as string);
      }
      const unreferenced = paths.filter((path) => !referenced.has(path));
      const clearablePaths = new Set(referenced);
      if (unreferenced.length > 0) {
        const { error: removeError } = await admin.storage.from(BUCKET).remove(unreferenced);
        if (removeError) {
          getLogger().warn(
            {
              event: 'document_orphan_storage_remove_failed',
              account_id: accountId,
              err: removeError.message,
            },
            'document orphan storage removal failed; receipts retained for retry',
          );
        } else {
          for (const path of unreferenced) clearablePaths.add(path);
          pruned += unreferenced.length;
        }
      }
      const clearable = accountReceipts
        .filter((row) => clearablePaths.has(row.storage_path))
        // Delete child receipts before their parents. The FK is deliberately
        // RESTRICT: cleanup must never cascade into a newer or referenced child.
        .sort((a, b) => {
          if (a.derived_from_receipt_id === b.id) return -1;
          if (b.derived_from_receipt_id === a.id) return 1;
          return a.id.localeCompare(b.id);
        });
      for (const receipt of clearable) {
        const { error: deleteError } = await admin
          .from('document_upload_receipts')
          .delete()
          .eq('id', receipt.id);
        if (deleteError) {
          getLogger().warn(
            {
              event: 'document_receipt_cleanup_failed',
              account_id: accountId,
              receipt_id: receipt.id,
              err: deleteError.message,
            },
            'document receipt cleanup failed; retained for retry',
          );
        }
      }
    }
    if (receipts.length < DOCUMENT_RECEIPT_PRUNE_BATCH) break;
  }
  return pruned;
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
