import { createHash } from 'node:crypto';
import { ApiError } from '../routes/_lib/error';
import { downloadAttachment } from './storage';
import { getAdminClient } from './supabase-admin';
import { readStaticDocumentAsset } from './document-templates';

interface DocumentVersionRow {
  id: string;
  account_id: string;
  document_id: string;
  version_no: number;
  source: 'landlord_upload' | 'bundled_static';
  attachment_id: string | null;
  static_template_id: string | null;
  static_asset_path: string | null;
  content_hash: string;
  mime_type: string;
  size_bytes: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

interface DocumentRow {
  id: string;
  account_id: string;
  tenancy_id: string;
  document_type: 'lease' | 'move_in' | 'move_out' | 'lead_paint' | 'disclosure' | 'other';
  title: string;
  requires_ack: boolean;
  published_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  latest_version: DocumentVersionRow | null;
}

export interface DocumentAccessTokenRow {
  id: string;
  account_id: string;
  tenancy_id: string;
  tenant_id: string | null;
  expires_at: string;
}

async function latestVersionsAdmin(
  accountId: string,
  documentIds: string[],
): Promise<Map<string, DocumentVersionRow>> {
  const out = new Map<string, DocumentVersionRow>();
  if (documentIds.length === 0) return out;
  const admin = getAdminClient();
  const { data, error } = await admin
    .from('document_versions')
    .select('*')
    .eq('account_id', accountId)
    .in('document_id', documentIds)
    .is('deleted_at', null)
    .order('version_no', { ascending: false });
  if (error) throw new ApiError(500, 'database_error', error.message);
  for (const row of (data ?? []) as DocumentVersionRow[]) {
    if (!out.has(row.document_id)) out.set(row.document_id, row);
  }
  return out;
}

async function withLatestVersionsAdmin(
  accountId: string,
  docs: Array<Omit<DocumentRow, 'latest_version'>>,
): Promise<DocumentRow[]> {
  const versions = await latestVersionsAdmin(accountId, docs.map((d) => d.id));
  return docs.map((d) => ({ ...d, latest_version: versions.get(d.id) ?? null }));
}

export async function loadDocumentForDownload(accountId: string, documentId: string): Promise<{
  document: DocumentRow;
  bytes: Uint8Array;
  mimeType: string;
  filename: string;
  contentHash: string;
}> {
  const admin = getAdminClient();
  const { data: doc, error } = await admin
    .from('documents')
    .select('*')
    .eq('account_id', accountId)
    .eq('id', documentId)
    .is('deleted_at', null)
    .maybeSingle();
  if (error) throw new ApiError(500, 'database_error', error.message);
  if (!doc) throw new ApiError(404, 'not_found', 'document not found');
  const [document] = await withLatestVersionsAdmin(
    accountId,
    [doc as Omit<DocumentRow, 'latest_version'>],
  );
  if (!document?.latest_version) throw new ApiError(404, 'not_found', 'document has no version');
  const version = document.latest_version;
  if (version.source === 'landlord_upload') {
    if (!version.attachment_id) throw new ApiError(500, 'database_error', 'uploaded document missing attachment');
    const dl = await downloadAttachment(accountId, version.attachment_id);
    return {
      document,
      bytes: dl.bytes,
      mimeType: dl.mimeType,
      filename: `${document.title}.pdf`.replace(/[^A-Za-z0-9._-]/g, '_'),
      contentHash: dl.contentHash,
    };
  }
  if (!version.static_asset_path) {
    throw new ApiError(500, 'database_error', 'static document missing asset path');
  }
  const asset = await readStaticDocumentAsset(version.static_asset_path);
  return {
    document,
    bytes: asset.bytes,
    mimeType: version.mime_type,
    filename: `${document.title}.pdf`.replace(/[^A-Za-z0-9._-]/g, '_'),
    contentHash: asset.content_hash,
  };
}

function hashSecret(secret: string): Buffer {
  return createHash('sha256').update(secret, 'utf8').digest();
}

export async function lookupDocumentAccessToken(secret: string): Promise<DocumentAccessTokenRow> {
  const admin = getAdminClient();
  const hash = hashSecret(secret);
  const { data, error } = await admin
    .from('document_access_tokens')
    .select('id, account_id, tenancy_id, tenant_id, expires_at, revoked_at, deleted_at')
    .eq('secret_hash', '\\x' + hash.toString('hex'))
    .maybeSingle();
  if (error) throw new ApiError(500, 'database_error', error.message);
  if (!data || data.revoked_at || data.deleted_at) {
    throw new ApiError(404, 'not_found', 'invalid token');
  }
  if (new Date(data.expires_at as string).getTime() <= Date.now()) {
    throw new ApiError(404, 'not_found', 'invalid token');
  }
  await admin
    .from('document_access_tokens')
    .update({ last_used_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('id', data.id);
  return {
    id: data.id as string,
    account_id: data.account_id as string,
    tenancy_id: data.tenancy_id as string,
    tenant_id: (data.tenant_id as string | null) ?? null,
    expires_at: data.expires_at as string,
  };
}

export async function insertDocumentAccessEvent(args: {
  token: DocumentAccessTokenRow;
  documentId: string;
  documentVersionId: string | null;
  eventType: 'viewed' | 'downloaded' | 'acknowledged';
  ip: string;
  userAgent: string | null;
}): Promise<{ occurred_at: string }> {
  const admin = getAdminClient();
  const row = {
    account_id: args.token.account_id,
    tenancy_id: args.token.tenancy_id,
    document_id: args.documentId,
    document_version_id: args.documentVersionId,
    token_id: args.token.id,
    tenant_id: args.token.tenant_id,
    event_type: args.eventType,
    ip: args.ip.slice(0, 128),
    user_agent: args.userAgent?.slice(0, 500) ?? null,
  };
  const { data, error } = await admin
    .from('document_access_events')
    .insert(row)
    .select('occurred_at')
    .single();
  if (error) {
    if (error.code === '23505' && args.eventType === 'acknowledged') {
      const existing = await admin
        .from('document_access_events')
        .select('occurred_at')
        .eq('token_id', args.token.id)
        .eq('document_id', args.documentId)
        .eq('event_type', 'acknowledged')
        .is('deleted_at', null)
        .maybeSingle();
      if (existing.error) throw new ApiError(500, 'database_error', existing.error.message);
      if (existing.data) return { occurred_at: existing.data.occurred_at as string };
    }
    throw new ApiError(500, 'database_error', error.message);
  }
  return { occurred_at: data!.occurred_at as string };
}

export async function tenantDocumentAccessPayload(args: {
  secret: string;
  ip: string;
  userAgent: string | null;
}): Promise<{
  token: { id: string; expires_at: string };
  tenancy: { id: string; area_id: string; unit_name: string; property_name: string };
  documents: Array<{
    id: string;
    document_type: DocumentRow['document_type'];
    title: string;
    requires_ack: boolean;
    published_at: string;
    acknowledged_at: string | null;
    latest_version: DocumentVersionRow;
  }>;
}> {
  const token = await lookupDocumentAccessToken(args.secret);
  const admin = getAdminClient();
  const { data: tenancy, error: tErr } = await admin
    .from('tenancies')
    .select('id, area_id, areas!inner(name, properties!inner(name))')
    .eq('account_id', token.account_id)
    .eq('id', token.tenancy_id)
    .is('deleted_at', null)
    .maybeSingle();
  if (tErr) throw new ApiError(500, 'database_error', tErr.message);
  if (!tenancy) throw new ApiError(404, 'not_found', 'invalid token');

  const { data: docsRaw, error: docsErr } = await admin
    .from('documents')
    .select('*')
    .eq('account_id', token.account_id)
    .eq('tenancy_id', token.tenancy_id)
    .is('deleted_at', null)
    .not('published_at', 'is', null)
    .lte('published_at', new Date().toISOString())
    .order('created_at', { ascending: false });
  if (docsErr) throw new ApiError(500, 'database_error', docsErr.message);
  const docs = await withLatestVersionsAdmin(
    token.account_id,
    (docsRaw ?? []) as Array<Omit<DocumentRow, 'latest_version'>>,
  );
  const docsWithVersions = docs.filter((d): d is DocumentRow & { latest_version: DocumentVersionRow } =>
    d.latest_version !== null,
  );

  const { data: ackRows, error: ackErr } = await admin
    .from('document_access_events')
    .select('document_id, occurred_at')
    .eq('token_id', token.id)
    .eq('event_type', 'acknowledged')
    .is('deleted_at', null);
  if (ackErr) throw new ApiError(500, 'database_error', ackErr.message);
  const ackByDoc = new Map((ackRows ?? []).map((r) => [r.document_id as string, r.occurred_at as string]));

  if (docsWithVersions.length > 0) {
    const viewedRows = docsWithVersions.map((d) => ({
      account_id: token.account_id,
      tenancy_id: token.tenancy_id,
      document_id: d.id,
      document_version_id: d.latest_version.id,
      token_id: token.id,
      tenant_id: token.tenant_id,
      event_type: 'viewed',
      ip: args.ip.slice(0, 128),
      user_agent: args.userAgent?.slice(0, 500) ?? null,
    }));
    const { error: evErr } = await admin.from('document_access_events').insert(viewedRows);
    if (evErr) throw new ApiError(500, 'database_error', evErr.message);
  }

  const area = Array.isArray(tenancy.areas) ? tenancy.areas[0] : tenancy.areas;
  const property = Array.isArray(area?.properties) ? area?.properties[0] : area?.properties;
  return {
    token: { id: token.id, expires_at: token.expires_at },
    tenancy: {
      id: token.tenancy_id,
      area_id: tenancy.area_id as string,
      unit_name: (area?.name as string | undefined) ?? '',
      property_name: (property?.name as string | undefined) ?? '',
    },
    documents: docsWithVersions.map((d) => ({
      id: d.id,
      document_type: d.document_type,
      title: d.title,
      requires_ack: d.requires_ack,
      published_at: d.published_at!,
      acknowledged_at: ackByDoc.get(d.id) ?? null,
      latest_version: d.latest_version,
    })),
  };
}
