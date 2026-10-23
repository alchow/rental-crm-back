export function captureDisplay(entry: Record<string, unknown>) {
  const raw = entry.capture_metadata;
  const facts =
    raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  const manual =
    facts?.method === 'manual' ||
    (!!entry.maintenance_request_id &&
      entry.author_type === 'landlord' &&
      entry.attestation === 'attested');
  const defaultTime =
    facts?.time_basis === 'recorded_default' ||
    (manual && (!facts || facts.time_basis === 'unknown'));
  return {
    time: defaultTime ? entry.logged_at : entry.occurred_at,
    timeLabel: defaultTime ? 'Recorded' : 'Occurred',
    description: [
      manual ? 'Manually recorded' : null,
      manual && (!facts || facts.time_basis === 'unknown')
        ? `Stored event time (source unspecified): ${String(entry.occurred_at)}`
        : null,
      facts?.text_basis === 'summary'
        ? 'Landlord summary'
        : facts?.text_basis === 'source_text'
          ? 'Recorded source text'
          : null,
    ]
      .filter(Boolean)
      .join(' · '),
  };
}
