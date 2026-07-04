import { createHash } from 'node:crypto';
import { getLogger } from '../log';
import { getAdminClient } from './supabase-admin';
import { ApiError } from '../routes/_lib/error';
import { loadEnv } from '../env';

// ============================================================================
// Comms evidence archive (admin-side, service-role). Work item EV-B.
// ============================================================================
//
// The journal's inbound rows rest on the transport honestly restating what a
// provider delivered. This module keeps the artifact that makes that claim
// independently checkable: the VERBATIM signed webhook body, archived
// byte-for-byte in the private 'comm-evidence' bucket, anchored to the audit
// hash chain by the sha256 stored on its inbound_provenance row (see
// migration 20260703000004).
//
// Why admin-side (same reasoning as storage.ts):
//   (1) the hash is computed SERVER-SIDE from the bytes we actually store;
//   (2) the path is server-constructed and content-addressed
//       (<account>/<sha256>.bin) — callers never choose where bytes land,
//       and identical bodies dedupe onto one object;
//   (3) the bucket has NO authenticated storage policies at all — reads and
//       writes exist only through this module.
//
// Ordering contract with the DB (enforced by the route handler): the
// provenance ROW is recorded first (record_inbound_provenance is idempotent,
// first-hash-wins); bytes are uploaded only after the row exists and agrees
// on the hash. A retry after a crashed upload therefore heals the blob; a
// conflicting body for an already-archived provider_msg_id is refused at the
// row and never touches storage.

const BUCKET = 'comm-evidence';

// A provider webhook is JSON in the low KBs; inbound-email webhooks that
// inline MIME can run larger. Cap well above both — this is a raw-capture
// path, not a media store (media persistence is a tracked follow-up).
export const MAX_EVIDENCE_BYTES = 5 * 1024 * 1024; // 5 MiB

export interface EvidencePut {
  /** sha256 hex of the bytes that landed in storage. */
  sha256: string;
  /** account-scoped storage object name: `<account>/<sha256>.bin`. */
  storagePath: string;
  sizeBytes: number;
}

/** Server-side hash of the verbatim bytes; pure function, no I/O. */
export function evidenceSha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Content-addressed evidence path; pure function of (account, bytes-hash). */
export function evidenceStoragePath(accountId: string, sha256: string): string {
  return `${accountId}/${sha256}.bin`;
}

/**
 * Uploads the verbatim webhook bytes to the evidence bucket. upsert:true is
 * safe BY CONSTRUCTION: the path embeds the content hash, so any overwrite
 * writes identical bytes — and the route only calls this after the
 * provenance row has pinned that hash for the provider_msg_id.
 */
export async function storeEvidenceBytes(
  accountId: string,
  bytes: Uint8Array,
): Promise<EvidencePut> {
  if (bytes.byteLength === 0) {
    throw new ApiError(400, 'invalid_request', 'empty evidence body');
  }
  if (bytes.byteLength > MAX_EVIDENCE_BYTES) {
    throw new ApiError(
      400,
      'invalid_request',
      `evidence body exceeds max size (${bytes.byteLength} > ${MAX_EVIDENCE_BYTES} bytes)`,
    );
  }
  const sha256 = evidenceSha256(bytes);
  const storagePath = evidenceStoragePath(accountId, sha256);
  const admin = getAdminClient();
  const { error } = await admin.storage.from(BUCKET).upload(storagePath, bytes, {
    contentType: 'application/octet-stream',
    upsert: true,
  });
  if (error) {
    throw new ApiError(500, 'database_error', `evidence upload failed: ${error.message}`);
  }
  return { sha256, storagePath, sizeBytes: bytes.byteLength };
}

interface ProvenanceRow {
  id: string;
  account_id: string;
  storage_path: string;
  received_at: string;
}

export interface RetentionResult {
  scanned: number;
  purged: number;
  skipped_held: number;
  skipped_shared_blob: number;
}

/**
 * Retention janitor: removes evidence BLOBS past the configured horizon and
 * stamps purged_at on their (never-deleted) provenance rows — an AUDITED
 * destruction, via the table's _emit_event trigger, unlike the deliberately
 * silent inbound_raw prune. Accounts under an active legal hold are skipped
 * entirely (FRCP 37(e): routine destruction stops when litigation is
 * anticipated). Scheduled operationally (see docs/comms-evidence.md);
 * `pnpm --filter ./api retention:evidence` is the entry point.
 *
 * Idempotent and crash-safe: purged_at is stamped only AFTER the blob remove
 * succeeds, so a crash between the two re-selects the row next run (the
 * re-remove of a missing object is treated as success). A blob shared by
 * multiple provenance rows (identical bodies dedupe onto one object) is only
 * removed once every referencing row is past the horizon; earlier rows just
 * stamp purged_at.
 */
export async function runEvidenceRetention(now: Date = new Date()): Promise<RetentionResult> {
  const log = getLogger();
  const admin = getAdminClient();
  const days = loadEnv().COMM_EVIDENCE_RETENTION_DAYS;
  const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();

  const { data: holds, error: hErr } = await admin
    .from('account_legal_holds')
    .select('account_id')
    .eq('active', true);
  if (hErr) {
    throw new ApiError(500, 'database_error', `legal-hold read failed: ${hErr.message}`);
  }
  const held = new Set((holds ?? []).map((h) => (h as { account_id: string }).account_id));

  const { data: rows, error: rErr } = await admin
    .from('inbound_provenance')
    .select('id, account_id, storage_path, received_at')
    .is('purged_at', null)
    .lt('received_at', cutoff)
    .order('received_at', { ascending: true })
    .limit(500);
  if (rErr) {
    throw new ApiError(500, 'database_error', `provenance scan failed: ${rErr.message}`);
  }

  const result: RetentionResult = { scanned: 0, purged: 0, skipped_held: 0, skipped_shared_blob: 0 };
  for (const raw of (rows ?? []) as ProvenanceRow[]) {
    result.scanned += 1;
    if (held.has(raw.account_id)) {
      result.skipped_held += 1;
      continue;
    }

    // Identical bodies content-address onto one object; the object may only
    // be destroyed once NO unpurged row inside the horizon still needs it.
    const { data: sharers, error: sErr } = await admin
      .from('inbound_provenance')
      .select('id')
      .eq('storage_path', raw.storage_path)
      .is('purged_at', null)
      .gte('received_at', cutoff)
      .limit(1);
    if (sErr) {
      throw new ApiError(500, 'database_error', `shared-blob check failed: ${sErr.message}`);
    }
    if ((sharers ?? []).length > 0) {
      result.skipped_shared_blob += 1;
      continue;
    }

    const { error: rmErr } = await admin.storage.from(BUCKET).remove([raw.storage_path]);
    if (rmErr) {
      // Leave the row unstamped; the next run retries. Loud, not fatal —
      // one stuck object must not wedge the whole horizon.
      log.error(
        { event: 'evidence_purge_failed', path: raw.storage_path, err: rmErr.message },
        'evidence blob remove failed',
      );
      continue;
    }
    const { error: upErr } = await admin
      .from('inbound_provenance')
      .update({ purged_at: now.toISOString() })
      .eq('id', raw.id)
      .is('purged_at', null);
    if (upErr) {
      throw new ApiError(500, 'database_error', `purged_at stamp failed: ${upErr.message}`);
    }
    result.purged += 1;
  }

  log.info({ event: 'evidence_retention_done', ...result, cutoff, days }, 'evidence retention pass');
  return result;
}
