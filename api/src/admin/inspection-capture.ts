import { randomBytes, createHash } from 'node:crypto';
import { ApiError } from '../routes/_lib/error';
import { getLogger } from '../log';
import { getAdminClient } from './supabase-admin';
import { getMailer } from './mailer';
import { removeOrphanStoredObject, type StoragePutResult } from './storage';

// ============================================================================
// Tenant capture magic-link helpers (service-role).
// ============================================================================
//
// A capture token is a WRITE-scoped magic link bound to ONE inspection (vs the
// READ-only document_access tokens). The raw secret is never stored -- only its
// sha256. Mirrors the document-access security model; writes go through the
// SECURITY DEFINER tenant_* RPCs (which stamp the audit actor as tenant:<token>).

export const DEFAULT_CAPTURE_TTL_MIN = 7 * 24 * 60; // 7 days: filling a form takes time
export const MAX_CAPTURE_TTL_MIN = 30 * 24 * 60; // 30 days

const CAPTURE_IP_SCOPE = 'capture_access';
const CAPTURE_IP_WINDOW_S = 10 * 60;
const CAPTURE_IP_LIMIT = 120;
const TOKEN_TOUCH_MIN_INTERVAL_MS = 60 * 1000;

export function generateCaptureSecret(): string {
  return randomBytes(32).toString('base64url');
}

export function hashCaptureSecret(secret: string): Buffer {
  return createHash('sha256').update(secret, 'utf8').digest();
}

function captureBaseUrl(): string {
  // Frontend capture page base. Stub-friendly default; set APP_BASE_URL in prod.
  return process.env.APP_BASE_URL ?? 'https://app.example';
}

export interface CaptureTokenRow {
  id: string;
  account_id: string;
  inspection_id: string;
  tenant_id: string | null;
  expires_at: string;
}

/**
 * Per-IP sliding window for the public capture endpoints. Fails OPEN: the
 * token is the real auth, this is just an abuse backstop (same posture as the
 * document-access limiter).
 */
export async function bumpCaptureIpRate(ip: string): Promise<{ ok: boolean }> {
  const admin = getAdminClient();
  const { data, error } = await admin.rpc('bump_ip_rate_bucket', {
    p_ip: ip.slice(0, 64),
    p_scope: CAPTURE_IP_SCOPE,
    p_window_sec: CAPTURE_IP_WINDOW_S,
  });
  if (error) return { ok: true };
  const count = typeof data === 'number' ? data : Number(data);
  if (!Number.isFinite(count)) return { ok: true };
  return { ok: count <= CAPTURE_IP_LIMIT };
}

/** Verify a live (non-expired, non-revoked) token; throttle the last_used bump. */
export async function lookupCaptureToken(secret: string): Promise<CaptureTokenRow> {
  const admin = getAdminClient();
  const hash = hashCaptureSecret(secret);
  const { data, error } = await admin
    .from('inspection_capture_tokens')
    .select('id, account_id, inspection_id, tenant_id, expires_at, revoked_at, deleted_at, last_used_at')
    .eq('secret_hash', '\\x' + hash.toString('hex'))
    .maybeSingle();
  if (error) throw new ApiError(500, 'database_error', error.message);
  if (!data || data.revoked_at || data.deleted_at) {
    throw new ApiError(404, 'not_found', 'invalid token');
  }
  if (new Date(data.expires_at as string).getTime() <= Date.now()) {
    throw new ApiError(404, 'not_found', 'expired token');
  }
  const lastUsedMs = data.last_used_at ? new Date(data.last_used_at as string).getTime() : 0;
  if (Date.now() - lastUsedMs > TOKEN_TOUCH_MIN_INTERVAL_MS) {
    const nowIso = new Date().toISOString();
    await admin.from('inspection_capture_tokens')
      .update({ last_used_at: nowIso, updated_at: nowIso })
      .eq('id', data.id);
  }
  return {
    id: data.id as string,
    account_id: data.account_id as string,
    inspection_id: data.inspection_id as string,
    tenant_id: (data.tenant_id as string | null) ?? null,
    expires_at: data.expires_at as string,
  };
}

/** Insert a fresh capture token via the admin client (used by renewal). */
async function mintCaptureTokenAdmin(opts: {
  accountId: string;
  inspectionId: string;
  tenantId: string | null;
  ttlMinutes: number;
}): Promise<{ id: string; secret: string; expires_at: string }> {
  const admin = getAdminClient();
  const secret = generateCaptureSecret();
  const expiresAt = new Date(Date.now() + opts.ttlMinutes * 60 * 1000).toISOString();
  const { data, error } = await admin
    .from('inspection_capture_tokens')
    .insert({
      account_id: opts.accountId,
      inspection_id: opts.inspectionId,
      tenant_id: opts.tenantId,
      secret_hash: '\\x' + hashCaptureSecret(secret).toString('hex'),
      expires_at: expiresAt,
    })
    .select('id, expires_at')
    .single();
  if (error || !data) throw new ApiError(500, 'database_error', error?.message ?? 'token insert failed');
  return { id: data.id as string, secret, expires_at: data.expires_at as string };
}

/** The form a tenant fills: inspection subset + items + checks, token-scoped. */
export async function loadCaptureForm(token: CaptureTokenRow): Promise<{
  token: { id: string; expires_at: string };
  inspection: Record<string, unknown>;
  items: Record<string, unknown>[];
  checks: Record<string, unknown>[];
}> {
  const admin = getAdminClient();
  const insp = await admin
    .from('inspections')
    .select('id, kind, status, capture_mode, area_id, performed_at, completed_at, notes')
    .eq('account_id', token.account_id)
    .eq('id', token.inspection_id)
    .is('deleted_at', null)
    .maybeSingle();
  if (insp.error) throw new ApiError(500, 'database_error', insp.error.message);
  if (!insp.data) throw new ApiError(404, 'not_found', 'inspection not found');

  const items = await admin
    .from('inspection_items')
    .select('id, label, condition, notes, item_key, group_label, sort_order')
    .eq('account_id', token.account_id)
    .eq('inspection_id', token.inspection_id)
    .is('deleted_at', null)
    .order('sort_order', { ascending: true, nullsFirst: false })
    .order('created_at', { ascending: true });
  if (items.error) throw new ApiError(500, 'database_error', items.error.message);

  const checks = await admin
    .from('inspection_checks')
    .select('id, field_key, label, group_label, value, sort_order')
    .eq('account_id', token.account_id)
    .eq('inspection_id', token.inspection_id)
    .is('deleted_at', null)
    .order('sort_order', { ascending: true, nullsFirst: false })
    .order('created_at', { ascending: true });
  if (checks.error) throw new ApiError(500, 'database_error', checks.error.message);

  // Attach photos (attachments with entity_type='inspection_items') to each item.
  const itemIds = (items.data ?? []).map((i) => i.id as string);
  type PhotoEntry = {
    id: string;
    mime_type: string | null;
    size_bytes: number | null;
    derived_from: string | null;
    content_hash: string;
  };
  const photosMap: Record<string, PhotoEntry[]> = {};
  if (itemIds.length > 0) {
    const photosRes = await admin
      .from('attachments')
      .select('id, entity_id, mime_type, size_bytes, derived_from, content_hash')
      .eq('account_id', token.account_id)
      .eq('entity_type', 'inspection_items')
      .in('entity_id', itemIds)
      .is('deleted_at', null);
    if (photosRes.error) throw new ApiError(500, 'database_error', photosRes.error.message);
    for (const p of (photosRes.data ?? [])) {
      const eid = p.entity_id as string;
      if (!photosMap[eid]) photosMap[eid] = [];
      photosMap[eid].push({
        id: p.id as string,
        mime_type: p.mime_type as string | null,
        size_bytes: p.size_bytes as number | null,
        derived_from: p.derived_from as string | null,
        content_hash: p.content_hash as string,
      });
    }
  }
  const itemsWithPhotos = (items.data ?? []).map((item) => ({
    ...item,
    photos: photosMap[item.id as string] ?? [],
  }));

  return {
    token: { id: token.id, expires_at: token.expires_at },
    inspection: insp.data as Record<string, unknown>,
    items: itemsWithPhotos as Record<string, unknown>[],
    checks: (checks.data ?? []) as Record<string, unknown>[],
  };
}

/**
 * Self-service renewal. Uniform behaviour regardless of outcome
 * (anti-enumeration): always resolves. Finds the token even if EXPIRED (so a
 * tenant holding only the dead link can renew), mints a fresh one, and sends
 * it ONLY to the tenant's on-file email -- never to a requester-supplied
 * address. Send is via the Mailer (a logging stub until a provider is wired).
 */
export async function requestCaptureRenewal(args: { secret: string }): Promise<void> {
  const admin = getAdminClient();
  const hash = hashCaptureSecret(args.secret);
  const { data: tok } = await admin
    .from('inspection_capture_tokens')
    .select('id, account_id, inspection_id, tenant_id, revoked_at, deleted_at')
    .eq('secret_hash', '\\x' + hash.toString('hex'))
    .maybeSingle();
  if (!tok || tok.revoked_at || tok.deleted_at) return;

  // Resolve the on-file email for the token's tenant. No tenant / no email ->
  // nothing to send (still uniform: caller can't tell the difference).
  if (!tok.tenant_id) return;
  const { data: tenant } = await admin
    .from('tenants')
    .select('emails')
    .eq('account_id', tok.account_id)
    .eq('id', tok.tenant_id)
    .is('deleted_at', null)
    .maybeSingle();
  const emails = (tenant?.emails as string[] | null) ?? [];
  const email = emails[0];
  if (!email) return;

  const minted = await mintCaptureTokenAdmin({
    accountId: tok.account_id as string,
    inspectionId: tok.inspection_id as string,
    tenantId: tok.tenant_id as string,
    ttlMinutes: DEFAULT_CAPTURE_TTL_MIN,
  });
  const link = `${captureBaseUrl()}/capture/${minted.secret}`;
  // Anti-enumeration: this path must resolve uniformly (the route always 202s).
  // A real Mailer throws on send failure, so swallow it here -- never let a
  // provider outage turn into a 500 that signals "valid token + deliverable
  // contact". Log for diagnosis; the tenant can retry the renewal request.
  try {
    await getMailer().send({
      to: email,
      subject: 'Your condition form link',
      text:
        `Here is a fresh link to complete your move-in/move-out condition form:\n\n${link}\n\n` +
        `It expires in ${Math.round(DEFAULT_CAPTURE_TTL_MIN / 60 / 24)} days.`,
    });
  } catch (err) {
    getLogger().error(`[capture-renewal] email send failed: ${String(err)}`);
  }
}

// --- tenant write helpers (call the SECURITY DEFINER tenant_* RPCs) ----------
// Kept here (not in the route) so the service-role client stays quarantined in
// admin/. The DEFINER RPCs stamp the audit actor as tenant:<token>.

function rpcError(error: { code?: string; message: string }): ApiError {
  if (error.code === 'P0002') return new ApiError(404, 'not_found', error.message);
  if (error.code === '23514') return new ApiError(409, 'conflict', error.message);
  if (error.code === '23503') return new ApiError(404, 'not_found', error.message);
  return new ApiError(500, 'database_error', error.message);
}

export async function tenantUpdateItem(
  token: CaptureTokenRow,
  itemId: string,
  condition: string | null,
  notes: string | null,
): Promise<Record<string, unknown>> {
  const admin = getAdminClient();
  const { data, error } = await admin.rpc('tenant_update_inspection_item', {
    p_account_id: token.account_id,
    p_token_id: token.id,
    p_inspection_id: token.inspection_id,
    p_item_id: itemId,
    p_condition: condition,
    p_notes: notes,
  });
  if (error) throw rpcError(error);
  const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null;
  if (!row) throw new ApiError(404, 'not_found', 'item not found');
  return row;
}

export async function tenantUpsertChecks(
  token: CaptureTokenRow,
  checks: unknown[],
): Promise<Record<string, unknown>[]> {
  const admin = getAdminClient();
  const { data, error } = await admin.rpc('tenant_upsert_inspection_checks', {
    p_account_id: token.account_id,
    p_token_id: token.id,
    p_inspection_id: token.inspection_id,
    p_checks: checks,
  });
  if (error) throw rpcError(error);
  return (data ?? []) as Record<string, unknown>[];
}

export async function tenantSubmit(token: CaptureTokenRow): Promise<Record<string, unknown>> {
  const admin = getAdminClient();
  const { data, error } = await admin.rpc('tenant_submit_inspection', {
    p_account_id: token.account_id,
    p_token_id: token.id,
    p_inspection_id: token.inspection_id,
  });
  if (error) throw rpcError(error);
  const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null;
  if (!row) throw new ApiError(404, 'not_found', 'inspection not found');
  return row;
}

/**
 * Registers a tenant-uploaded photo on an inspection item via the
 * SECURITY DEFINER tenant_attach_inspection_item_photo RPC.
 * On RPC failure, best-effort removes the already-stored bytes to avoid
 * orphaning storage objects, then re-throws.
 */
export async function tenantAttachItemPhoto(
  token: CaptureTokenRow,
  itemId: string,
  put: StoragePutResult,
): Promise<{ attachment_id: string; derivative_id: string | null }> {
  const admin = getAdminClient();
  const { data, error } = await admin.rpc('tenant_attach_inspection_item_photo', {
    p_account_id: token.account_id,
    p_token_id: token.id,
    p_inspection_id: token.inspection_id,
    p_item_id: itemId,
    p_attachment_hash: put.primary.hash,
    p_attachment_mime: put.primary.mimeType,
    p_attachment_size: put.primary.sizeBytes,
    p_attachment_path: put.primary.storagePath,
    p_derivative_hash: put.derivative?.hash ?? null,
    p_derivative_mime: put.derivative?.mimeType ?? null,
    p_derivative_size: put.derivative?.sizeBytes ?? null,
    p_derivative_path: put.derivative?.storagePath ?? null,
  });
  if (error) {
    await removeOrphanStoredObject(token.account_id, put.primary.storagePath).catch(() => {});
    if (put.derivative) {
      await removeOrphanStoredObject(token.account_id, put.derivative.storagePath).catch(() => {});
    }
    throw rpcError(error);
  }
  const row = (Array.isArray(data) ? data[0] : data) as {
    attachment_id: string;
    derivative_id: string | null;
  } | null;
  if (!row) throw new ApiError(404, 'not_found', 'item not found');
  return { attachment_id: row.attachment_id, derivative_id: row.derivative_id ?? null };
}

/**
 * Batch UPDATE-ONLY of inspection items by item_key via the
 * SECURITY DEFINER tenant_upsert_inspection_items RPC.
 * Tenant cannot create new line items; unknown item_keys are silently ignored.
 */
export async function tenantUpsertItems(
  token: CaptureTokenRow,
  items: unknown[],
): Promise<Record<string, unknown>[]> {
  const admin = getAdminClient();
  const { data, error } = await admin.rpc('tenant_upsert_inspection_items', {
    p_account_id: token.account_id,
    p_token_id: token.id,
    p_inspection_id: token.inspection_id,
    p_items: items,
  });
  if (error) throw rpcError(error);
  return (data ?? []) as Record<string, unknown>[];
}

/**
 * Scope-check for the tenant download proxy: returns the attachment row only
 * when the attachment belongs to an item in the token's inspection.
 * Returns null if out of scope (caller raises 404).
 */
export async function lookupCaptureAttachment(
  token: CaptureTokenRow,
  attachmentId: string,
): Promise<{ id: string } | null> {
  const admin = getAdminClient();
  // Resolve which item ids belong to this token's inspection.
  const { data: itemRows, error: itemErr } = await admin
    .from('inspection_items')
    .select('id')
    .eq('account_id', token.account_id)
    .eq('inspection_id', token.inspection_id)
    .is('deleted_at', null);
  if (itemErr) throw new ApiError(500, 'database_error', itemErr.message);
  const itemIds = (itemRows ?? []).map((r) => r.id as string);
  if (itemIds.length === 0) return null;

  const { data, error } = await admin
    .from('attachments')
    .select('id')
    .eq('id', attachmentId)
    .eq('account_id', token.account_id)
    .eq('entity_type', 'inspection_items')
    .in('entity_id', itemIds)
    .is('deleted_at', null)
    .maybeSingle();
  if (error) throw new ApiError(500, 'database_error', error.message);
  return data as { id: string } | null;
}
