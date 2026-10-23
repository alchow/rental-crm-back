import { captureDisplay } from './capture';
import PDFDocument from 'pdfkit';
import { getAdminClient } from '../supabase-admin';
import type { ChainStatus, ExportScope } from '../export-pdf';
import { idChunks } from './chunks';
import { interactionCastDisplay, retractedInteractionMarker } from './interactions';
import type { CastRow } from '../export-pdf';

export async function loadTenantCommunications(scope: ExportScope, snapshot: string) {
  const admin = getAdminClient();
  const rows: Record<string, unknown>[] = [];
  for (let offset = 0; ; offset += 500) {
    const result = await admin
      .rpc('tenant_communication_records', {
        p_account_id: scope.accountId,
        p_tenant_id: scope.tenantId!,
        p_snapshot: snapshot,
        p_captured_only: false,
      })
      .order('occurred_at')
      .order('id')
      .range(offset, offset + 499);
    if (result.error) throw new Error(result.error.message);
    rows.push(...(result.data ?? []));
    if ((result.data?.length ?? 0) < 500) break;
  }
  const day = new Intl.DateTimeFormat('en-CA', {
    timeZone: scope.timezone ?? 'UTC',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const selected = rows.filter((r) => {
    const parts = day.formatToParts(new Date(String(r.occurred_at)));
    const value = ['year', 'month', 'day']
      .map((k) => parts.find((p) => p.type === k)?.value)
      .join('-');
    return (
      (!scope.tenancyId || r.tenancy_id === scope.tenancyId) &&
      (!scope.fromDate || value >= scope.fromDate) &&
      (!scope.toDate || value <= scope.toDate)
    );
  });
  // Corrections remain attached even when their changed date falls outside the range.
  const included = new Set(selected.map((r) => String(r.id)));
  let changed = true;
  while (changed) {
    changed = false;
    for (const r of rows) {
      if (r.corrects_id && (included.has(String(r.corrects_id)) || included.has(String(r.id)))) {
        for (const id of [String(r.id), String(r.corrects_id)])
          if (!included.has(id)) {
            included.add(id);
            changed = true;
          }
      }
    }
  }
  const entries = rows.filter((r) => included.has(String(r.id)));
  const threadIds = entries.flatMap((r) => (r.thread_id ? [String(r.thread_id)] : []));
  for (const chunk of idChunks(threadIds)) {
    const result = await admin
      .from('comm_threads')
      .select('id, subject')
      .eq('account_id', scope.accountId)
      .in('id', chunk);
    if (result.error) throw new Error(result.error.message);
    const subjects = new Map((result.data ?? []).map((r) => [r.id, r.subject]));
    for (const entry of entries)
      if (entry.channel === 'email' && entry.thread_id && subjects.has(String(entry.thread_id)))
        entry.subject = subjects.get(String(entry.thread_id));
  }
  const casts = new Map<string, CastRow[]>();
  for (const chunk of idChunks(entries.map((r) => String(r.id)))) {
    const res = await admin
      .from('interaction_participants')
      .select('*')
      .eq('account_id', scope.accountId)
      .in('interaction_id', chunk);
    if (res.error) throw new Error(res.error.message);
    for (const row of res.data ?? [])
      casts.set(row.interaction_id, [...(casts.get(row.interaction_id) ?? []), row as CastRow]);
  }
  const tenant = await admin
    .from('tenants')
    .select('full_name')
    .eq('account_id', scope.accountId)
    .eq('id', scope.tenantId!)
    .single();
  if (tenant.error) throw new Error(tenant.error.message);
  return { entries, casts, name: tenant.data.full_name };
}

export async function renderTenantCommunications(
  scope: ExportScope,
  generatedAt: Date,
  chain: ChainStatus,
): Promise<Uint8Array> {
  const { entries, casts, name } = await loadTenantCommunications(scope, generatedAt.toISOString());
  return renderTenantCommunicationLog(scope, generatedAt, chain, { entries, casts, name });
}

export function renderTenantCommunicationLog(
  scope: ExportScope,
  generatedAt: Date,
  chain: ChainStatus,
  { entries, casts, name }: Awaited<ReturnType<typeof loadTenantCommunications>>,
): Promise<Uint8Array> {
  const zone = scope.timezone ?? 'UTC';
  const stamp = (value: unknown) =>
    new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    }).format(new Date(String(value)));
  const doc = new PDFDocument({ margin: 45, size: 'A4', bufferPages: true });
  const chunks: Buffer[] = [];
  const done = new Promise<Uint8Array>((resolve, reject) => {
    doc.on('data', (b: Buffer) => chunks.push(b));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
  const header = () => {
    doc.font('Helvetica-Bold').fontSize(17).text(`Communication log - ${name}`, 45, 45);
    doc
      .font('Helvetica')
      .fontSize(9)
      .text(
        `${scope.tenancyId ? `Selected tenancy ${scope.tenancyId}` : 'All recorded history for this person'} | ${scope.fromDate ?? 'Earliest record'} through ${scope.toDate ?? 'Today'}`,
        45,
      );
    doc.text(`Generated ${stamp(generatedAt.toISOString())} | ${zone} | ${entries.length} entries`);
    doc.text(`Audit chain: ${chain.ok ? 'verified' : 'NOT VERIFIED'} - ${chain.message}`);
    doc.moveDown();
    const y = doc.y;
    doc
      .font('Helvetica-Bold')
      .fontSize(10)
      .text('When', 45, y)
      .text('Source', 145, y)
      .text('Record', 220, y);
    doc
      .moveTo(45, y + 16)
      .lineTo(550, y + 16)
      .strokeColor('#ccc')
      .stroke();
    doc.y = y + 24;
  };
  let textSize = 10;
  doc.on('pageAdded', () => {
    header();
    doc.font('Helvetica').fontSize(textSize);
  });
  header();
  for (const entry of entries) {
    if (doc.y > 685) {
      doc.addPage();
    }
    const captured = Boolean(entry.thread_id);
    const source =
      entry.channel === 'sms'
        ? 'Text'
        : entry.channel === 'phone'
          ? 'Call'
          : String(entry.channel).replaceAll('_', ' ');
    const capture = captureDisplay(entry);
    const body = entry.deleted_at
      ? retractedInteractionMarker(entry, new Map())
      : [entry.subject, entry.body ?? '(No text body recorded)'].filter(Boolean).join('\n');
    const cast = entry.deleted_at
      ? ''
      : interactionCastDisplay(casts.get(String(entry.id)) ?? [], new Map());
    const details = [
      cast || `Author: ${entry.author_type ?? entry.actor}`,
      `Logged ${stamp(entry.logged_at)}`,
      capture.description,
      `Record ${entry.id}`,
    ];
    if (entry.corrects_id) details.push(`${entry.correction_kind}: corrects ${entry.corrects_id}`);
    const ref = String(entry.approval_ref ?? '');
    if (ref.startsWith('grant:')) details.push('Auto-sent under a standing policy');
    else if (ref.startsWith('proposal:') && entry.approved_by)
      details.push('Human-approved Assistant draft');
    else if (ref.startsWith('self:')) details.push('Sent by landlord via Field Log');
    else if (ref.startsWith('system:')) details.push('Automatic Field Log service message');
    if (entry.delivery_status)
      details.push(
        `Provider status: ${entry.delivery_status}${entry.delivered_at ? ` at ${stamp(entry.delivered_at)}` : ''}`,
      );
    const sections = [
      { text: body, size: 10 },
      { text: details.join('\n'), size: 8 },
    ];
    const rowPage = doc.page;
    const rowY = doc.y;
    doc.font('Helvetica').fontSize(8);
    const when = `${capture.timeLabel} ${stamp(capture.time)}`;
    const sourceLabel = `${source}\n${captured ? 'system' : 'note'}`;
    const sideHeight = Math.max(
      doc.heightOfString(when, { width: 90 }),
      doc.heightOfString(sourceLabel, { width: 65 }),
    );
    doc.text(when, 45, rowY, { width: 90 });
    doc.text(sourceLabel, 145, rowY, { width: 65 });
    doc.y = rowY;
    for (const section of sections) {
      textSize = section.size;
      // PDFKit owns wrapping and page advancement, including words wider than the column.
      doc.font('Helvetica').fontSize(textSize).text(section.text, 220, doc.y, { width: 325 });
      doc.y += 4;
    }
    if (doc.page === rowPage) doc.y = Math.max(doc.y, rowY + sideHeight);
    doc
      .moveTo(45, doc.y + 4)
      .lineTo(550, doc.y + 4)
      .strokeColor('#ddd')
      .stroke();
    doc.y += 16;
  }
  if (doc.y > 700) {
    doc.addPage();
  }
  textSize = 8;
  doc
    .fontSize(8)
    .text(
      'System records were captured through Field Log. Notes were entered by the landlord. Capture does not establish delivery to other recipients. Corrections remain separate records.',
      45,
      doc.y,
      { width: 505 },
    );
  doc.end();
  return done;
}
