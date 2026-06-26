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

// Magic-link reads are legitimate (a tenant may browse several documents), so
// the per-IP cap is generous; the real write bound is the once-per-(token,doc)
// 'viewed' dedupe below. This window is the abuse backstop on an unauthenticated
// surface, reusing the same DB sliding-window the intake flow uses.
const DOC_ACCESS_IP_SCOPE = 'doc_access';
const DOC_ACCESS_IP_WINDOW_S = 10 * 60;
const DOC_ACCESS_IP_LIMIT = 120;
const TOKEN_TOUCH_MIN_INTERVAL_MS = 60 * 1000;

/**
 * Per-IP sliding-window rate limit for the public document-access endpoints.
 * Fail-closed: if the rate-limit infra is unreachable we deny rather than leave
 * a leaked link un-bounded (a temporary 429 is strictly safer).
 */
export async function bumpDocAccessIpRate(ip: string): Promise<{ ok: boolean }> {
  const admin = getAdminClient();
  const { data, error } = await admin.rpc('bump_ip_rate_bucket', {
    p_ip: ip.slice(0, 64),
    p_scope: DOC_ACCESS_IP_SCOPE,
    p_window_sec: DOC_ACCESS_IP_WINDOW_S,
  });
  if (error) return { ok: false };
  const count = typeof data === 'number' ? data : Number(data);
  return { ok: count <= DOC_ACCESS_IP_LIMIT };
}

/** Test-only: clears the per-IP DB buckets so tests don't leak across runs. */
export async function _resetDocAccessIpBucketsForTests(): Promise<void> {
  const admin = getAdminClient();
  await admin.from('ip_rate_buckets').delete().eq('scope', DOC_ACCESS_IP_SCOPE);
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
    .select('id, account_id, tenancy_id, tenant_id, expires_at, revoked_at, deleted_at, last_used_at')
    .eq('secret_hash', '\\x' + hash.toString('hex'))
    .maybeSingle();
  if (error) throw new ApiError(500, 'database_error', error.message);
  if (!data || data.revoked_at || data.deleted_at) {
    throw new ApiError(404, 'not_found', 'invalid token');
  }
  if (new Date(data.expires_at as string).getTime() <= Date.now()) {
    throw new ApiError(404, 'not_found', 'invalid token');
  }
  // Throttle the last_used_at write: every UPDATE here fires the audit trigger
  // (a per-account chain row), so on a refresh-heavy magic link we'd amplify
  // audit writes one-per-request. Only bump when the stamp is stale (>60s).
  const lastUsedMs = data.last_used_at ? new Date(data.last_used_at as string).getTime() : 0;
  if (Date.now() - lastUsedMs > TOKEN_TOUCH_MIN_INTERVAL_MS) {
    const nowIso = new Date().toISOString();
    await admin
      .from('document_access_tokens')
      .update({ last_used_at: nowIso, updated_at: nowIso })
      .eq('id', data.id);
  }
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
    // Record at most one 'viewed' event per (token, document). Without this a
    // refresh re-inserts a viewed row (and a per-account audit-chain row) for
    // every document on every load. We skip docs this token has already viewed
    // and let the unique partial index back-stop races (swallow 23505).
    const { data: seenRows, error: seenErr } = await admin
      .from('document_access_events')
      .select('document_id')
      .eq('token_id', token.id)
      .eq('event_type', 'viewed')
      .is('deleted_at', null);
    if (seenErr) throw new ApiError(500, 'database_error', seenErr.message);
    const alreadyViewed = new Set((seenRows ?? []).map((r) => r.document_id as string));
    const viewedRows = docsWithVersions
      .filter((d) => !alreadyViewed.has(d.id))
      .map((d) => ({
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
    if (viewedRows.length > 0) {
      const { error: evErr } = await admin.from('document_access_events').insert(viewedRows);
      // 23505 = a concurrent first-view won the race; the viewed row exists,
      // which is the desired end state, so this is not an error.
      if (evErr && evErr.code !== '23505') throw new ApiError(500, 'database_error', evErr.message);
    }
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
