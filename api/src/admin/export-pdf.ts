import { getLogger } from '../log';
import PDFDocument from 'pdfkit';
import { createHash } from 'node:crypto';
import { getAdminClient } from './supabase-admin';
import { MAX_BYTES as UPLOAD_MAX_BYTES } from './storage';

// ============================================================================
// Evidence export bundle renderer.
// ============================================================================
//
// This is the product's reason to exist. A PDF that holds up in a dispute.
// It must:
//
//   (1) Embed the audit-chain verification result prominently. If the chain
//       is broken, say so. A clean-looking PDF over a tampered chain would
//       be worse than no PDF -- it's a credibility trap.
//   (2) Include EVERYTHING in scope: lease(s), full rent ledger
//       (charges/payments/allocations/derived balances/unapplied credit),
//       interactions (channels + occurred_at vs logged_at), maintenance
//       requests + work orders + status history, inspections + reports,
//       notices, photos, and the audit trail.
//   (3) Per-photo chain of custody: original content_hash, server-set
//       received_at, uploader actor (incl. tenant:<token_id> for intake).
//       HEIC originals embed via the derived JPEG; identity stays the
//       original's hash.
//   (4) Work on ENDED / soft-deleted tenancies -- that's precisely WHEN
//       disputes happen.
//   (5) Stamp generated_at. Unlike the inspection report (pinned to
//       completed_at, deterministic across rerenders), an export is a
//       point-in-time snapshot; two exports of the same scope produce
//       different bytes, and that's by design. The bundle's content hash
//       identifies THIS generation.
//   (6) Use a much higher size cap than user uploads; long tenancies with
//       many photos can blow past 20 MiB easily.

// 200 MiB cap on generated artifacts. The user-upload cap stays at 20 MiB
// (DOS protection on tenant intake + landlord uploads); generated bundles
// have a different threat model -- they're server-controlled bytes, not
// untrusted input. We still cap to keep one runaway export from filling
// the storage bucket.
export const MAX_GENERATED_BYTES = 200 * 1024 * 1024;

export interface ExportScope {
  accountId: string;
  tenancyId?: string | null;
  areaId?: string | null;
  fromDate?: string | null;   // ISO date
  toDate?: string | null;     // ISO date
  exporter: string | null;    // auth.users.id of the operator
}

interface ChainStatus {
  ok: boolean;
  message: string;
  broken_at: string | null;
  broken_event_no: number | null;
}

// ---- top-level orchestrator -------------------------------------------------

/**
 * Boot recovery (Phase 2.1): the in-process job queue does not survive a
 * restart, so any export still queued/running at boot can never complete.
 * Mark them failed with an actionable message -- a truthful failed-state
 * beats a forever-pending row. Fire-and-forget from buildApp(); must never
 * throw (envelope/unit tests build the app with no DB configured).
 */
export async function recoverOrphanedEvidenceExports(): Promise<void> {
  try {
    const admin = getAdminClient();
    const { data, error } = await admin
      .from('evidence_exports')
      .update({
        status: 'failed',
        error: 'server restarted before this export was processed; retry the export',
        updated_at: new Date().toISOString(),
      })
      .in('status', ['queued', 'running'])
      .is('deleted_at', null)
      .select('id');
    if (error) {
      getLogger().warn({ err: error }, 'evidence-export boot recovery query failed');
      return;
    }
    if (data && data.length > 0) {
      getLogger().warn(
        { count: data.length, ids: data.map((r) => r.id) },
        'orphaned evidence exports marked failed at boot',
      );
    }
  } catch (err) {
    // No admin env / no DB (unit tests, misconfigured boot): skip quietly.
    getLogger().debug({ err }, 'evidence-export boot recovery skipped');
  }
}

/**
 * Runs ONE queued evidence export to completion (Phase 2.1 job body).
 * Loads the queued row, flips it to running, builds the bundle, and lands
 * the artifact atomically via the complete_evidence_export RPC (which pins
 * audit.actor to the exporter). On any failure the row is marked failed
 * with the error message, then the error is rethrown so the job runner
 * logs it.
 */
export async function buildEvidenceExport(evidenceExportId: string): Promise<void> {
  const admin = getAdminClient();
  const { data: row, error: rowErr } = await admin
    .from('evidence_exports')
    .select('id, account_id, tenancy_id, area_id, from_date, to_date, exporter, status')
    .eq('id', evidenceExportId)
    .is('deleted_at', null)
    .maybeSingle();
  if (rowErr) throw new Error(`export ${evidenceExportId}: row load failed: ${rowErr.message}`);
  if (!row) throw new Error(`export ${evidenceExportId}: row not found`);
  if (row.status !== 'queued') {
    // Already handled (boot recovery, duplicate enqueue, manual ops). Not an error.
    getLogger().warn({ evidenceExportId, status: row.status }, 'export job skipped: not queued');
    return;
  }

  await admin
    .from('evidence_exports')
    .update({ status: 'running', updated_at: new Date().toISOString() })
    .eq('id', evidenceExportId);

  try {
    await renderAndComplete({
      evidenceExportId,
      scope: {
        accountId: row.account_id as string,
        tenancyId: (row.tenancy_id as string | null) ?? null,
        areaId: (row.area_id as string | null) ?? null,
        fromDate: (row.from_date as string | null) ?? null,
        toDate: (row.to_date as string | null) ?? null,
        exporter: (row.exporter as string | null) ?? null,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await admin
      .from('evidence_exports')
      .update({ status: 'failed', error: message.slice(0, 2000), updated_at: new Date().toISOString() })
      .eq('id', evidenceExportId)
      .then(({ error }) => {
        if (error) getLogger().error({ err: error, evidenceExportId }, 'could not mark export failed');
      });
    throw err;
  }
}

async function renderAndComplete(args: {
  evidenceExportId: string;
  scope: ExportScope;
}): Promise<void> {
  const { evidenceExportId, scope } = args;
  const admin = getAdminClient();
  const generatedAt = new Date();

  if (!scope.tenancyId && !scope.areaId) {
    throw new Error('export scope must include at least tenancy_id or area_id');
  }

  // 1. Verify the audit chain BEFORE rendering. We embed the result inside
  //    the PDF; a generated-but-broken chain is exactly the case the
  //    verification banner exists to surface.
  const chain = await verifyChain(scope.accountId);

  // Out-of-band signal (Phase 11 flag A): a broken chain is a security
  // incident (DB-owner-level tampering). The PDF banner is reactive --
  // someone has to export and look. Surface it to stderr in a structured
  // shape so log pipelines / on-call alerting catch it the moment it
  // happens. The proactive cron (verify_chain_sweep) is what catches it
  // when no one is exporting; this log is the export-time companion.
  if (!chain.ok) {
    getLogger().error(
      {
        event: 'audit_chain_broken',
        account_id: scope.accountId,
        broken_at: chain.broken_at,
        broken_event_no: chain.broken_event_no,
        message: chain.message,
        detected_via: 'evidence_export',
        exporter: scope.exporter,
      },
      'audit chain broken',
    );
  }

  // 2. Load every entity in scope. These queries use the admin client; the
  //    caller (the route handler) is responsible for verifying the user is
  //    a member of `accountId` before invoking this builder.
  const data = await loadExportData(scope);

  // 3. Render PDF.
  const pdfBytes = await renderExportPdf({
    scope,
    generatedAt,
    chain,
    data,
  });

  if (pdfBytes.byteLength > MAX_GENERATED_BYTES) {
    throw new Error(
      `generated export exceeds MAX_GENERATED_BYTES (${pdfBytes.byteLength} > ${MAX_GENERATED_BYTES})`,
    );
  }

  // 4. Hash + store. We bypass processAndStoreBytes' MAX_BYTES (20 MiB
  //    user-upload cap) by uploading directly via the same content-addressed
  //    path scheme. Caps are different threat models: user uploads = DOS
  //    protection on untrusted input; generated bytes = server-controlled.
  const contentHash = createHash('sha256').update(pdfBytes).digest('hex');
  const storagePath = `${scope.accountId}/${contentHash}.pdf`;
  const { error: upErr } = await admin.storage.from('attachments').upload(
    storagePath,
    pdfBytes,
    { contentType: 'application/pdf', upsert: true },
  );
  if (upErr) {
    throw new Error(`evidence-export storage upload failed: ${upErr.message}`);
  }

  // 5. Land the artifact via complete_evidence_export: ONE txn that inserts
  //    the attachment row and flips the export row to done, with audit.actor
  //    pinned to 'user:<exporter>' inside the function so both audit events
  //    carry the operator attribution. Same atomicity discipline as
  //    submit_intake_with_attachment (Phase 9) applied here.
  const attachmentId = crypto.randomUUID();
  const rpcRes = await admin.rpc('complete_evidence_export', {
    p_evidence_export_id: evidenceExportId,
    p_attachment_id:      attachmentId,
    p_storage_path:       storagePath,
    p_content_hash:       contentHash,
    p_size_bytes:         pdfBytes.byteLength,
    p_generated_at:       generatedAt.toISOString(),
    p_chain_verified:     chain.ok,
    p_chain_message:      chain.message,
  });
  if (rpcRes.error) {
    // Storage bytes are orphan-safe; a future janitor prunes paths that
    // have no attachments row. Don't try to remove() here -- a transient
    // network blip would re-orphan a legitimate generation.
    throw new Error(`complete_evidence_export failed: ${rpcRes.error.message}`);
  }
}

void UPLOAD_MAX_BYTES; // kept-imported for callers that read both caps

// ---- audit chain verification ----------------------------------------------

async function verifyChain(accountId: string): Promise<ChainStatus> {
  const admin = getAdminClient();
  const { data, error } = await admin.rpc('verify_chain', { p_account_id: accountId });
  if (error) {
    return {
      ok: false,
      message: `audit chain check FAILED to run: ${error.message}`,
      broken_at: null,
      broken_event_no: null,
    };
  }
  const row = (Array.isArray(data) ? data[0] : data) as {
    ok: boolean;
    broken_at: string | null;
    broken_event_no: number | null;
    reason: string | null;
  } | null;
  if (!row) {
    return {
      ok: true,
      message: 'audit chain verified intact (no events recorded for this account)',
      broken_at: null,
      broken_event_no: null,
    };
  }
  if (row.ok) {
    return {
      ok: true,
      message: 'audit chain verified intact (every event hash chains correctly)',
      broken_at: null,
      broken_event_no: null,
    };
  }
  return {
    ok: false,
    message: `AUDIT CHAIN BROKEN at event #${row.broken_event_no} (id ${row.broken_at}): ${row.reason ?? 'unknown'}`,
    broken_at: row.broken_at,
    broken_event_no: row.broken_event_no,
  };
}

// ---- data loader ------------------------------------------------------------

interface AttachmentRow {
  id: string;
  entity_type: string;
  entity_id: string;
  storage_path: string;
  content_hash: string;
  mime_type: string | null;
  size_bytes: number | null;
  uploaded_by: string | null;
  derived_from: string | null;
  received_at: string;
}

interface ExportData {
  account_name: string;
  tenancy: Record<string, unknown> | null;
  area: Record<string, unknown> | null;
  property: Record<string, unknown> | null;
  occupants: Array<Record<string, unknown>>;
  leases: Array<Record<string, unknown>>;
  rentSchedules: Array<Record<string, unknown>>;
  charges: Array<Record<string, unknown>>;
  payments: Array<Record<string, unknown>>;
  allocations: Array<Record<string, unknown>>;
  interactions: Array<Record<string, unknown>>;
  maintenanceRequests: Array<Record<string, unknown>>;
  workOrders: Array<Record<string, unknown>>;
  inspections: Array<Record<string, unknown>>;
  inspectionItems: Array<Record<string, unknown>>;
  inspectionChecks: Array<Record<string, unknown>>;
  notices: Array<Record<string, unknown>>;
  attachments: AttachmentRow[];
  events: Array<Record<string, unknown>>;
  uploaderNames: Map<string, string>;
  intakeTokenById: Map<string, string>;
  /** Resolved counterparty names for the interactions render: party_id -> name
   *  (tenant full_name / vendor name). party_id has no FK, so this is built by
   *  looking ids up by type; party_label and 'unspecified' are render-time. */
  partyNames: Map<string, string>;
  /** The cast (interaction_participants) per journal row: who was on the
   *  event, one entry per person-per-role, frozen at write time. The legal
   *  artifact renders the FULL cast — a group message names every recipient
   *  as a person, not a comma-string of addresses. */
  castByInteraction: Map<string, CastRow[]>;
  /** Outbound proof handle: the (non-relay) outbox row's delivery state per
   *  journal row. Rendered so the artifact never overclaims — 'sent' means
   *  the provider ACCEPTED the message; only 'delivered' means a delivery
   *  receipt arrived. */
  deliveryByInteraction: Map<string, { status: string; delivered_at: string | null }>;
  /** Inbound proof handle: inbound_provenance.body_sha256 keyed by
   *  provider_msg_id (== the journal row's external_ref). The hash the
   *  archived signed webhook can be re-verified against (EV-B). */
  provenanceShaByMsgId: Map<string, string>;
}

/** One cast entry as loaded for the export render. */
export interface CastRow {
  interaction_id: string;
  role: string;
  party_type: string;
  party_id: string | null;
  address: string | null;
  label: string | null;
  source: string;
}

// A correction chain is one event: the original entry plus the append-only
// corrections/retractions that supersede it (interactions.corrects_id).
// The export is the legal artifact -- it must always carry COMPLETE chains,
// never the collapsed latest-only view, and never a chain split by a scope
// filter. The date window applies to where a chain APPEARS on the timeline
// (its root), not to which of its members are shown.
//
// completeInteractionChains: the windowed/tenancy-filtered fetch can miss
// chain members (an amend re-dated outside the window, or re-linked to
// another tenancy). Walk corrects_id links both ways until closure; chains
// are short, so this is 0-2 extra queries in practice.
async function completeInteractionChains(
  admin: ReturnType<typeof getAdminClient>,
  accountId: string,
  rows: Record<string, unknown>[],
): Promise<Record<string, unknown>[]> {
  if (rows.length === 0) return rows;
  const have = new Map(rows.map((r) => [String(r.id), r]));
  for (;;) {
    const ids = [...have.keys()];
    const missingParents = [...have.values()]
      .map((r) => (r.corrects_id ? String(r.corrects_id) : null))
      .filter((x): x is string => x !== null && !have.has(x));
    const [childRes, parentRes] = await Promise.all([
      admin.from('interactions').select('*').eq('account_id', accountId).in('corrects_id', ids),
      missingParents.length > 0
        ? admin.from('interactions').select('*').eq('account_id', accountId).in('id', missingParents)
        : Promise.resolve({ data: [] as Record<string, unknown>[], error: null }),
    ]);
    const found = [
      ...((childRes.data as Record<string, unknown>[]) ?? []),
      ...((parentRes.data as Record<string, unknown>[]) ?? []),
    ].filter((r) => !have.has(String(r.id)));
    if (found.length === 0) return [...have.values()];
    for (const r of found) have.set(String(r.id), r);
  }
}

export interface InteractionChain {
  root: Record<string, unknown>;
  /** Chain order: oldest correction first; the last entry is the head. */
  corrections: Record<string, unknown>[];
}

// Pure chain grouping for the renderer (and its tests -- PDFKit output is
// not string-greppable, so THIS is the seam where "the export renders full
// chains" is asserted). Roots are ordered by occurred_at like the flat list
// was; a correction whose original fell outside the data set entirely is
// kept as a root rather than dropped -- the export never hides an entry.
export function groupInteractionChains(rows: Record<string, unknown>[]): InteractionChain[] {
  const ids = new Set(rows.map((r) => String(r.id)));
  const byCorrects = new Map(rows.filter((r) => r.corrects_id).map((r) => [String(r.corrects_id), r]));
  const roots = rows.filter((r) => !r.corrects_id || !ids.has(String(r.corrects_id)));
  roots.sort(
    (a, b) =>
      String(a.occurred_at).localeCompare(String(b.occurred_at)) ||
      String(a.id).localeCompare(String(b.id)),
  );
  return roots.map((root) => {
    const corrections: Record<string, unknown>[] = [];
    let cur = byCorrects.get(String(root.id));
    while (cur) {
      corrections.push(cur);
      cur = byCorrects.get(String(cur.id));
    }
    return { root, corrections };
  });
}

// Exported for the export test suite: the PDF binary is not string-greppable
// (PDFKit hex-encodes text), so "the export carries complete chains" is
// asserted against THIS -- the exact data set the renderer consumes.
// Human-facing counterparty for an interaction row in the export. Resolves
// party_id to a name (tenant full_name / vendor name) via partyNames; falls
// back to the free-text party_label, then the party_type itself ('unspecified'
// for a role-unknown capture). Empty for notes/agent_events (party_type 'none').
// Exported for unit testing (mirrors groupInteractionChains).
export function interactionPartyDisplay(
  row: Record<string, unknown>,
  partyNames: Map<string, string>,
): string {
  const pt = (row.party_type as string) ?? '';
  if (pt === '' || pt === 'none') return '';
  const id = row.party_id as string | null;
  const resolved = id ? partyNames.get(id) : undefined;
  if (resolved) return `${resolved} (${pt})`;
  const label = row.party_label as string | null;
  if (label) return `${label} (${pt})`;
  return pt;
}

// Human-facing cast line for an interaction row in the export: the full
// participants list grouped by role — every person a group message reached,
// named. Name resolution per entry: frozen label snapshot, else partyNames,
// else the wire address, else the party_type. Platform entries (our own
// number / reply token — wire plumbing, not people) render as "via <addr>".
// Exported for unit testing (mirrors interactionPartyDisplay).
export function interactionCastDisplay(
  cast: CastRow[],
  partyNames: Map<string, string>,
): string {
  if (cast.length === 0) return '';
  const name = (p: CastRow): string => {
    const resolved = p.label ?? (p.party_id ? partyNames.get(p.party_id) : undefined);
    if (resolved && p.address) return `${resolved} (${p.address})`;
    return resolved ?? p.address ?? p.party_type;
  };
  const parts: string[] = [];
  const byRole = (role: string) => cast.filter((p) => p.role === role && p.party_type !== 'platform');
  const via = cast.filter((p) => p.party_type === 'platform' && p.address);
  const senders = byRole('sender');
  const recipients = byRole('recipient');
  const ccs = byRole('cc');
  const attendees = byRole('attendee');
  if (senders.length > 0) parts.push(`from ${senders.map(name).join(', ')}`);
  if (recipients.length > 0) parts.push(`to ${recipients.map(name).join(', ')}`);
  if (ccs.length > 0) parts.push(`cc ${ccs.map(name).join(', ')}`);
  if (attendees.length > 0) parts.push(`attendees ${attendees.map(name).join(', ')}`);
  if (via.length > 0) parts.push(`via ${via.map((p) => p.address as string).join(', ')}`);
  return parts.join(' · ');
}

export async function loadExportData(scope: ExportScope): Promise<ExportData> {
  const admin = getAdminClient();

  const acct = await admin.from('accounts').select('name').eq('id', scope.accountId).single();
  const accountName = (acct.data as { name?: string } | null)?.name ?? scope.accountId;

  // Tenancy / area / property -- DO NOT filter deleted_at. Disputes
  // happen AFTER tenancies end; the export must still find them.
  let tenancy: Record<string, unknown> | null = null;
  let area: Record<string, unknown> | null = null;
  let property: Record<string, unknown> | null = null;
  if (scope.tenancyId) {
    const t = await admin
      .from('tenancies')
      .select('*')
      .eq('account_id', scope.accountId)
      .eq('id', scope.tenancyId)
      .maybeSingle();
    tenancy = t.data as Record<string, unknown> | null;
  }
  const areaId = scope.areaId ?? (tenancy?.area_id as string | undefined);
  if (areaId) {
    const a = await admin.from('areas').select('*').eq('account_id', scope.accountId).eq('id', areaId).maybeSingle();
    area = a.data as Record<string, unknown> | null;
  }
  const propertyId = area?.property_id as string | undefined;
  if (propertyId) {
    const p = await admin.from('properties').select('*').eq('account_id', scope.accountId).eq('id', propertyId).maybeSingle();
    property = p.data as Record<string, unknown> | null;
  }

  // Tenancy-scoped rows.
  const tenancyId = scope.tenancyId ?? null;

  // Date-range narrowing (Phase 11 flag B): the filter applies ONLY to
  // activity sections. Standing context -- leases, occupants, rent
  // schedules -- always loads fully; balances depend on
  // pre-range history (charges + allocations) so we load those whole
  // too and the renderer derives an "opening balance as of from_date"
  // line. Hard date-cuts on ledger queries would silently drop the
  // governing context a dispute usually turns on.
  const [occRes, leaseRes, schedRes, chargeRes, payRes] = await Promise.all([
    tenancyId
      ? admin.from('tenancy_tenants').select('*, tenants(*)').eq('account_id', scope.accountId).eq('tenancy_id', tenancyId)
      : Promise.resolve({ data: [] as Record<string, unknown>[], error: null }),
    tenancyId
      ? admin.from('leases').select('*').eq('account_id', scope.accountId).eq('tenancy_id', tenancyId)
      : Promise.resolve({ data: [] as Record<string, unknown>[], error: null }),
    tenancyId
      ? admin.from('rent_schedules').select('*').eq('account_id', scope.accountId).eq('tenancy_id', tenancyId)
      : Promise.resolve({ data: [] as Record<string, unknown>[], error: null }),
    tenancyId
      ? admin.from('charges').select('*').eq('account_id', scope.accountId).eq('tenancy_id', tenancyId)
      : Promise.resolve({ data: [] as Record<string, unknown>[], error: null }),
    tenancyId
      ? admin.from('payments').select('*').eq('account_id', scope.accountId).eq('tenancy_id', tenancyId)
      : Promise.resolve({ data: [] as Record<string, unknown>[], error: null }),
  ]);
  const fromDate = scope.fromDate ?? null;
  const toDate = scope.toDate ?? null;
  const occupants: Record<string, unknown>[] = (occRes.data as Record<string, unknown>[]) ?? [];
  const leases: Record<string, unknown>[] = (leaseRes.data as Record<string, unknown>[]) ?? [];
  const rentSchedules: Record<string, unknown>[] = (schedRes.data as Record<string, unknown>[]) ?? [];
  const charges: Record<string, unknown>[] = (chargeRes.data as Record<string, unknown>[]) ?? [];
  const payments: Record<string, unknown>[] = (payRes.data as Record<string, unknown>[]) ?? [];
  const allocations: Record<string, unknown>[] = [];
  const chargeIds = charges.map((c) => c.id).filter((id): id is string => typeof id === 'string');
  for (let i = 0; i < chargeIds.length; i += 200) {
    const allocRes = await admin
      .from('payment_allocations')
      .select('*')
      .eq('account_id', scope.accountId)
      .in('charge_id', chargeIds.slice(i, i + 200))
      .is('deleted_at', null);
    if (allocRes.error) throw new Error(`payment_allocations query failed: ${allocRes.error.message}`);
    allocations.push(...((allocRes.data as Record<string, unknown>[]) ?? []));
  }

  // Area-scoped rows.
  let interactions: Record<string, unknown>[] = [];
  let maintenanceRequests: Record<string, unknown>[] = [];
  let workOrders: Record<string, unknown>[] = [];
  let inspections: Record<string, unknown>[] = [];
  let inspectionItems: Record<string, unknown>[] = [];
  let inspectionChecks: Record<string, unknown>[] = [];
  let notices: Record<string, unknown>[] = [];

  if (tenancyId || areaId) {
    let intQ = admin.from('interactions').select('*').eq('account_id', scope.accountId);
    if (tenancyId) intQ = intQ.eq('tenancy_id', tenancyId);
    if (fromDate)  intQ = intQ.gte('occurred_at', fromDate);
    if (toDate)    intQ = intQ.lte('occurred_at', `${toDate}T23:59:59Z`);
    const intRes = await intQ;
    interactions = (intRes.data as Record<string, unknown>[]) ?? [];
    // Never render a partial correction chain (see completeInteractionChains).
    interactions = await completeInteractionChains(admin, scope.accountId, interactions);
  }
  if (areaId) {
    const [mr, ins] = await Promise.all([
      admin.from('maintenance_requests').select('*').eq('account_id', scope.accountId).eq('area_id', areaId),
      admin.from('inspections').select('*').eq('account_id', scope.accountId).eq('area_id', areaId),
    ]);
    maintenanceRequests = (mr.data as Record<string, unknown>[]) ?? [];
    inspections = (ins.data as Record<string, unknown>[]) ?? [];

    if (maintenanceRequests.length > 0) {
      const ids = maintenanceRequests.map((r) => r.id as string);
      const wo = await admin
        .from('work_orders').select('*')
        .eq('account_id', scope.accountId)
        .in('maintenance_request_id', ids);
      workOrders = (wo.data as Record<string, unknown>[]) ?? [];
    }
    if (inspections.length > 0) {
      const ids = inspections.map((r) => r.id as string);
      const [items, checks] = await Promise.all([
        admin.from('inspection_items').select('*').eq('account_id', scope.accountId).in('inspection_id', ids),
        admin.from('inspection_checks').select('*').eq('account_id', scope.accountId).in('inspection_id', ids),
      ]);
      inspectionItems = (items.data as Record<string, unknown>[]) ?? [];
      inspectionChecks = (checks.data as Record<string, unknown>[]) ?? [];
    }
  }
  if (tenancyId) {
    const n = await admin.from('notices').select('*').eq('account_id', scope.accountId).eq('tenancy_id', tenancyId);
    notices = (n.data as Record<string, unknown>[]) ?? [];
  }

  // All attachments tied to any in-scope entity.
  const entityIds: string[] = [];
  for (const r of maintenanceRequests) entityIds.push(r.id as string);
  for (const r of inspections) entityIds.push(r.id as string);
  for (const r of interactions) entityIds.push(r.id as string);
  const ATTACHMENT_COLS =
    'id, entity_type, entity_id, storage_path, content_hash, mime_type, size_bytes, uploaded_by, derived_from, received_at';
  let attachments: AttachmentRow[] = [];
  if (entityIds.length > 0) {
    const a = await admin
      .from('attachments')
      .select(ATTACHMENT_COLS)
      .eq('account_id', scope.accountId)
      .in('entity_id', entityIds)
      .is('deleted_at', null);
    attachments = (a.data as AttachmentRow[]) ?? [];
  }
  // Condition-report item photos attach at entity_type='inspection_items' keyed
  // by item id. Fetch them separately + CHUNKED -- a full move-in form can have
  // 100+ items, and folding all item ids into the shared id list above would
  // blow the IN() query (and the events scope). Each item's chain-of-custody
  // then renders in the Photos section like any other source photo.
  if (inspectionItems.length > 0) {
    const itemIds = inspectionItems.map((r) => r.id as string);
    const CHUNK = 100;
    for (let i = 0; i < itemIds.length; i += CHUNK) {
      const ip = await admin
        .from('attachments')
        .select(ATTACHMENT_COLS)
        .eq('account_id', scope.accountId)
        .eq('entity_type', 'inspection_items')
        .in('entity_id', itemIds.slice(i, i + CHUNK))
        .is('deleted_at', null);
      if (ip.error) throw new Error(`item-photo load failed: ${ip.error.message}`);
      attachments.push(...((ip.data as AttachmentRow[]) ?? []));
    }
  }

  // Audit events for everything in scope.
  let events: Record<string, unknown>[] = [];
  const eventEntityIds = new Set<string>(entityIds);
  if (tenancyId) eventEntityIds.add(tenancyId);
  if (areaId) eventEntityIds.add(areaId);
  for (const r of charges) eventEntityIds.add(r.id as string);
  for (const r of payments) eventEntityIds.add(r.id as string);
  for (const r of notices) eventEntityIds.add(r.id as string);
  for (const r of leases) eventEntityIds.add(r.id as string);
  for (const r of workOrders) eventEntityIds.add(r.id as string);
  if (eventEntityIds.size > 0) {
    const e = await admin
      .from('events')
      .select('id, account_id, actor, entity_type, entity_id, event_type, occurred_at, account_seq')
      .eq('account_id', scope.accountId)
      .in('entity_id', Array.from(eventEntityIds))
      .order('account_seq', { ascending: true });
    events = (e.data as Record<string, unknown>[]) ?? [];
  }

  // Resolve uploader display names for chain-of-custody.
  const uploaderIds = new Set<string>();
  for (const att of attachments) {
    if (att.uploaded_by) uploaderIds.add(att.uploaded_by);
  }
  const uploaderNames = new Map<string, string>();
  if (uploaderIds.size > 0) {
    const u = await admin.from('users').select('id, display_name').in('id', Array.from(uploaderIds));
    for (const row of (u.data as Array<{ id: string; display_name: string | null }>) ?? []) {
      uploaderNames.set(row.id, row.display_name ?? row.id);
    }
  }
  // For intake-uploaded photos, uploaded_by is null but the audit event
  // captures actor='tenant:<token_id>'. Build a map: attachment.id -> token id.
  const intakeTokenById = new Map<string, string>();
  for (const ev of events) {
    if (ev.entity_type === 'attachments' && ev.event_type === 'inserted') {
      const actor = ev.actor as string;
      if (actor && actor.startsWith('tenant:')) {
        intakeTokenById.set(ev.entity_id as string, actor.slice('tenant:'.length));
      }
    }
  }

  // Resolve counterparties for the interactions render: party_id -> name.
  // party_id has no FK (it is a typed reference), so collect the referenced ids
  // and look them up in tenants/vendors. party_label and the 'unspecified'
  // sentinel are handled at render time (interactionPartyDisplay).
  const partyNames = new Map<string, string>();
  for (const o of occupants) {
    const t = (o as { tenants?: { id?: string; full_name?: string } }).tenants;
    if (t?.id && t.full_name) partyNames.set(t.id, t.full_name);
  }
  const partyIds = new Set<string>();
  for (const r of interactions) {
    if ((r.party_type === 'tenant' || r.party_type === 'vendor') && r.party_id) {
      partyIds.add(String(r.party_id));
    }
    if (r.vendor_id) partyIds.add(String(r.vendor_id));
  }
  for (const id of partyNames.keys()) partyIds.delete(id);
  if (partyIds.size > 0) {
    const ids = [...partyIds];
    const [tRes, vRes] = await Promise.all([
      admin.from('tenants').select('id, full_name').eq('account_id', scope.accountId).in('id', ids),
      admin.from('vendors').select('id, name').eq('account_id', scope.accountId).in('id', ids),
    ]);
    for (const t of ((tRes.data as { id: string; full_name: string }[] | null) ?? [])) partyNames.set(t.id, t.full_name);
    for (const v of ((vRes.data as { id: string; name: string }[] | null) ?? [])) partyNames.set(v.id, v.name);
  }

  // The cast per journal row (interaction_participants). Loaded for every
  // in-scope interaction so the artifact names all recipients of a group
  // message and all attendees of an in-person contact.
  const castByInteraction = new Map<string, CastRow[]>();
  if (interactions.length > 0) {
    const castRes = await admin
      .from('interaction_participants')
      .select('interaction_id, role, party_type, party_id, address, label, source')
      .eq('account_id', scope.accountId)
      .in('interaction_id', interactions.map((r) => String(r.id)))
      .order('created_at', { ascending: true });
    for (const p of ((castRes.data as CastRow[] | null) ?? [])) {
      const list = castByInteraction.get(p.interaction_id) ?? [];
      list.push(p);
      castByInteraction.set(p.interaction_id, list);
    }
  }

  // Proof handles: outbound delivery state (accepted ≠ delivered) and the
  // inbound provenance hash, so a provider_verified entry renders alongside
  // the evidence it can be checked against.
  const deliveryByInteraction = new Map<string, { status: string; delivered_at: string | null }>();
  const provenanceShaByMsgId = new Map<string, string>();
  if (interactions.length > 0) {
    const ids = interactions.map((r) => String(r.id));
    const msgIds = interactions
      .map((r) => r.external_ref)
      .filter((x): x is string => typeof x === 'string' && x.length > 0);
    const [obRes, provRes] = await Promise.all([
      admin
        .from('comm_outbox')
        .select('interaction_id, status, delivered_at')
        .eq('account_id', scope.accountId)
        .is('relay_of_interaction_id', null)
        .in('interaction_id', ids),
      msgIds.length > 0
        ? admin
            .from('inbound_provenance')
            .select('provider_msg_id, body_sha256')
            .eq('account_id', scope.accountId)
            .in('provider_msg_id', msgIds)
        : Promise.resolve({ data: [] as { provider_msg_id: string; body_sha256: string }[], error: null }),
    ]);
    for (const o of ((obRes.data as { interaction_id: string | null; status: string; delivered_at: string | null }[] | null) ?? [])) {
      if (o.interaction_id) deliveryByInteraction.set(o.interaction_id, { status: o.status, delivered_at: o.delivered_at });
    }
    for (const p of ((provRes.data as { provider_msg_id: string; body_sha256: string }[] | null) ?? [])) {
      provenanceShaByMsgId.set(p.provider_msg_id, p.body_sha256);
    }
  }

  return {
    account_name: accountName,
    tenancy,
    area,
    property,
    occupants,
    leases,
    rentSchedules,
    charges,
    payments,
    allocations,
    interactions,
    maintenanceRequests,
    workOrders,
    inspections,
    inspectionItems,
    inspectionChecks,
    notices,
    attachments,
    events,
    uploaderNames,
    intakeTokenById,
    partyNames,
    castByInteraction,
    deliveryByInteraction,
    provenanceShaByMsgId,
  };
}

// ---- ledger derivation ------------------------------------------------------

interface DerivedLedger {
  // Standing context (Phase 11 flag B): opening_balance is what's owed
  // entering the date range. With no from_date, opening_balance is 0
  // and rent_charges_in_range / rent_payments_in_range are the totals.
  opening_balance_cents: number;
  rent_charges_in_range_cents: number;
  rent_payments_in_range_cents: number;
  // Closing balance = opening + in-range charges - in-range payments.
  // This is the "balance you'd see if you looked just at the slice."
  closing_balance_cents: number;
  // Whole-history (deposits + unapplied credit don't care about the slice
  // -- a deposit was either taken or wasn't; an unapplied credit is real
  // money regardless of when it landed).
  deposit_charges_cents: number;
  deposit_payments_cents: number;
  unapplied_credit_cents: number;
  // The dates used; surfaced so the renderer can label the opening line.
  from_date: string | null;
  to_date: string | null;
  currency: string | null;
}

function inRangeISO(iso: string | null | undefined, from: string | null, to: string | null): boolean {
  if (!iso) return false;
  // Compare lexically. Postgres dates render as YYYY-MM-DD; timestamps
  // render as YYYY-MM-DD... -- both compare correctly against ISO date
  // bounds at the prefix.
  if (from && iso < from) return false;
  if (to && iso > `${to}T23:59:59Z`) return false;
  return true;
}

function deriveLedger(data: ExportData, from: string | null, to: string | null): DerivedLedger {
  const chargeIds = new Set(data.charges.map((c) => c.id as string));
  const paymentIds = new Set(data.payments.map((p) => p.id as string));
  const voidedCharges = new Set(data.charges.filter((c) => c.voided_at).map((c) => c.id as string));
  const voidedPayments = new Set(data.payments.filter((p) => p.voided_at).map((p) => p.id as string));
  const tenancyAllocs = data.allocations.filter(
    (a) => chargeIds.has(a.charge_id as string) && paymentIds.has(a.payment_id as string),
  );

  // ---- whole-history aggregates (deposit + unapplied credit) -------------
  let depositChargesC = 0, depositPaymentsC = 0;
  for (const cr of data.charges) {
    if (cr.voided_at) continue;
    if (cr.type === 'deposit') depositChargesC += cr.amount_cents as number;
  }
  let totalAllocatedC = 0;
  for (const a of tenancyAllocs) {
    if (voidedPayments.has(a.payment_id as string)) continue;
    if (voidedCharges.has(a.charge_id as string)) continue;
    totalAllocatedC += a.amount_cents as number;
    const isDeposit = data.charges.find((c) => c.id === a.charge_id)?.type === 'deposit';
    if (isDeposit) depositPaymentsC += a.amount_cents as number;
  }
  let totalReceivedC = 0;
  for (const pr of data.payments) {
    if (pr.voided_at) continue;
    totalReceivedC += pr.amount_cents as number;
  }
  const unappliedCredit = Math.max(0, totalReceivedC - totalAllocatedC);

  // ---- opening balance + in-range slice ----------------------------------
  // Opening balance = rent charges due strictly BEFORE from_date minus the
  // RENT-charge-allocated portion of payments received before from_date.
  // (Deposit charges don't roll into the rent balance.)
  const isRentCharge = (id: string) =>
    data.charges.find((c) => c.id === id)?.type !== 'deposit'
    && !voidedCharges.has(id);

  let openingChargedC = 0;
  for (const cr of data.charges) {
    if (cr.voided_at) continue;
    if (cr.type === 'deposit') continue;
    if (from && (cr.due_date as string) < from) {
      openingChargedC += cr.amount_cents as number;
    }
  }
  let openingPaidC = 0;
  for (const a of tenancyAllocs) {
    const pay = data.payments.find((p) => p.id === a.payment_id);
    if (!pay) continue;
    if (pay.voided_at) continue;
    if (!isRentCharge(a.charge_id as string)) continue;
    if (from && (pay.received_at as string) < from) {
      openingPaidC += a.amount_cents as number;
    }
  }
  const openingBalanceC = from ? (openingChargedC - openingPaidC) : 0;

  let inRangeChargesC = 0;
  for (const cr of data.charges) {
    if (cr.voided_at) continue;
    if (cr.type === 'deposit') continue;
    const dd = cr.due_date as string;
    // due_date is a YYYY-MM-DD; treat the range bounds the same way.
    if (from && dd < from) continue;
    if (to && dd > to) continue;
    inRangeChargesC += cr.amount_cents as number;
  }
  let inRangePaymentsC = 0;
  for (const a of tenancyAllocs) {
    const pay = data.payments.find((p) => p.id === a.payment_id);
    if (!pay) continue;
    if (pay.voided_at) continue;
    if (!isRentCharge(a.charge_id as string)) continue;
    if (!inRangeISO(pay.received_at as string, from, to)) continue;
    inRangePaymentsC += a.amount_cents as number;
  }
  const closingBalanceC = openingBalanceC + inRangeChargesC - inRangePaymentsC;

  const currency =
    (data.charges[0]?.currency as string | undefined) ??
    (data.payments[0]?.currency as string | undefined) ??
    null;

  return {
    opening_balance_cents:        openingBalanceC,
    rent_charges_in_range_cents:  inRangeChargesC,
    rent_payments_in_range_cents: inRangePaymentsC,
    closing_balance_cents:        closingBalanceC,
    deposit_charges_cents:        depositChargesC,
    deposit_payments_cents:       depositPaymentsC,
    unapplied_credit_cents:       unappliedCredit,
    from_date:                    from,
    to_date:                      to,
    currency,
  };
}

// ---- PDF rendering ----------------------------------------------------------

interface RenderInput {
  scope: ExportScope;
  generatedAt: Date;
  chain: ChainStatus;
  data: ExportData;
}

function fmtMoney(cents: number, currency: string | null): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${(abs / 100).toFixed(2)} ${currency ?? ''}`.trim();
}

async function renderExportPdf(input: RenderInput): Promise<Uint8Array> {
  const { scope, generatedAt, chain, data } = input;
  const fromDate = scope.fromDate ?? null;
  const toDate = scope.toDate ?? null;
  const ledger = deriveLedger(data, fromDate, toDate);

  // PDF info dict + file id derived from (scope, generatedAt) so each
  // export has a stable identity within its own bytes. Unlike the inspection
  // report we do NOT pin info to a fixed timestamp -- two exports differ
  // (that's the point: snapshot at THIS generation).
  const fileIdSeed = createHash('sha256')
    .update(`${scope.accountId}|${scope.tenancyId ?? ''}|${scope.areaId ?? ''}|${generatedAt.toISOString()}`)
    .digest();
  const fileId = [fileIdSeed.subarray(0, 16), fileIdSeed.subarray(16, 32)];

  const doc = new PDFDocument({
    autoFirstPage: false,
    // compress: false makes the content streams human-readable in the
    // PDF. The bundle gets a bit larger but stays well under the
    // generated-artifact cap. The real reason: forensic readability --
    // a litigant who needs to grep the PDF for a specific hash should be
    // able to do that without a special tool.
    compress: false,
    info: {
      Title: `Evidence Export — ${data.account_name}`,
      Author: 'rentalcrm',
      Producer: 'rentalcrm',
      Creator: 'rentalcrm',
      CreationDate: generatedAt,
      ModDate: generatedAt,
    },
  });
  (doc as unknown as { _id: Buffer[] })._id = fileId;

  const chunks: Buffer[] = [];
  doc.on('data', (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<void>((resolve, reject) => {
    doc.on('end', () => resolve());
    doc.on('error', (e) => reject(e));
  });

  doc.addPage({ size: 'LETTER', margin: 54 });
  doc.font('Helvetica');

  // ----- Title + scope ------------------------------------------------------
  doc.fontSize(20).text('Evidence Export', { align: 'left' });
  doc.moveDown(0.3);
  doc.fontSize(11).fillColor('#333');
  doc.text(`Account:       ${data.account_name} (${scope.accountId})`);
  if (data.property) doc.text(`Property:      ${data.property.name as string ?? ''}`);
  if (data.area)     doc.text(`Area:          ${data.area.name as string ?? ''} (${data.area.kind as string ?? ''})`);
  if (data.tenancy) {
    doc.text(`Tenancy:       ${data.tenancy.id as string}`);
    doc.text(`Tenancy span:  ${data.tenancy.start_date as string} → ${(data.tenancy.end_date as string) ?? 'open'}`);
    doc.text(`Tenancy state: ${data.tenancy.status as string}${data.tenancy.deleted_at ? ' (soft-deleted)' : ''}`);
  }
  if (scope.fromDate || scope.toDate) {
    doc.text(`Date range:    ${scope.fromDate ?? '∞'} → ${scope.toDate ?? '∞'}`);
  }
  doc.text(`Generated at:  ${generatedAt.toISOString()}`);
  if (scope.exporter) doc.text(`Exported by:   user:${scope.exporter}`);
  doc.fillColor('#000');

  // ----- Chain verification banner -----------------------------------------
  doc.moveDown(1);
  const banner = chain.ok
    ? { bg: '#e6f4ea', fg: '#1e5a2c', label: 'AUDIT CHAIN VERIFIED INTACT' }
    : { bg: '#fbe9e7', fg: '#a02810', label: 'AUDIT CHAIN BROKEN — TAMPER SUSPECTED' };
  const bannerY = doc.y;
  doc.save();
  doc.rect(54, bannerY, 504, 44).fill(banner.bg);
  doc.restore();
  doc.fillColor(banner.fg).fontSize(13)
    .text(banner.label, 60, bannerY + 6, { width: 492 });
  doc.fontSize(9).text(chain.message, 60, bannerY + 24, { width: 492 });
  doc.fillColor('#000').y = bannerY + 50;

  // ----- Lease(s) -----------------------------------------------------------
  section(doc, 'Lease(s)');
  if (data.leases.length === 0) {
    italicNote(doc, '(no leases recorded for this tenancy)');
  } else {
    for (const ls of data.leases) {
      doc.fontSize(10).text(
        `• ${ls.status as string}   ${ls.term_start as string} → ${(ls.term_end as string) ?? 'open'}` +
        `   rent ${fmtMoney(ls.rent_amount_cents as number, ls.rent_currency as string)}` +
        (ls.deposit_amount_cents ? `   deposit ${fmtMoney(ls.deposit_amount_cents as number, (ls.deposit_currency as string) ?? (ls.rent_currency as string))}` : ''),
      );
    }
  }

  // ----- Occupants ----------------------------------------------------------
  section(doc, 'Occupants');
  if (data.occupants.length === 0) {
    italicNote(doc, '(no occupants on file)');
  } else {
    for (const o of data.occupants) {
      const t = (o as { tenants?: { full_name: string } }).tenants;
      doc.fontSize(10).text(
        `• ${t?.full_name ?? '(no name)'}   role=${o.role as string}`,
      );
    }
  }

  // ----- Rent ledger --------------------------------------------------------
  section(doc, 'Rent ledger');
  doc.fontSize(11);
  if (fromDate) {
    // Phase 11 flag B: the opening balance is the carried-in debt at the
    // start of the date range. Without it, a narrowed-range bundle would
    // misstate the actual obligation.
    doc.text(`Opening balance as of ${fromDate}:  ${fmtMoney(ledger.opening_balance_cents, ledger.currency)}` +
             (ledger.opening_balance_cents > 0 ? '  (carried in)' : ''));
  }
  doc.text(`Rent charged${fromDate || toDate ? ' (in range)' : ''}:  ${fmtMoney(ledger.rent_charges_in_range_cents, ledger.currency)}`);
  doc.text(`Rent paid${fromDate || toDate ? ' (in range)' : ''}:     ${fmtMoney(ledger.rent_payments_in_range_cents, ledger.currency)}`);
  doc.text(`Closing balance${fromDate ? ` as of ${toDate ?? 'now'}` : ''}:  ${fmtMoney(ledger.closing_balance_cents, ledger.currency)}` +
           (ledger.closing_balance_cents > 0 ? '  (owed by tenant)' : ledger.closing_balance_cents < 0 ? '  (overpaid)' : ''));
  doc.text(`Deposit held:   ${fmtMoney(ledger.deposit_payments_cents, ledger.currency)}` +
           ` / charged ${fmtMoney(ledger.deposit_charges_cents, ledger.currency)}`);
  if (ledger.unapplied_credit_cents > 0) {
    doc.fillColor('#7a1e1e').text(
      `Unapplied credit: ${fmtMoney(ledger.unapplied_credit_cents, ledger.currency)}  (money received but not allocated -- may be owed back)`,
    ).fillColor('#000');
  }

  // Charge / payment listings: in-range only when a range is set. Charges
  // BEFORE the range that are still open contribute via the opening
  // balance above (their detail is intentionally suppressed -- the goal
  // of a date-narrowed bundle is to spotlight activity, with carry-in
  // summarised). We always include voided rows so a litigant sees that
  // the void happened (not just the absence).
  const isInRangeCharge = (due: string) =>
    (!fromDate || due >= fromDate) && (!toDate || due <= toDate);
  const isInRangePayment = (received: string) => inRangeISO(received, fromDate, toDate);

  doc.moveDown(0.3);
  doc.fontSize(9).fillColor('#333');
  doc.text(`Charges${fromDate || toDate ? ' (in range)' : ''}:`);
  const chargesSorted = [...data.charges].sort((a, b) => String(a.due_date).localeCompare(String(b.due_date)));
  let renderedCharges = 0;
  for (const cr of chargesSorted) {
    if (!isInRangeCharge(cr.due_date as string)) continue;
    const v = cr.voided_at ? ' [VOID]' : '';
    doc.text(`  ${cr.due_date as string}  ${(cr.type as string).padEnd(10)}  ${fmtMoney(cr.amount_cents as number, cr.currency as string)}${v}`);
    renderedCharges += 1;
  }
  if (renderedCharges === 0) doc.text('  (none in range)');

  doc.moveDown(0.3);
  doc.text(`Payments + allocations${fromDate || toDate ? ' (in range)' : ''}:`);
  const paymentsSorted = [...data.payments].sort((a, b) => String(a.received_at).localeCompare(String(b.received_at)));
  let renderedPayments = 0;
  for (const pr of paymentsSorted) {
    if (!isInRangePayment(pr.received_at as string)) continue;
    const v = pr.voided_at ? ' [VOID]' : '';
    doc.text(`  ${pr.received_at as string}  via ${pr.method as string}  ${fmtMoney(pr.amount_cents as number, pr.currency as string)}${v}`);
    const allocs = data.allocations.filter((a) => a.payment_id === pr.id);
    for (const a of allocs) {
      const ch = data.charges.find((c) => c.id === a.charge_id);
      doc.text(`     → ${fmtMoney(a.amount_cents as number, (ch?.currency as string) ?? '')} to charge ${ch?.due_date as string ?? '?'} (${ch?.type as string ?? '?'})`);
    }
    renderedPayments += 1;
  }
  if (renderedPayments === 0) doc.text('  (none in range)');
  doc.fillColor('#000');

  // ----- Interactions -------------------------------------------------------
  // Full chains, ALWAYS: for a corrected entry, the original renders first
  // (its own occurred_at/logged_at/body), then each correction with its own
  // logged_at, labeled Corrected/Retracted. Retracted entries stay visible,
  // withdrawn with their reason. Showing only the latest would make a
  // good-faith correction look like a concealed edit -- completeness is the
  // point of this artifact.
  section(doc, 'Interactions');
  if (data.interactions.length === 0) {
    italicNote(doc, '(no interactions in scope)');
  } else {
    doc.fontSize(9).fillColor('#333');
    for (const chain of groupInteractionChains(data.interactions)) {
      const root = chain.root;
      const what =
        root.kind === 'note'
          ? 'note'.padEnd(19)
          : root.kind === 'agent_event'
            ? `agent:${root.entry_type as string}`.padEnd(19)
            : `${(root.direction as string).padEnd(8)} ${(root.channel as string).padEnd(10)}`;
      // Authorship capacity (post-capacity-migration rows). Agent-authored
      // entries carry the approval trail the chain protects; rendering it is
      // the point of the capacity fields. Legacy rows show actor= alone.
      const capacity = root.author_type
        ? `  capacity=${root.author_type as string}` +
          (root.author_type === 'agent'
            ? `  approved_by=${(root.approved_by as string | null) ?? '—'}  approval_ref=${(root.approval_ref as string | null) ?? '—'}`
            : '')
        : '';
      const sid = root.external_ref ? `  provider_ref=${root.external_ref as string}` : '';
      // Trust tier (EV-A rework): how the record is known. provider_verified
      // = carrier-confirmed transmission (DB-gated); attested = someone's
      // account of an off-platform event; imported = bulk import. Legacy
      // rows (null) render nothing rather than implying a tier.
      const att = root.attestation ? `  attestation=${root.attestation as string}` : '';
      // Never overclaim: 'sent' = provider accepted; only 'delivered' means
      // a delivery receipt arrived. Rendered separately from attestation.
      const delivery = data.deliveryByInteraction.get(String(root.id));
      const deliveryStr = delivery
        ? `  delivery=${delivery.status}${delivery.delivered_at ? ` @ ${delivery.delivered_at}` : ''}`
        : '';
      // Counterparty (PR 2): communications now name who they were with --
      // resolved tenant/vendor name, else party_label, else party_type
      // ('unspecified' for a role-unknown capture). Notes/agent_events: none.
      const party = interactionPartyDisplay(root, data.partyNames);
      doc.text(
        `• ${root.occurred_at as string}  ${what}${party ? `  with ${party}` : ''}  ` +
        `actor=${root.actor as string}${capacity}${sid}${att}${deliveryStr}  (logged ${root.logged_at as string})`,
      );
      // The cast: everyone on this event, by role, as named people. This is
      // where a group message stops reading as a comma-string of numbers.
      const castLine = interactionCastDisplay(
        data.castByInteraction.get(String(root.id)) ?? [],
        data.partyNames,
      );
      if (castLine) doc.text(`    participants: ${castLine}`);
      // Inbound proof handle: the archived signed webhook's hash — what a
      // provider_verified claim can be independently checked against
      // (dispute playbook, docs/comms-evidence.md).
      const proofSha = root.external_ref
        ? data.provenanceShaByMsgId.get(String(root.external_ref))
        : undefined;
      if (proofSha) doc.text(`    proof: signed webhook sha256=${proofSha}`);
      if (root.body) doc.text(`    ${String(root.body).slice(0, 400)}`);
      for (const corr of chain.corrections) {
        // classify completes metadata only -- the body is inherited, unchanged.
        // Labeling it "Corrected: <body>" would mis-state that content changed,
        // so name the attribution it added (resolved counterparty), falling back
        // to a generic note when it completed non-party metadata.
        const classified = interactionPartyDisplay(corr, data.partyNames);
        const label =
          corr.correction_kind === 'retract'
            ? `Retracted: ${String(corr.body ?? '').slice(0, 400)}`
            : corr.correction_kind === 'classify'
              ? `Attribution: ${classified && classified !== 'unspecified' ? classified : 'metadata completed'}`
              : `Corrected: ${String(corr.body ?? '').slice(0, 400)}`;
        const redated =
          corr.occurred_at !== root.occurred_at ? `  occurred ${corr.occurred_at as string}` : '';
        doc.text(
          `    ${label}`,
        );
        doc.fillColor('#666').text(
          `      by ${corr.actor as string}  (logged ${corr.logged_at as string})${redated}`,
        ).fillColor('#333');
      }
    }
    doc.fillColor('#000');
  }

  // ----- Maintenance requests ----------------------------------------------
  section(doc, 'Maintenance requests');
  if (data.maintenanceRequests.length === 0) {
    italicNote(doc, '(no maintenance requests in scope)');
  } else {
    for (const mr of data.maintenanceRequests) {
      doc.fontSize(10).text(
        `• ${mr.created_at as string}  [${mr.severity as string}/${mr.status as string}]  ${mr.title as string}`,
      );
      if (mr.description) doc.fontSize(9).fillColor('#555').text(`    ${String(mr.description).slice(0, 400)}`).fillColor('#000');
      // Status history derived from the events table.
      const hist = data.events.filter((e) => e.entity_type === 'maintenance_requests' && e.entity_id === mr.id);
      for (const h of hist) {
        doc.fontSize(8).fillColor('#666').text(
          `    audit: ${h.occurred_at as string}  ${h.event_type as string}  by ${h.actor as string}`,
        ).fillColor('#000');
      }
      // Work orders for this request.
      const wos = data.workOrders.filter((w) => w.maintenance_request_id === mr.id);
      for (const w of wos) {
        doc.fontSize(9).text(
          `    work-order ${w.created_at as string}  [${w.status as string}]  ${w.summary as string}` +
          (w.cost_cents ? `  cost ${fmtMoney(w.cost_cents as number, (w.cost_currency as string) ?? '')}` : ''),
        );
      }
    }
  }

  // ----- Inspections --------------------------------------------------------
  section(doc, 'Inspections');
  if (data.inspections.length === 0) {
    italicNote(doc, '(no inspections in scope)');
  } else {
    for (const insp of data.inspections) {
      const kind = (insp.kind as string) ?? 'general';
      const stateLabel = insp.completed_at
        ? `COMPLETED ${insp.completed_at as string}`
        : `in progress (${(insp.status as string) ?? 'draft'})`;
      doc.fontSize(10).text(
        `• ${kind}  ${insp.performed_at as string ?? insp.created_at as string}  [${stateLabel}]` +
        (insp.status === 'voided' ? '  [VOIDED]' : '') +
        (insp.baseline_inspection_id
          ? `  (checkout; baseline ${(insp.baseline_inspection_id as string).slice(0, 8)}…)`
          : ''),
      );
      // The frozen, content-hashed report PDF (chain of custody to the bytes
      // the tenant acknowledged). Shown here rather than in Photos.
      const report = data.attachments.find(
        (a) => a.entity_type === 'inspection_report' && a.entity_id === insp.id && a.derived_from === null,
      );
      if (report) {
        doc.fontSize(8).fillColor('#555').text(`    report sha256: ${report.content_hash}`).fillColor('#000');
      }
      const items = data.inspectionItems.filter((it) => it.inspection_id === insp.id);
      for (const it of items) {
        doc.fontSize(9).fillColor('#333').text(
          `    ${it.group_label ? `${it.group_label as string} / ` : ''}${it.label as string}` +
          (it.condition ? `  condition=${it.condition as string}` : '') +
          (it.change_type ? `  change=${it.change_type as string}` : '') +
          (it.notes ? `  notes=${String(it.notes).slice(0, 200)}` : ''),
        ).fillColor('#000');
      }
      const checks = data.inspectionChecks.filter((ck) => ck.inspection_id === insp.id);
      for (const ck of checks) {
        const v =
          ck.value === null || ck.value === undefined
            ? ''
            : typeof ck.value === 'string'
              ? ck.value
              : JSON.stringify(ck.value);
        doc.fontSize(9).fillColor('#333').text(
          `    [check] ${ck.group_label ? `${ck.group_label as string} / ` : ''}${ck.label as string}: ${v}`,
        ).fillColor('#000');
      }
    }
  }

  // ----- Notices ------------------------------------------------------------
  section(doc, 'Notices');
  if (data.notices.length === 0) {
    italicNote(doc, '(no notices in scope)');
  } else {
    for (const n of data.notices) {
      doc.fontSize(10).text(
        `• ${(n.served_at as string) ?? '(not served)'}  ${n.notice_type as string}` +
        (n.served_method ? `  via ${n.served_method as string}` : ''),
      );
    }
  }

  // ----- Photos (chain of custody + embedded preview) ----------------------
  // Source photos only: exclude the rendered inspection_report PDFs (derived
  // artifacts; their hash is shown under each inspection above).
  const photoOriginals = data.attachments.filter(
    (a) => a.derived_from === null && a.entity_type !== 'inspection_report',
  );
  if (photoOriginals.length > 0) {
    doc.addPage({ size: 'LETTER', margin: 54 });
    doc.fontSize(14).text('Photos', { underline: true });
    doc.moveDown(0.3);
    doc.fontSize(9).fillColor('#555').text(
      'Each photo shows the original content_hash (chain of custody to the bytes the uploader supplied), ' +
      'when the server received it, and who uploaded it. HEIC originals are embedded via a server-derived ' +
      'JPEG; the identity (hash) shown is the original.',
    ).fillColor('#000');
    doc.moveDown(0.5);

    const derivativesByOriginal = new Map<string, AttachmentRow>();
    for (const a of data.attachments) {
      if (a.derived_from) derivativesByOriginal.set(a.derived_from, a);
    }

    const admin = getAdminClient();
    for (const p of photoOriginals) {
      const isHeic = p.mime_type === 'image/heic' || p.mime_type === 'image/heif';
      const renderRow = isHeic ? (derivativesByOriginal.get(p.id) ?? p) : p;
      let bytes: Uint8Array | null = null;
      try {
        const dl = await admin.storage.from('attachments').download(renderRow.storage_path);
        if (!dl.error && dl.data) bytes = new Uint8Array(await dl.data.arrayBuffer());
      } catch { /* fall through to placeholder */ }

      // Chain-of-custody header for this photo (ALWAYS shown, even when
      // bytes can't be downloaded -- the row is the evidence).
      doc.fontSize(9).fillColor('#333').text(
        `received_at: ${p.received_at}    original sha256: ${p.content_hash}`,
      );
      const uploaderActor = p.uploaded_by
        ? `user:${p.uploaded_by} (${data.uploaderNames.get(p.uploaded_by) ?? p.uploaded_by})`
        : data.intakeTokenById.has(p.id)
          ? `tenant:${data.intakeTokenById.get(p.id)}`
          : 'system';
      doc.text(`uploader:   ${uploaderActor}    mime: ${p.mime_type ?? '?'}    size: ${p.size_bytes ?? '?'} bytes`);
      doc.fillColor('#000');

      const renderable = renderRow.mime_type === 'image/jpeg' || renderRow.mime_type === 'image/png';
      if (bytes && renderable) {
        try {
          doc.image(Buffer.from(bytes), { fit: [400, 300] });
        } catch (e) {
          doc.fontSize(9).fillColor('#a00').text(
            `[failed to embed: ${(e as Error).message}]`,
          ).fillColor('#000');
        }
      } else {
        doc.fontSize(9).fillColor('#a00').text(
          `[photo ${p.id} of type ${p.mime_type ?? '?'} could not be embedded -- bytes available at storage_path]`,
        ).fillColor('#000');
      }
      doc.moveDown(0.8);
    }
  }

  // ----- Audit trail (entities in scope) -----------------------------------
  doc.addPage({ size: 'LETTER', margin: 54 });
  doc.fontSize(14).text('Audit trail', { underline: true });
  doc.moveDown(0.3);
  doc.fontSize(8).fillColor('#444').text(
    'Every consequential write to the entities above is recorded as an immutable, ' +
    'server-timestamped, attributed event. The hash chain over these events is ' +
    'what the verification banner on page 1 attests to.',
  ).fillColor('#000');
  doc.moveDown(0.3);
  if (data.events.length === 0) {
    italicNote(doc, '(no audit events in scope)');
  } else {
    doc.fontSize(8);
    for (const e of data.events) {
      doc.text(
        `#${(e.account_seq as number) ?? '?'}  ${e.occurred_at as string}  ${(e.event_type as string).padEnd(10)}  ` +
        `${(e.entity_type as string).padEnd(22)}  ${(e.entity_id as string).slice(0, 8)}…  ${e.actor as string}`,
      );
    }
  }

  // ----- Footer with content-of-bundle hash placeholder --------------------
  // The hash of these bytes is computed AFTER doc.end() and stored on the
  // evidence_exports row; we don't write it into the PDF (would change the
  // hash). The audit event for evidence_exports.insert is the canonical
  // record of THIS bundle's identity.

  doc.end();
  await done;
  return new Uint8Array(Buffer.concat(chunks));
}

function section(doc: PDFKit.PDFDocument, title: string): void {
  doc.moveDown(0.8);
  doc.fontSize(13).text(title, { underline: true });
  doc.moveDown(0.2);
}

function italicNote(doc: PDFKit.PDFDocument, text: string): void {
  doc.fontSize(9).fillColor('#777').text(text).fillColor('#000');
}
