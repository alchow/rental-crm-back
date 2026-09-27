import type { z } from '@hono/zod-openapi';
import type { getSb } from '../../supabase/request-client';
import { ApiError } from '../_lib/error';
import type { DocumentRow, DocumentType, DocumentVersion, VersionSource } from './shared';

async function latestVersions(
  sb: ReturnType<typeof getSb>,
  accountId: string,
  documentIds: string[],
): Promise<Map<string, z.infer<typeof DocumentVersion>>> {
  const out = new Map<string, z.infer<typeof DocumentVersion>>();
  if (documentIds.length === 0) return out;
  const { data, error } = await sb
    .from('document_versions')
    .select('*')
    .eq('account_id', accountId)
    .in('document_id', documentIds)
    .is('deleted_at', null)
    .order('version_no', { ascending: false });
  if (error) throw new ApiError(500, 'database_error', error.message);
  const raw = (data ?? []) as Array<
    Omit<
      z.infer<typeof DocumentVersion>,
      'original_attachment_id' | 'original_content_hash' | 'original_mime_type'
    >
  >;
  const attachmentIds = raw
    .map((row) => row.attachment_id)
    .filter((id): id is string => id !== null);
  const attachmentById = new Map<
    string,
    { id: string; derived_from: string | null; content_hash: string; mime_type: string | null }
  >();
  if (attachmentIds.length > 0) {
    const current = await sb
      .from('attachments')
      .select('id, derived_from, content_hash, mime_type')
      .eq('account_id', accountId)
      .in('id', attachmentIds)
      .is('deleted_at', null);
    if (current.error) throw new ApiError(500, 'database_error', current.error.message);
    for (const attachment of current.data ?? []) attachmentById.set(attachment.id, attachment);
    const parentIds = (current.data ?? [])
      .map((attachment) => attachment.derived_from)
      .filter((id): id is string => id !== null);
    if (parentIds.length > 0) {
      const parents = await sb
        .from('attachments')
        .select('id, derived_from, content_hash, mime_type')
        .eq('account_id', accountId)
        .in('id', parentIds)
        .is('deleted_at', null);
      if (parents.error) throw new ApiError(500, 'database_error', parents.error.message);
      for (const attachment of parents.data ?? []) attachmentById.set(attachment.id, attachment);
    }
  }
  const versions: z.infer<typeof DocumentVersion>[] = raw.map((row) => {
    const rendition = row.attachment_id ? attachmentById.get(row.attachment_id) : undefined;
    const original = rendition?.derived_from
      ? attachmentById.get(rendition.derived_from)
      : rendition;
    return {
      ...row,
      original_attachment_id: original?.id ?? null,
      original_content_hash: original?.content_hash ?? null,
      original_mime_type: original?.mime_type ?? null,
    };
  });
  for (const row of versions) {
    if (!out.has(row.document_id)) out.set(row.document_id, row);
  }
  return out;
}

export async function withLatestVersions(
  sb: ReturnType<typeof getSb>,
  accountId: string,
  docs: Array<Omit<z.infer<typeof DocumentRow>, 'latest_version'>>,
): Promise<z.infer<typeof DocumentRow>[]> {
  const versions = await latestVersions(
    sb,
    accountId,
    docs.map((d) => d.id),
  );
  return docs.map((d) => ({ ...d, latest_version: versions.get(d.id) ?? null }));
}

// INVARIANT: The caller-JWT RPC atomically writes document/version rows and audit identity.
export async function createTenancyDocument(
  sb: ReturnType<typeof getSb>,
  params: {
    p_account_id: string;
    p_tenancy_id: string;
    p_document_type: z.infer<typeof DocumentType>;
    p_title: string;
    p_requires_ack: boolean;
    p_source: z.infer<typeof VersionSource>;
    p_content_hash: string;
    p_mime_type: string;
    p_size_bytes: number;
    p_attachment_path?: string | null;
    p_static_template_id?: string | null;
    p_static_asset_path?: string | null;
  },
): Promise<{ document: z.infer<typeof DocumentRow>; deduped: boolean }> {
  const { data, error } = await sb.rpc('create_tenancy_document', {
    ...params,
    p_attachment_path: params.p_attachment_path ?? undefined,
    p_static_template_id: params.p_static_template_id ?? undefined,
    p_static_asset_path: params.p_static_asset_path ?? undefined,
  });
  if (error) {
    if (error.code === 'P0002' || /tenancy_not_found/.test(error.message)) {
      throw new ApiError(404, 'not_found', 'tenancy not found');
    }
    throw new ApiError(500, 'database_error', error.message);
  }
  const result = data as { document: object; version: object; deduped?: boolean } | null;
  if (!result) throw new ApiError(500, 'database_error', 'document creation returned no row');
  const rawDocument = result.document as { id?: unknown };
  if (typeof rawDocument.id !== 'string') {
    throw new ApiError(500, 'database_error', 'document creation returned no document id');
  }
  const versions = await latestVersions(sb, params.p_account_id, [rawDocument.id]);
  const version = versions.get(rawDocument.id);
  if (!version) throw new ApiError(500, 'database_error', 'document creation returned no version');
  const document = {
    ...(result.document as object),
    latest_version: version,
  } as z.infer<typeof DocumentRow>;
  return { document, deduped: result.deduped ?? false };
}

export async function createTenancyDocumentFromImage(
  sb: ReturnType<typeof getSb>,
  params: {
    p_account_id: string;
    p_tenancy_id: string;
    p_document_type: z.infer<typeof DocumentType>;
    p_title: string;
    p_requires_ack: boolean;
    p_original_receipt_id: string;
    p_pdf_receipt_id: string;
  },
): Promise<{ document: z.infer<typeof DocumentRow>; deduped: boolean }> {
  const { data, error } = await sb.rpc('create_tenancy_document_from_image', params);
  if (error) {
    if (error.code === 'P0002' || /tenancy_not_found/.test(error.message)) {
      throw new ApiError(404, 'not_found', 'tenancy not found');
    }
    if (error.code === '22023') throw new ApiError(400, 'invalid_request', error.message);
    throw new ApiError(500, 'database_error', error.message);
  }
  const result = data as { document?: { id?: unknown }; deduped?: boolean } | null;
  if (!result || typeof result.document?.id !== 'string') {
    throw new ApiError(500, 'database_error', 'image document creation returned no document id');
  }
  const documentId = result.document.id;
  const versions = await latestVersions(sb, params.p_account_id, [documentId]);
  const version = versions.get(documentId);
  if (!version)
    throw new ApiError(500, 'database_error', 'image document creation returned no version');
  return {
    document: { ...(result.document as object), latest_version: version } as z.infer<
      typeof DocumentRow
    >,
    deduped: result.deduped ?? false,
  };
}

export async function createTenancyDocumentFromUpload(
  sb: ReturnType<typeof getSb>,
  params: {
    p_account_id: string;
    p_tenancy_id: string;
    p_document_type: z.infer<typeof DocumentType>;
    p_title: string;
    p_requires_ack: boolean;
    p_upload_receipt_id: string;
  },
): Promise<{ document: z.infer<typeof DocumentRow>; deduped: boolean }> {
  const { data, error } = await sb.rpc('create_tenancy_document_from_upload', params);
  if (error) {
    if (error.code === 'P0002' || /(?:tenancy|upload_receipt)_not_found/.test(error.message)) {
      throw new ApiError(404, 'not_found', 'tenancy or upload receipt not found');
    }
    if (error.code === '22023') throw new ApiError(400, 'invalid_request', error.message);
    throw new ApiError(500, 'database_error', error.message);
  }
  const result = data as { document?: { id?: unknown }; deduped?: boolean } | null;
  if (!result || typeof result.document?.id !== 'string') {
    throw new ApiError(500, 'database_error', 'document upload returned no document id');
  }
  const versions = await latestVersions(sb, params.p_account_id, [result.document.id]);
  const version = versions.get(result.document.id);
  if (!version) throw new ApiError(500, 'database_error', 'document upload returned no version');
  return {
    document: { ...(result.document as object), latest_version: version } as z.infer<
      typeof DocumentRow
    >,
    deduped: result.deduped ?? false,
  };
}
