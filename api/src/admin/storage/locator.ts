import { createHash } from 'node:crypto';
import { getAdminClient } from '../supabase-admin';
import { ApiError } from '../../routes/_lib/error';

interface StoredAttachment {
  account_id: string;
  storage_bucket: string | null;
  storage_path: string;
  content_hash: string;
}

/** Metadata selects the private bucket; the hash verifies inventory and bytes agree. */
export async function readAttachmentBytes(row: StoredAttachment): Promise<Uint8Array> {
  if (
    !['attachments', 'comm-attachments'].includes(row.storage_bucket ?? '') ||
    !row.storage_path.startsWith(`${row.account_id}/`)
  ) {
    throw new ApiError(409, 'conflict', 'attachment storage location requires review');
  }
  const { data, error } = await getAdminClient()
    .storage.from(row.storage_bucket!)
    .download(row.storage_path);
  if (error || !data) throw new ApiError(500, 'database_error', 'attachment bytes are unavailable');
  const bytes = new Uint8Array(await data.arrayBuffer());
  if (createHash('sha256').update(bytes).digest('hex') !== row.content_hash) {
    throw new ApiError(409, 'conflict', 'attachment content hash does not match');
  }
  return bytes;
}
