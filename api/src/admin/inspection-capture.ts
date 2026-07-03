import { randomBytes, createHash } from 'node:crypto';
import { ApiError } from '../routes/_lib/error';
import { loadEnv } from '../env';
import { getLogger } from '../log';
import { getAdminClient } from './supabase-admin';
import { getMailer } from './mailer';
import { accountFromAddress } from './account-email';
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

/** Insert a fresh capture token via the admin client (used by renewal;
 *  exported for the comms-email integration suite's renewal fixture). */
export async function mintCaptureTokenAdmin(opts: {
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
  confirmed_rooms: (string | null)[]; // null entry = the ungrouped ("General") bucket
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

  // Rooms the tenant has already marked "confirmed good" (funnel telemetry).
  const confirmations = await admin
    .from('inspection_room_confirmations')
    .select('group_label')
    .eq('account_id', token.account_id)
    .eq('inspection_id', token.inspection_id)
    .is('deleted_at', null);
  if (confirmations.error) throw new ApiError(500, 'database_error', confirmations.error.message);
  const confirmedRooms = Array.from(
    new Set((confirmations.data ?? []).map((r) => (r.group_label as string | null) ?? null)),
  );

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
    confirmed_rooms: confirmedRooms,
  };
}

/**
 * Self-service renewal. Uniform behaviour regardless of outcome
 * (anti-enumeration): always resolves. Finds the token even if EXPIRED (so a
 * tenant holding only the dead link can renew), mints a fresh one, and sends
 * it ONLY to the tenant's on-file email -- never to a requester-supplied
 * address. The Mailer send is best-effort and is NOT awaited, so neither a
 * provider failure nor its latency can change the uniform 202 response.
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

  // Anti-enumeration: the route always 202s, so the whole valid-path tail must
  // resolve like every early-return above -- never as a 500, and never with a
  // latency that depends on validity. Two hazards, both handled here:
  //   1. mintCaptureTokenAdmin throws ApiError(500) on a DB failure; left
  //      uncaught it would surface as a 500 that signals "valid token +
  //      deliverable contact". Wrap it so the response stays a uniform 202.
  //   2. Awaiting the Mailer (a real provider makes a remote HTTP round-trip)
  //      would turn the 202's latency into a timing oracle for that same fact.
  //      Fire the send without awaiting so response time is independent of
  //      outcome. Render runs a persistent process, so the send still completes.
  // Both failures are logged for diagnosis; the tenant can retry the renewal.
  try {
    const minted = await mintCaptureTokenAdmin({
      accountId: tok.account_id as string,
      inspectionId: tok.inspection_id as string,
      tenantId: tok.tenant_id as string,
      ttlMinutes: DEFAULT_CAPTURE_TTL_MIN,
    });
    const link = `${captureBaseUrl()}/capture/${minted.secret}`;
    const subjectLine = 'Your condition form link';
    const text =
      `Here is a fresh link to complete your move-in/move-out condition form:\n\n${link}\n\n` +
      `It expires in ${Math.round(DEFAULT_CAPTURE_TTL_MIN / 60 / 24)} days.`;

    if (loadEnv().COMMS_EMAIL_PIPELINE) {
      // Cutover path: core writes its OWN comm_outbox ledger row instead of
      // calling a provider. Core writing its own ledger is NOT "core sends" —
      // the transport still makes the provider call off this outbox row.
      // approval_ref='system:capture_renewal' is the honest provenance for a
      // fixed server flow (no human approved this specific message, no standing
      // grant covers it), and this row is this flow's FIRST journal record ever.
      // Fire-and-forget (not awaited), exactly like the legacy mailer call, so
      // the anti-enumeration contract holds: uniform 202, no provider/DB latency
      // folded into the response. Never throws out of the void block.
      void (async () => {
        const { data: insp } = await admin
          .from('inspections')
          .select('tenancy_id')
          .eq('account_id', tok.account_id)
          .eq('id', tok.inspection_id)
          .maybeSingle();
        const { error } = await admin.from('comm_outbox').insert({
          account_id: tok.account_id,
          channel: 'email',
          to_address: email.trim().toLowerCase(),
          subject: subjectLine,
          body: text,
          approval_ref: 'system:capture_renewal',
          author_type: 'system',
          tenancy_id: (insp?.tenancy_id as string | null) ?? null,
        });
        if (error) {
          // P0004 = destination on the opt-out register: the send was refused
          // before any intent recorded. Expected, compliant behavior — not an
          // error; log at info so it's visible but doesn't page.
          if (error.code === 'P0004') {
            getLogger().info('[capture-renewal] outbox intent suppressed by opt-out (compliant)');
          } else {
            getLogger().error(`[capture-renewal] outbox insert failed: ${error.message}`);
          }
        }
      })().catch((err) => {
        getLogger().error(`[capture-renewal] outbox write failed: ${String(err)}`);
      });
    } else {
      // Legacy path (mailer sends directly): same non-awaited send. The
      // account's From identity (slug@ACCOUNT_EMAIL_DOMAIN) is resolved
      // INSIDE the void block so the anti-enumeration contract holds (no DB
      // latency folded into the uniform 202); a miss falls back to MAIL_FROM.
      void (async () => {
        const from = await accountFromAddress(tok.account_id);
        await getMailer().send({
          to: email,
          subject: subjectLine,
          text,
          ...(from ? { from } : {}),
        });
      })().catch((err) => {
        getLogger().error(`[capture-renewal] email send failed: ${String(err)}`);
      });
    }
  } catch (err) {
    getLogger().error(`[capture-renewal] renewal failed: ${String(err)}`);
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
 * Stamp form_opened_at the first time the tenant loads the form (set-once,
 * GET-only). Called from the capture-form GET handler after the token is
 * verified; the DEFINER RPC no-ops if already stamped or the inspection is
 * completed.
 *
 * BEST-EFFORT: this is funnel telemetry, and the form GET was side-effect-free
 * before it. A stamp failure must NEVER block the tenant from viewing the form,
 * so we log and swallow rather than throw. (Caveat: because it fires on the raw
 * GET, email link-scanners / SafeLinks prefetch can stamp "opened" before the
 * human clicks -- an inherent limit of GET-based open tracking; a future
 * render-time beacon from the FE would be needed for click-accurate opens.)
 */
export async function tenantMarkFormOpened(token: CaptureTokenRow): Promise<void> {
  const admin = getAdminClient();
  const { error } = await admin.rpc('tenant_mark_form_opened', {
    p_account_id: token.account_id,
    p_token_id: token.id,
    p_inspection_id: token.inspection_id,
  });
  if (error) getLogger().warn(`[capture] form_opened stamp failed (non-fatal): ${error.message}`);
}

/**
 * Tenant marks one section "confirmed good" (funnel telemetry -> rooms_done).
 * Confirm-only + idempotent (RPC on-conflict-do-nothing); also counts as a
 * tenant write, so it stamps form_started_at.
 */
export async function tenantConfirmRoom(
  token: CaptureTokenRow,
  groupLabel: string | null,
): Promise<void> {
  const admin = getAdminClient();
  const { error } = await admin.rpc('tenant_confirm_inspection_room', {
    p_account_id: token.account_id,
    p_token_id: token.id,
    p_inspection_id: token.inspection_id,
    p_group_label: groupLabel, // null => the ungrouped ("General") bucket
  });
  if (error) throw rpcError(error);
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
