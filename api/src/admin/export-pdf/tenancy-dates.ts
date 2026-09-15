import type { getAdminClient } from '../supabase-admin';
import type { DbTableRow } from '../../supabase/db-types';

export type DateHistoryRecord = Omit<
  DbTableRow<'tenancy_date_records'>,
  'request_key' | 'request_fingerprint' | 'response_body'
>;

const HISTORY_COLUMNS =
  'id,account_id,tenancy_id,kind,before_facts,after_facts,context_snapshot,' +
  'context_fingerprint,reason_code,reason_note,source_document_id,source_document_snapshot,created_by,created_at';

/** Standing evidence context is complete even when the ledger has a date cutoff. */
export async function loadTenancyDateHistory(
  admin: ReturnType<typeof getAdminClient>,
  accountId: string,
  tenancyId: string,
): Promise<DateHistoryRecord[]> {
  const rows: DateHistoryRecord[] = [];
  let cursor: string | undefined;
  for (;;) {
    let query = admin
      .from('tenancy_date_records')
      .select(HISTORY_COLUMNS)
      .eq('account_id', accountId)
      .eq('tenancy_id', tenancyId)
      .order('id')
      .limit(500);
    if (cursor) query = query.gt('id', cursor);
    const { data, error } = await query;
    if (error) throw new Error(`date history load failed: ${error.message}`);
    const page = (data ?? []) as unknown as DateHistoryRecord[];
    rows.push(...page);
    if (page.length < 500) break;
    cursor = page.at(-1)!.id;
  }
  return rows.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function dateRecordLines(record: DateHistoryRecord): string[] {
  const before = object(record.before_facts);
  const after = object(record.after_facts);
  const source = object(record.source_document_snapshot);
  const lines = [
    `${record.kind === 'correction' ? 'Correction' : 'Explanation'} ${record.id}`,
    `Recorded ${record.created_at} by user:${record.created_by}`,
  ];
  const labels = {
    start_date: 'Possession start',
    start_date_basis: 'Date meaning',
    actual_move_in_date: 'Actual move-in',
    status: 'Tenancy status',
  };
  for (const [key, label] of Object.entries(labels)) {
    if (before[key] !== after[key])
      lines.push(`${label}: ${before[key] ?? 'not recorded'} -> ${after[key] ?? 'not recorded'}`);
  }
  if (record.kind === 'explanation') {
    const context = object(record.context_snapshot);
    lines.push(`Reviewed possession start: ${before.start_date ?? 'not recorded'}`);
    const lease = object(context.lease);
    const schedule = object(context.schedule);
    if (lease.id) lines.push(`Selected lease ${lease.id}: term starts ${lease.term_start}`);
    if (schedule.id)
      lines.push(`Selected schedule ${schedule.id}: effective from ${schedule.start_date}`);
    lines.push('Applies to the captured date context; later changes require a fresh review.');
  }
  lines.push(`Reason (${record.reason_code}): ${record.reason_note}`);
  if (record.source_document_id) {
    lines.push(`Evidence: ${source.title ?? 'document'} (${record.source_document_id})`);
    const versions = Array.isArray(source.versions) ? source.versions : [];
    if (versions.length === 0) lines.push('Unversioned reference: no content hash captured.');
    for (const version of versions) {
      const v = object(version);
      lines.push(`Version ${v.version_no} (${v.id}), SHA-256: ${v.content_hash}`);
    }
  }
  lines.push(
    'This record did not change charges, payments, allocations, leases, or rent schedules.',
  );
  return lines;
}

export function renderTenancyDateHistory(
  doc: PDFKit.PDFDocument,
  records: DateHistoryRecord[],
): void {
  if (records.length === 0) return;
  if (doc.y > doc.page.height - doc.page.margins.bottom - 180) doc.addPage();
  doc.moveDown(0.8).fontSize(13).text('Date corrections and explanations', { underline: true });
  doc
    .moveDown(0.2)
    .fontSize(9)
    .text('Complete recorded date history, including records outside the activity date range.');
  for (const record of records) {
    if (doc.y > doc.page.height - doc.page.margins.bottom - 100) doc.addPage();
    doc.moveDown(0.5).fontSize(9);
    for (const line of dateRecordLines(record)) doc.text(line, { width: 504 });
  }
}
