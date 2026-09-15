import { describe, expect, it } from 'vitest';
import PDFDocument from 'pdfkit';
import { writeFile } from 'node:fs/promises';
import {
  dateRecordLines,
  renderTenancyDateHistory,
  type DateHistoryRecord,
} from '../src/admin/export-pdf/tenancy-dates';

const record: DateHistoryRecord = {
  id: '11111111-1111-4111-8111-111111111111',
  account_id: '22222222-2222-4222-8222-222222222222',
  tenancy_id: '33333333-3333-4333-8333-333333333333',
  kind: 'correction',
  created_at: '2026-09-13T10:00:00Z',
  created_by: '44444444-4444-4444-8444-444444444444',
  before_facts: {
    start_date: '2026-07-01',
    actual_move_in_date: null,
    start_date_basis: 'legacy_unverified',
  },
  after_facts: {
    start_date: '2026-05-01',
    actual_move_in_date: '2026-05-05',
    start_date_basis: 'possession_entitlement',
  },
  context_snapshot: {},
  context_fingerprint: 'a'.repeat(64),
  reason_code: 'data_entry_error',
  reason_note: 'July was entered by mistake. Keys were available May 1.',
  source_document_id: '55555555-5555-4555-8555-555555555555',
  source_document_snapshot: {
    title: 'Key handover record',
    versions: [{ id: 'version-1', version_no: 1, content_hash: 'f'.repeat(64) }],
  },
};

describe('date evidence export', () => {
  it('preserves the prior value, capture time, actor, reason and immutable source identity', () => {
    const text = dateRecordLines(record).join('\n');
    expect(text).toContain('2026-07-01 -> 2026-05-01');
    expect(text).toContain('Recorded 2026-09-13T10:00:00Z');
    expect(text).toContain(record.created_by);
    expect(text).toContain(record.reason_note);
    expect(text).toContain('SHA-256: ' + 'f'.repeat(64));
    expect(text).not.toContain('request_fingerprint');
  });

  it('renders long reasons and multiple corrections across pages', async () => {
    const doc = new PDFDocument({ size: 'LETTER', margin: 54, compress: false });
    const chunks: Buffer[] = [];
    doc.on('data', (b: Buffer) => chunks.push(b));
    const done = new Promise<Buffer>((resolve, reject) => {
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
    });
    doc.fontSize(20).text('Tenancy date evidence');
    doc.y = 600; // Exercise the same boundary as a populated export cover page.
    renderTenancyDateHistory(doc, [
      record,
      {
        ...record,
        id: 'long-reason',
        reason_note: 'The handover log confirms the tenant had access on May 1. '.repeat(34),
      },
      {
        ...record,
        id: 'review',
        kind: 'explanation',
        after_facts: record.before_facts,
        context_snapshot: {
          lease: { id: 'lease-1', term_start: '2026-05-01' },
          schedule: { id: 'rent-1', start_date: '2026-06-01' },
        },
      },
    ]);
    doc.end();
    const bytes = await done;
    expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
    expect((bytes.toString().match(/\/Type \/Page\b/g) ?? []).length).toBeGreaterThan(1);
    if (process.env.DATE_PDF_PREVIEW) await writeFile(process.env.DATE_PDF_PREVIEW, bytes);
  });
});
