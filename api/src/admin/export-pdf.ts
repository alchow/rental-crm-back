import { getLogger } from '../log';
import { getAdminClient } from './supabase-admin';
import { renderExportPdf } from './export-pdf/render';
import {
  MAX_BYTES as UPLOAD_MAX_BYTES,
  MAX_GENERATED_BYTES as GENERATED_ARTIFACT_MAX_BYTES,
  storeGeneratedArtifactBytes,
} from './storage';

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
export const MAX_GENERATED_BYTES = GENERATED_ARTIFACT_MAX_BYTES;

export interface ExportScope {
  accountId: string;
  tenancyId?: string | null;
  areaId?: string | null;
  fromDate?: string | null; // ISO date
  toDate?: string | null; // ISO date
  exporter: string | null; // auth.users.id of the operator
}

export interface ChainStatus {
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
      .update({
        status: 'failed',
        error: message.slice(0, 2000),
        updated_at: new Date().toISOString(),
      })
      .eq('id', evidenceExportId)
      .then(({ error }) => {
        if (error)
          getLogger().error({ err: error, evidenceExportId }, 'could not mark export failed');
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

  // 4. Hash + immutable store. Generated artifacts use the separate 200 MiB
  // cap, and duplicate paths are byte-verified before they are accepted.
  const stored = await storeGeneratedArtifactBytes(scope.accountId, pdfBytes, 'application/pdf');
  const contentHash = stored.hash;
  const storagePath = stored.storagePath;

  // 5. Land the artifact via complete_evidence_export: ONE txn that inserts
  //    the attachment row and flips the export row to done, with audit.actor
  //    pinned to 'user:<exporter>' inside the function so both audit events
  //    carry the operator attribution. Same atomicity discipline as
  //    submit_intake_with_attachment (Phase 9) applied here.
  const attachmentId = crypto.randomUUID();
  const rpcRes = await admin.rpc('complete_evidence_export', {
    p_evidence_export_id: evidenceExportId,
    p_attachment_id: attachmentId,
    p_storage_path: storagePath,
    p_content_hash: contentHash,
    p_size_bytes: pdfBytes.byteLength,
    p_generated_at: generatedAt.toISOString(),
    p_chain_verified: chain.ok,
    p_chain_message: chain.message,
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

export interface AttachmentRow {
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

type AdminClient = ReturnType<typeof getAdminClient>;

const IN_FILTER_CHUNK_SIZE = 100;
const ATTACHMENT_COLS =
  'id, entity_type, entity_id, storage_path, content_hash, mime_type, size_bytes, uploaded_by, derived_from, received_at';

export interface ExportData {
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

function idChunks(ids: Iterable<string>, size = IN_FILTER_CHUNK_SIZE): string[][] {
  const unique = [...new Set(ids)].filter((id) => id.length > 0);
  const chunks: string[][] = [];
  for (let i = 0; i < unique.length; i += size) {
    chunks.push(unique.slice(i, i + size));
  }
  return chunks;
}

async function loadAttachmentsForEntityIds(
  admin: AdminClient,
  accountId: string,
  entityIds: Iterable<string>,
  opts: { entityType?: string; label: string },
): Promise<AttachmentRow[]> {
  const rows: AttachmentRow[] = [];
  for (const chunk of idChunks(entityIds)) {
    let query = admin
      .from('attachments')
      .select(ATTACHMENT_COLS)
      .eq('account_id', accountId)
      .in('entity_id', chunk)
      .is('deleted_at', null);
    if (opts.entityType) query = query.eq('entity_type', opts.entityType);
    const { data, error } = await query;
    if (error) throw new Error(`${opts.label} load failed: ${error.message}`);
    rows.push(...((data as AttachmentRow[] | null) ?? []));
  }
  return rows;
}

async function loadEventsForEntityIds(
  admin: AdminClient,
  accountId: string,
  entityIds: Iterable<string>,
): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = [];
  for (const chunk of idChunks(entityIds)) {
    const { data, error } = await admin
      .from('events')
      .select('id, account_id, actor, entity_type, entity_id, event_type, occurred_at, account_seq')
      .eq('account_id', accountId)
      .in('entity_id', chunk)
      .order('account_seq', { ascending: true });
    if (error) throw new Error(`event load failed: ${error.message}`);
    rows.push(...((data as Record<string, unknown>[] | null) ?? []));
  }
  return rows.sort((a, b) => Number(a.account_seq ?? 0) - Number(b.account_seq ?? 0));
}

async function loadCastRows(
  admin: AdminClient,
  accountId: string,
  interactionIds: Iterable<string>,
): Promise<CastRow[]> {
  const rows: CastRow[] = [];
  for (const chunk of idChunks(interactionIds)) {
    const { data, error } = await admin
      .from('interaction_participants')
      .select('interaction_id, role, party_type, party_id, address, label, source')
      .eq('account_id', accountId)
      .in('interaction_id', chunk)
      .order('created_at', { ascending: true });
    if (error) throw new Error(`interaction cast load failed: ${error.message}`);
    rows.push(...((data as CastRow[] | null) ?? []));
  }
  return rows;
}

async function loadDeliveryRows(
  admin: AdminClient,
  accountId: string,
  interactionIds: Iterable<string>,
): Promise<Array<{ interaction_id: string | null; status: string; delivered_at: string | null }>> {
  const rows: Array<{
    interaction_id: string | null;
    status: string;
    delivered_at: string | null;
  }> = [];
  for (const chunk of idChunks(interactionIds)) {
    const { data, error } = await admin
      .from('comm_outbox')
      .select('interaction_id, status, delivered_at')
      .eq('account_id', accountId)
      .is('relay_of_interaction_id', null)
      .in('interaction_id', chunk);
    if (error) throw new Error(`delivery-state load failed: ${error.message}`);
    rows.push(
      ...((data as Array<{
        interaction_id: string | null;
        status: string;
        delivered_at: string | null;
      }> | null) ?? []),
    );
  }
  return rows;
}

async function loadInboundProvenanceRows(
  admin: AdminClient,
  accountId: string,
  providerMsgIds: Iterable<string>,
): Promise<Array<{ provider_msg_id: string; body_sha256: string }>> {
  const rows: Array<{ provider_msg_id: string; body_sha256: string }> = [];
  for (const chunk of idChunks(providerMsgIds)) {
    const { data, error } = await admin
      .from('inbound_provenance')
      .select('provider_msg_id, body_sha256')
      .eq('account_id', accountId)
      .in('provider_msg_id', chunk);
    if (error) throw new Error(`inbound-provenance load failed: ${error.message}`);
    rows.push(...((data as Array<{ provider_msg_id: string; body_sha256: string }> | null) ?? []));
  }
  return rows;
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
        ? admin
            .from('interactions')
            .select('*')
            .eq('account_id', accountId)
            .in('id', missingParents)
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
    const a = await admin
      .from('areas')
      .select('*')
      .eq('account_id', scope.accountId)
      .eq('id', areaId)
      .maybeSingle();
    area = a.data as Record<string, unknown> | null;
  }
  const propertyId = area?.property_id as string | undefined;
  if (propertyId) {
    const p = await admin
      .from('properties')
      .select('*')
      .eq('account_id', scope.accountId)
      .eq('id', propertyId)
      .maybeSingle();
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
      ? admin
          .from('tenancy_tenants')
          .select('*, tenants(*)')
          .eq('account_id', scope.accountId)
          .eq('tenancy_id', tenancyId)
      : Promise.resolve({ data: [] as Record<string, unknown>[], error: null }),
    tenancyId
      ? admin
          .from('leases')
          .select('*')
          .eq('account_id', scope.accountId)
          .eq('tenancy_id', tenancyId)
      : Promise.resolve({ data: [] as Record<string, unknown>[], error: null }),
    tenancyId
      ? admin
          .from('rent_schedules')
          .select('*')
          .eq('account_id', scope.accountId)
          .eq('tenancy_id', tenancyId)
      : Promise.resolve({ data: [] as Record<string, unknown>[], error: null }),
    tenancyId
      ? admin
          .from('charges')
          .select('*')
          .eq('account_id', scope.accountId)
          .eq('tenancy_id', tenancyId)
      : Promise.resolve({ data: [] as Record<string, unknown>[], error: null }),
    tenancyId
      ? admin
          .from('payments')
          .select('*')
          .eq('account_id', scope.accountId)
          .eq('tenancy_id', tenancyId)
      : Promise.resolve({ data: [] as Record<string, unknown>[], error: null }),
  ]);
  const fromDate = scope.fromDate ?? null;
  const toDate = scope.toDate ?? null;
  const occupants: Record<string, unknown>[] = (occRes.data as Record<string, unknown>[]) ?? [];
  const leases: Record<string, unknown>[] = (leaseRes.data as Record<string, unknown>[]) ?? [];
  const rentSchedules: Record<string, unknown>[] =
    (schedRes.data as Record<string, unknown>[]) ?? [];
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
    if (allocRes.error)
      throw new Error(`payment_allocations query failed: ${allocRes.error.message}`);
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
    if (fromDate) intQ = intQ.gte('occurred_at', fromDate);
    if (toDate) intQ = intQ.lte('occurred_at', `${toDate}T23:59:59Z`);
    const intRes = await intQ;
    interactions = (intRes.data as Record<string, unknown>[]) ?? [];
    // Never render a partial correction chain (see completeInteractionChains).
    interactions = await completeInteractionChains(admin, scope.accountId, interactions);
  }
  if (areaId) {
    const [mr, ins] = await Promise.all([
      admin
        .from('maintenance_requests')
        .select('*')
        .eq('account_id', scope.accountId)
        .eq('area_id', areaId),
      admin.from('inspections').select('*').eq('account_id', scope.accountId).eq('area_id', areaId),
    ]);
    maintenanceRequests = (mr.data as Record<string, unknown>[]) ?? [];
    inspections = (ins.data as Record<string, unknown>[]) ?? [];

    if (maintenanceRequests.length > 0) {
      const ids = maintenanceRequests.map((r) => r.id as string);
      const wo = await admin
        .from('work_orders')
        .select('*')
        .eq('account_id', scope.accountId)
        .in('maintenance_request_id', ids);
      workOrders = (wo.data as Record<string, unknown>[]) ?? [];
    }
    if (inspections.length > 0) {
      const ids = inspections.map((r) => r.id as string);
      const [items, checks] = await Promise.all([
        admin
          .from('inspection_items')
          .select('*')
          .eq('account_id', scope.accountId)
          .in('inspection_id', ids),
        admin
          .from('inspection_checks')
          .select('*')
          .eq('account_id', scope.accountId)
          .in('inspection_id', ids),
      ]);
      inspectionItems = (items.data as Record<string, unknown>[]) ?? [];
      inspectionChecks = (checks.data as Record<string, unknown>[]) ?? [];
    }
  }
  if (tenancyId) {
    const n = await admin
      .from('notices')
      .select('*')
      .eq('account_id', scope.accountId)
      .eq('tenancy_id', tenancyId);
    notices = (n.data as Record<string, unknown>[]) ?? [];
  }

  // All attachments tied to any in-scope entity.
  const entityIds: string[] = [];
  for (const r of maintenanceRequests) entityIds.push(r.id as string);
  for (const r of inspections) entityIds.push(r.id as string);
  for (const r of interactions) entityIds.push(r.id as string);
  let attachments: AttachmentRow[] = [];
  if (entityIds.length > 0) {
    attachments = await loadAttachmentsForEntityIds(admin, scope.accountId, entityIds, {
      label: 'attachment',
    });
  }
  // Condition-report item photos attach at entity_type='inspection_items' keyed
  // by item id. Fetch them separately + CHUNKED -- a full move-in form can have
  // 100+ items, and folding all item ids into the shared id list above would
  // blow the IN() query (and the events scope). Each item's chain-of-custody
  // then renders in the Photos section like any other source photo.
  if (inspectionItems.length > 0) {
    attachments.push(
      ...(await loadAttachmentsForEntityIds(
        admin,
        scope.accountId,
        inspectionItems.map((r) => r.id as string),
        { entityType: 'inspection_items', label: 'item-photo' },
      )),
    );
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
    events = await loadEventsForEntityIds(admin, scope.accountId, eventEntityIds);
  }

  // Resolve uploader display names for chain-of-custody. The same map names
  // who retracted a soft-deleted journal row (the unverified-tier marker).
  const uploaderIds = new Set<string>();
  for (const att of attachments) {
    if (att.uploaded_by) uploaderIds.add(att.uploaded_by);
  }
  for (const r of interactions) {
    if (r.deleted_at && r.deleted_by) uploaderIds.add(String(r.deleted_by));
  }
  const uploaderNames = new Map<string, string>();
  if (uploaderIds.size > 0) {
    const u = await admin
      .from('users')
      .select('id, display_name')
      .in('id', Array.from(uploaderIds));
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
    for (const t of (tRes.data as { id: string; full_name: string }[] | null) ?? [])
      partyNames.set(t.id, t.full_name);
    for (const v of (vRes.data as { id: string; name: string }[] | null) ?? [])
      partyNames.set(v.id, v.name);
  }

  // The cast per journal row (interaction_participants). Loaded for every
  // in-scope interaction so the artifact names all recipients of a group
  // message and all attendees of an in-person contact.
  const castByInteraction = new Map<string, CastRow[]>();
  if (interactions.length > 0) {
    for (const p of await loadCastRows(
      admin,
      scope.accountId,
      interactions.map((r) => String(r.id)),
    )) {
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
    const [deliveryRows, provenanceRows] = await Promise.all([
      loadDeliveryRows(admin, scope.accountId, ids),
      loadInboundProvenanceRows(admin, scope.accountId, msgIds),
    ]);
    for (const o of deliveryRows) {
      if (o.interaction_id)
        deliveryByInteraction.set(o.interaction_id, {
          status: o.status,
          delivered_at: o.delivered_at,
        });
    }
    for (const p of provenanceRows) {
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

export {
  groupInteractionChains,
  interactionCastDisplay,
  interactionPartyDisplay,
  retractedInteractionMarker,
} from './export-pdf/interactions';
export type { InteractionChain } from './export-pdf/interactions';
