import { idChunks } from '../export-pdf';
import type { ExportData } from '../export-pdf';
import type { AppSupabaseClient, DbTableRow } from '../../supabase/db-types';

// ---- Incidents section (tenancy-scoped exports only) ------------------------
//
// An incident is the record-keeper's contemporaneous account of something that
// happened, written in pen: `description` and `occurred_at` are DB-frozen
// (20260801000002_incidents.sql), and the citations under it are insert +
// soft-unlink only. The export renders that shape faithfully:
//
//   - DISMISSED (soft-deleted) incidents ARE included. Disputes happen after
//     a landlord decides to drop something, and a bundle that silently omits
//     the dropped record looks like curation. Same policy as ended/soft-
//     deleted tenancies and retracted journal rows: present, marked, never
//     hidden.
//   - The citation manifest CROSS-REFERENCES; it does not duplicate. The full
//     interaction / maintenance request / notice / inspection renders in its
//     own section (when it is in this bundle's scope), so each line here is
//     an identifying stub: type, the cited record's own event time, a short
//     excerpt, and when the citation was made or withdrawn.

type IncidentRow = DbTableRow<'incidents'>;
type IncidentItemRow = DbTableRow<'incident_items'>;

/** Canonical slot list, mirroring the migration's exactly-one-slot CHECK. */
export type IncidentCitationType = 'interaction' | 'maintenance_request' | 'notice' | 'inspection';

/** One manifest line: the cited record reduced to an identifying stub. */
export interface IncidentCitation {
  item_id: string;
  type: IncidentCitationType;
  cited_id: string;
  /** The cited record's OWN event time -- what the manifest sorts on. */
  event_at: string | null;
  excerpt: string;
  linked_at: string;
  unlinked_at: string | null;
}

export interface IncidentRecurrence {
  count: number;
  /** occurred_at dates of the counted incidents, chronological. */
  dates: string[];
}

export interface IncidentEntry {
  incident: IncidentRow;
  citations: IncidentCitation[];
  /** Null when the pattern claim cannot honestly be made (see buildIncidentEntries). */
  recurrence: IncidentRecurrence | null;
}

/** Cited record reduced to what the manifest prints, keyed `${type}:${id}`. */
export interface CitedRecordSummary {
  event_at: string | null;
  excerpt: string;
}

const TRAILING_MONTHS = 12;
const EXCERPT_CHARS = 120;
/** Contemporaneity tolerance: below this, occurred_at and created_at are "the same moment". */
const RECORDED_GAP_MS = 5 * 60 * 1000;
const MAX_RECURRENCE_DATES = 12;

function excerpt(text: string | null): string {
  const t = (text ?? '').replace(/\s+/g, ' ').trim();
  if (t.length === 0) return '(no text)';
  return t.length > EXCERPT_CHARS ? `${t.slice(0, EXCERPT_CHARS)}…` : t;
}

// ---- loader -----------------------------------------------------------------

/**
 * Loads the incidents payload for a tenancy-scoped export.
 *
 * Cited records are fetched HERE, by id, even when the same row already loaded
 * into another section: a date-narrowed bundle or an area-anchored maintenance
 * request can leave a cited record out of the sections, and a manifest with a
 * hole in it is worse than no manifest. They are deliberately NOT merged into
 * data.interactions / data.maintenanceRequests / ... -- widening those would
 * silently widen the bundle's stated scope.
 */
export async function loadIncidents(
  admin: AppSupabaseClient,
  accountId: string,
  tenancyId: string,
): Promise<IncidentEntry[]> {
  // No deleted_at filter: dismissed incidents render with a DISMISSED marker.
  const incRes = await admin
    .from('incidents')
    .select('*')
    .eq('account_id', accountId)
    .eq('tenancy_id', tenancyId)
    .order('occurred_at', { ascending: true })
    .order('id', { ascending: true });
  if (incRes.error) throw new Error(`incident load failed: ${incRes.error.message}`);
  const incidents = (incRes.data ?? []) as IncidentRow[];
  if (incidents.length === 0) return [];

  // Unlinked (soft-deleted) citations load too -- an unlink is itself a fact
  // about what the record-keeper relied on and when they stopped relying on it.
  const items: IncidentItemRow[] = [];
  for (const chunk of idChunks(incidents.map((i) => i.id))) {
    const { data, error } = await admin
      .from('incident_items')
      .select('*')
      .eq('account_id', accountId)
      .in('incident_id', chunk)
      .order('created_at', { ascending: true });
    if (error) throw new Error(`incident citation load failed: ${error.message}`);
    items.push(...((data ?? []) as IncidentItemRow[]));
  }

  return buildIncidentEntries(incidents, items, await loadCitedSummaries(admin, accountId, items));
}

async function loadCitedSummaries(
  admin: AppSupabaseClient,
  accountId: string,
  items: IncidentItemRow[],
): Promise<Map<string, CitedRecordSummary>> {
  const summaries = new Map<string, CitedRecordSummary>();
  const ids = (pick: (i: IncidentItemRow) => string | null) =>
    items.map(pick).filter((id): id is string => typeof id === 'string');

  for (const chunk of idChunks(ids((i) => i.interaction_id))) {
    const { data, error } = await admin
      .from('interactions')
      .select('id, occurred_at, body, kind, channel, direction, deleted_at')
      .eq('account_id', accountId)
      .in('id', chunk);
    if (error) throw new Error(`cited interaction load failed: ${error.message}`);
    for (const r of data ?? []) {
      summaries.set(`interaction:${r.id}`, {
        event_at: r.occurred_at,
        // A retracted entry keeps its marker, never its repudiated content
        // (same policy as the Interactions section).
        excerpt: r.deleted_at
          ? '(retracted journal entry)'
          : r.body
            ? excerpt(r.body)
            : `${r.direction ?? ''} ${r.channel ?? r.kind}`.trim(),
      });
    }
  }
  for (const chunk of idChunks(ids((i) => i.maintenance_request_id))) {
    const { data, error } = await admin
      .from('maintenance_requests')
      .select('id, created_at, title, status, severity')
      .eq('account_id', accountId)
      .in('id', chunk);
    if (error) throw new Error(`cited maintenance request load failed: ${error.message}`);
    for (const r of data ?? []) {
      summaries.set(`maintenance_request:${r.id}`, {
        event_at: r.created_at,
        excerpt: `${excerpt(r.title)} [${r.severity}/${r.status}]`,
      });
    }
  }
  for (const chunk of idChunks(ids((i) => i.notice_id))) {
    const { data, error } = await admin
      .from('notices')
      .select('id, created_at, served_at, notice_type, served_method')
      .eq('account_id', accountId)
      .in('id', chunk);
    if (error) throw new Error(`cited notice load failed: ${error.message}`);
    for (const r of data ?? []) {
      summaries.set(`notice:${r.id}`, {
        event_at: r.served_at ?? r.created_at,
        excerpt: r.served_method
          ? `${r.notice_type} served via ${r.served_method}`
          : `${r.notice_type} (not served)`,
      });
    }
  }
  for (const chunk of idChunks(ids((i) => i.inspection_id))) {
    const { data, error } = await admin
      .from('inspections')
      .select('id, created_at, performed_at, kind, status')
      .eq('account_id', accountId)
      .in('id', chunk);
    if (error) throw new Error(`cited inspection load failed: ${error.message}`);
    for (const r of data ?? []) {
      summaries.set(`inspection:${r.id}`, {
        event_at: r.performed_at ?? r.created_at,
        excerpt: `${r.kind ?? 'general'} (${r.status})`,
      });
    }
  }
  return summaries;
}

// ---- pure derivation (the test seam; PDFKit output is not greppable) --------

function citationOf(item: IncidentItemRow): { type: IncidentCitationType; id: string } | null {
  if (item.interaction_id) return { type: 'interaction', id: item.interaction_id };
  if (item.maintenance_request_id)
    return { type: 'maintenance_request', id: item.maintenance_request_id };
  if (item.notice_id) return { type: 'notice', id: item.notice_id };
  if (item.inspection_id) return { type: 'inspection', id: item.inspection_id };
  return null; // unreachable: CHECK num_nonnulls(...) = 1
}

/**
 * Joins incidents to their citations and derives the recurrence claim.
 *
 * Recurrence counts only LIVE incidents of the same category inside the
 * trailing 12 months ending at this incident's occurred_at, and is omitted for
 * unclassified or dismissed incidents. Two honesty constraints drive that: an
 * unclassified incident is not evidence of a pattern of anything, and a
 * dismissed one is testimony the landlord withdrew -- counting it would let a
 * withdrawn record still inflate "3rd noise incident". occurred_at is
 * DB-frozen, so a count that IS shown cannot be manufactured after the fact.
 */
export function buildIncidentEntries(
  incidents: IncidentRow[],
  items: IncidentItemRow[],
  cited: Map<string, CitedRecordSummary>,
): IncidentEntry[] {
  const itemsByIncident = new Map<string, IncidentItemRow[]>();
  for (const it of items) {
    const list = itemsByIncident.get(it.incident_id) ?? [];
    list.push(it);
    itemsByIncident.set(it.incident_id, list);
  }
  const live = incidents.filter((i) => !i.deleted_at);

  return incidents.map((incident) => {
    const citations: IncidentCitation[] = [];
    for (const it of itemsByIncident.get(incident.id) ?? []) {
      const ref = citationOf(it);
      if (!ref) continue;
      const summary = cited.get(`${ref.type}:${ref.id}`);
      citations.push({
        item_id: it.id,
        type: ref.type,
        cited_id: ref.id,
        event_at: summary?.event_at ?? null,
        excerpt: summary?.excerpt ?? '(cited record not available)',
        linked_at: it.created_at,
        unlinked_at: it.deleted_at,
      });
    }
    // Chronological by the CITED record's event time, not by when it was
    // cited: the manifest reconstructs the sequence of events the incident
    // rests on. Undated stubs sort last; ties break on link time then id.
    citations.sort((a, b) => {
      if (a.event_at !== b.event_at) {
        if (!a.event_at) return 1;
        if (!b.event_at) return -1;
        return a.event_at.localeCompare(b.event_at);
      }
      return a.linked_at.localeCompare(b.linked_at) || a.item_id.localeCompare(b.item_id);
    });

    let recurrence: IncidentRecurrence | null = null;
    if (incident.category && !incident.deleted_at) {
      const end = Date.parse(incident.occurred_at);
      const startDate = new Date(incident.occurred_at);
      startDate.setUTCMonth(startDate.getUTCMonth() - TRAILING_MONTHS);
      const start = startDate.getTime();
      const dates = live
        .filter((other) => {
          if (other.category !== incident.category) return false;
          const t = Date.parse(other.occurred_at);
          return t >= start && t <= end;
        })
        .map((other) => other.occurred_at.slice(0, 10))
        .sort();
      if (dates.length > 1) recurrence = { count: dates.length, dates };
    }

    return { incident, citations, recurrence };
  });
}

/** OPEN / RESOLVED / DISMISSED, with the stamp that decided it. */
export function incidentStatusLabel(incident: IncidentRow): string {
  if (incident.deleted_at) return `DISMISSED ${incident.deleted_at}`;
  if (incident.resolved_at) return `RESOLVED ${incident.resolved_at}`;
  return 'OPEN';
}

/**
 * The contemporaneity line. A record written while the event was fresh carries
 * more weight than one written months later, so the export states the gap
 * rather than leaving the reader to assume the two timestamps agree. Suppressed
 * under 5 minutes, where the difference is just round-trip latency.
 */
export function incidentRecordedSuffix(incident: IncidentRow): string {
  const gap = Math.abs(Date.parse(incident.created_at) - Date.parse(incident.occurred_at));
  return Number.isFinite(gap) && gap > RECORDED_GAP_MS
    ? `   (recorded ${incident.created_at})`
    : '';
}

export function incidentRecurrenceLine(recurrence: IncidentRecurrence): string {
  const shown = recurrence.dates.slice(0, MAX_RECURRENCE_DATES);
  const more = recurrence.dates.length - shown.length;
  return (
    `${ordinal(recurrence.count)} same-category incident in trailing ${TRAILING_MONTHS} months: ` +
    shown.join(', ') +
    (more > 0 ? `, +${more} more` : '')
  );
}

export function incidentCitationLine(citation: IncidentCitation): string {
  return (
    `– ${citation.type.padEnd(20)} ${(citation.event_at ?? '(undated)').padEnd(26)} ` +
    `${citation.excerpt}   (linked ${citation.linked_at.slice(0, 10)})` +
    (citation.unlinked_at ? `   [UNLINKED ${citation.unlinked_at.slice(0, 10)}]` : '')
  );
}

function ordinal(n: number): string {
  const teen = n % 100;
  if (teen >= 11 && teen <= 13) return `${n}th`;
  const last = n % 10;
  return `${n}${last === 1 ? 'st' : last === 2 ? 'nd' : last === 3 ? 'rd' : 'th'}`;
}

// ---- render -----------------------------------------------------------------

/**
 * Renders the Incidents body. The section header and the empty-state note stay
 * in render.ts so ALL section typography has one owner (and so this module does
 * not import back into render.ts, which would make the pair cyclic).
 */
export function renderIncidentsSection(doc: PDFKit.PDFDocument, data: ExportData): void {
  doc
    .fontSize(9)
    .fillColor('#555')
    .text(
      'Each incident is the record-keeper’s account of one event; its description and date are ' +
        'frozen at write time. Cited evidence is listed by reference below — the full records ' +
        'appear in the sections above when they fall inside this bundle’s scope.',
    )
    .fillColor('#000');
  doc.moveDown(0.4);

  for (const entry of data.incidents) {
    const inc = entry.incident;
    doc
      .fontSize(10)
      .fillColor('#000')
      .text(
        `• ${inc.category ?? 'unclassified'}   [${incidentStatusLabel(inc)}]   ${inc.occurred_at}` +
          incidentRecordedSuffix(inc),
      );
    // Verbatim, never truncated: the description IS the testimony.
    doc.fontSize(9).fillColor('#333').text(`    ${inc.description}`);
    if (inc.resolution_note) doc.text(`    resolution: ${inc.resolution_note}`);
    if (entry.recurrence) {
      doc
        .fillColor('#7a1e1e')
        .text(`    ${incidentRecurrenceLine(entry.recurrence)}`)
        .fillColor('#333');
    }
    if (entry.citations.length === 0) {
      doc.fillColor('#777').text('    (no evidence cited)').fillColor('#333');
    } else {
      doc.text('    evidence cited:');
      doc.fontSize(8);
      for (const c of entry.citations) doc.text(`      ${incidentCitationLine(c)}`);
      doc.fontSize(9);
    }
    doc.fillColor('#000');
    doc.moveDown(0.4);
  }
}
