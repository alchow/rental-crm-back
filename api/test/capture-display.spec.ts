import { describe, expect, it } from 'vitest';
import { captureDisplay } from '../src/admin/export-pdf/capture';

describe('export capture labels', () => {
  it('labels a default timestamp as recorded and copied wording as a summary', () => {
    expect(
      captureDisplay({
        occurred_at: 'event',
        logged_at: 'save',
        capture_metadata: {
          method: 'manual',
          time_basis: 'recorded_default',
          text_basis: 'summary',
        },
      }),
    ).toEqual({
      time: 'save',
      timeLabel: 'Recorded',
      description: 'Manually recorded · Landlord summary',
    });
  });
  it('retains supplied event times and source text without claiming provider verification', () => {
    const display = captureDisplay({
      occurred_at: 'event',
      logged_at: 'save',
      capture_metadata: {
        method: 'manual',
        time_basis: 'supplied',
        text_basis: 'source_text',
      },
    });
    expect(display.time).toBe('event');
    expect(display.description).toBe('Manually recorded · Recorded source text');
  });
  it('handles legacy manual maintenance evidence conservatively', () => {
    expect(
      captureDisplay({
        occurred_at: 'event',
        logged_at: 'save',
        maintenance_request_id: 'repair',
        author_type: 'landlord',
        attestation: 'attested',
      }).timeLabel,
    ).toBe('Recorded');
    expect(captureDisplay({ occurred_at: 'event', logged_at: 'save' }).description).toBe('');
  });
});
