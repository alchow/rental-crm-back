import { createHash } from 'node:crypto';
import { getLogger } from '../log';
import { getAdminClient } from './supabase-admin';
import { ApiError } from '../routes/_lib/error';
import { loadEnv } from '../env';

// Archives provider-signed webhook bytes so inbound journal claims are
// independently verifiable. Server-computed hashes and paths anchor private,
// content-addressed blobs to inbound_provenance. DATA FLOW: Record the
// first-hash-wins provenance row, then upload matching bytes; retries heal a
// missing blob, while a conflicting provider message never reaches storage.

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
 * Audited evidence retention. Skip legal-hold accounts; remove a shared blob
 * only after every reference ages out; stamp purged_at only after deletion.
 * This ordering is idempotent and crash-safe because the next run retries any
 * unstamped row. See docs/comms-evidence.md.
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
