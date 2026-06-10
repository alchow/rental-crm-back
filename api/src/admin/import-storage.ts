import { getAdminClient } from './supabase-admin';
import { ApiError } from '../routes/_lib/error';
import type { ImportExt } from './import-parser';

// Source-file archival for the onboarding import. The raw upload is kept as an
// audit artifact in the private 'source-imports' bucket. The bucket grants NO
// authenticated policies, so this write — like all import-source access — must
// go through the service-role client; account members never download it
// directly. Path: <account_id>/<session_id>/source.<ext>.

const BUCKET = 'source-imports';

export async function uploadImportSource(
  accountId: string,
  sessionId: string,
  bytes: Uint8Array,
  ext: ImportExt,
  mime: string,
): Promise<string> {
  const path = `${accountId}/${sessionId}/source.${ext}`;
  const { error } = await getAdminClient().storage.from(BUCKET).upload(path, bytes, {
    contentType: mime,
    upsert: true,
  });
  if (error) {
    throw new ApiError(500, 'database_error', `source-file upload failed: ${error.message}`);
  }
  return path;
}
