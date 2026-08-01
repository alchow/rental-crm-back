import { describe, expect, it } from 'vitest';
import {
  buildIncidentEntries,
  incidentCitationLine,
  incidentRecordedSuffix,
  incidentRecurrenceLine,
  incidentStatusLabel,
  type CitedRecordSummary,
} from '../src/admin/export-pdf/incidents';
import type { DbTableRow } from '../src/supabase/db-types';

type IncidentRow = DbTableRow<'incidents'>;
type IncidentItemRow = DbTableRow<'incident_items'>;

// PDFKit output is not string-greppable, so the export's evidentiary claims
// (chronology, recurrence honesty, unlink transparency) are pinned here at the
// seam functions instead. The integration suite covers the DB/API behavior.

const ACC = 'a0000000-0000-0000-0000-000000000001';
const TEN = 'b0000000-0000-0000-0000-000000000001';

function incident(over: Partial<IncidentRow>): IncidentRow {
  return {
    id: crypto.randomUUID(),
    account_id: ACC,
    tenancy_id: TEN,
    category: 'noise',
    description: 'bass from 2A since 10:30pm',
    occurred_at: '2026-07-12T23:04:00+00:00',
    resolved_at: null,
    resolution_note: null,
    created_at: '2026-07-12T23:06:00+00:00',
    updated_at: '2026-07-12T23:06:00+00:00',
    deleted_at: null,
    ...over,
  };
}

function item(incidentId: string, over: Partial<IncidentItemRow>): IncidentItemRow {
  return {
    id: crypto.randomUUID(),
    account_id: ACC,
    incident_id: incidentId,
    interaction_id: null,
    maintenance_request_id: null,
    notice_id: null,
    inspection_id: null,
    created_at: '2026-07-30T09:00:00+00:00',
    updated_at: '2026-07-30T09:00:00+00:00',
    deleted_at: null,
    ...over,
  };
}

describe('buildIncidentEntries', () => {
  it('orders the citation manifest by the cited record’s own event time, undated last', () => {
    const inc = incident({});
    const ids = {
      mr: crypto.randomUUID(),
      no: crypto.randomUUID(),
      ix: crypto.randomUUID(),
      insp: crypto.randomUUID(),
    };
    const items = [
      item(inc.id, { interaction_id: ids.ix }),
      item(inc.id, { inspection_id: ids.insp }), // no summary -> undated stub
      item(inc.id, { notice_id: ids.no }),
      item(inc.id, { maintenance_request_id: ids.mr }),
    ];
    const cited = new Map<string, CitedRecordSummary>([
      [`interaction:${ids.ix}`, { event_at: '2026-06-01T02:00:00+00:00', excerpt: 'text' }],
      [`notice:${ids.no}`, { event_at: '2026-05-20T00:00:00+00:00', excerpt: 'cure-or-quit' }],
      [`maintenance_request:${ids.mr}`, { event_at: '2026-04-02T00:00:00+00:00', excerpt: 'leak' }],
    ]);
    const entry = buildIncidentEntries([inc], items, cited)[0];
    if (!entry) throw new Error('expected one entry');
    expect(entry.citations.map((c) => c.type)).toEqual([
      'maintenance_request',
      'notice',
      'interaction',
      'inspection',
    ]);
    const undated = entry.citations[3];
    if (!undated) throw new Error('expected four citations');
    expect(undated.excerpt).toBe('(cited record not available)');
    expect(undated.event_at).toBeNull();
  });

  it('counts recurrence over live same-category incidents in the trailing window only', () => {
    const mar = incident({ occurred_at: '2026-03-03T00:00:00+00:00' });
    const jul = incident({ occurred_at: '2026-07-12T23:04:00+00:00' });
    const dismissed = incident({
      occurred_at: '2026-06-01T00:00:00+00:00',
      deleted_at: '2026-06-02T00:00:00+00:00',
    });
    const otherCategory = incident({ category: 'smoking' });
    const tooOld = incident({ occurred_at: '2025-06-01T00:00:00+00:00' });
    const entries = buildIncidentEntries(
      [tooOld, mar, dismissed, otherCategory, jul],
      [],
      new Map(),
    );
    const julEntry = entries.find((e) => e.incident.id === jul.id);
    if (!julEntry) throw new Error('expected the July incident in the entries');
    // mar + jul count; dismissed is withdrawn testimony, tooOld is outside the
    // window, the other category is a different pattern claim.
    expect(julEntry.recurrence).toEqual({ count: 2, dates: ['2026-03-03', '2026-07-12'] });
  });

  it('makes no recurrence claim for unclassified, dismissed, or first occurrences', () => {
    const unclassified = incident({ category: null });
    const dismissed = incident({ deleted_at: '2026-08-01T00:00:00+00:00' });
    const only = incident({ category: 'harassment' });
    const entries = buildIncidentEntries([unclassified, dismissed, only], [], new Map());
    for (const e of entries) expect(e.recurrence).toBeNull();
  });
});

describe('render seams', () => {
  it('status label: DISMISSED outranks RESOLVED and carries the stamp', () => {
    expect(
      incidentStatusLabel(
        incident({
          resolved_at: '2026-08-01T00:00:00+00:00',
          deleted_at: '2026-08-02T00:00:00+00:00',
        }),
      ),
    ).toBe('DISMISSED 2026-08-02T00:00:00+00:00');
    expect(incidentStatusLabel(incident({}))).toBe('OPEN');
  });

  it('contemporaneity suffix appears only past the 5-minute tolerance', () => {
    expect(incidentRecordedSuffix(incident({}))).toBe(''); // 2-minute gap
    expect(
      incidentRecordedSuffix(incident({ created_at: '2026-07-13T09:00:00+00:00' })),
    ).toContain('recorded 2026-07-13T09:00:00+00:00');
  });

  it('recurrence line uses ordinals and elides beyond 12 dates', () => {
    expect(incidentRecurrenceLine({ count: 3, dates: ['2026-03-03', '2026-07-12'] })).toMatch(
      /^3rd same-category incident in trailing 12 months: 2026-03-03, 2026-07-12$/,
    );
    const many = Array.from({ length: 14 }, (_, i) => `2026-01-${String(i + 1).padStart(2, '0')}`);
    expect(incidentRecurrenceLine({ count: 14, dates: many })).toContain(', +2 more');
  });

  it('citation line marks unlinked citations instead of hiding them', () => {
    const line = incidentCitationLine({
      item_id: 'i',
      type: 'interaction',
      cited_id: 'x',
      event_at: '2026-07-12T23:04:00+00:00',
      excerpt: 'the bass is insane again',
      linked_at: '2026-07-12T23:06:00+00:00',
      unlinked_at: '2026-08-01T10:00:00+00:00',
    });
    expect(line).toContain('[UNLINKED 2026-08-01]');
    expect(line).toContain('(linked 2026-07-12)');
  });
});
