import { ApiError } from '../_lib/error';

// Reject incoherent corrections as 400s before the database enforces the same invariant.
export function assertCoherentShape(row: {
  kind: string;
  channel: string;
  direction: string;
  party_type: string;
  party_id: unknown;
  party_label: unknown;
}): void {
  if (row.kind === 'agent_event') {
    if (
      row.channel !== 'agent_event' ||
      row.direction !== 'none' ||
      row.party_type !== 'none' ||
      row.party_id !== null ||
      row.party_label !== null
    ) {
      throw new ApiError(
        400,
        'invalid_request',
        'an agent_event correction cannot change the event shape (channel/direction/party fields)',
      );
    }
    return;
  }
  if (row.channel === 'agent_event') {
    throw new ApiError(
      400,
      'invalid_request',
      "channel 'agent_event' is reserved for kind='agent_event'",
    );
  }
  if (row.kind === 'note') {
    // A note may gain party context while retaining its note channel/direction.
    if (row.channel !== 'note' || row.direction !== 'none') {
      throw new ApiError(
        400,
        'invalid_request',
        'a note correction cannot change channel or direction',
      );
    }
    if (row.party_type === 'unspecified') {
      throw new ApiError(
        400,
        'invalid_request',
        "party_type 'unspecified' is for communications; a note carries a concrete role or none",
      );
    }
    if (row.party_id !== null && (row.party_type === 'none' || row.party_type === undefined)) {
      throw new ApiError(
        400,
        'invalid_request',
        'party_id on a note needs a resolved role (party_type tenant/vendor/inspector/other)',
      );
    }
    return;
  }
  if (row.channel === 'note') {
    throw new ApiError(400, 'invalid_request', "channel 'note' is reserved for kind='note'");
  }
  if (row.party_type === 'none') {
    throw new ApiError(400, 'invalid_request', "party_type 'none' is reserved for kind='note'");
  }
  if (row.direction === 'none' && row.channel !== 'import') {
    throw new ApiError(
      400,
      'invalid_request',
      "direction 'none' is only valid for channel 'import'",
    );
  }
  if (row.party_type === 'unspecified' && row.party_id !== null) {
    throw new ApiError(
      400,
      'invalid_request',
      "party_type 'unspecified' cannot carry a party_id (resolve the role, or clear party_id)",
    );
  }
}

// INVARIANT: Classify fills empty context without replacing facts.
// The database trigger independently enforces this for direct writes.
export function assertClassifyFillOnly(
  original: Record<string, unknown>,
  row: Record<string, unknown>,
): void {
  const fieldError = (f: string, msg: string) =>
    new ApiError(400, 'invalid_request', msg, { fieldErrors: { [f]: [msg] } });

  const nullable = [
    'party_id',
    'party_label',
    'tenancy_id',
    'maintenance_request_id',
    'area_id',
    'work_order_id',
    'vendor_id',
    'references_interaction_id',
  ] as const;
  for (const f of nullable) {
    if (original[f] != null && row[f] !== original[f]) {
      throw fieldError(
        f,
        `classify cannot overwrite ${f} (already set; use correction_kind='amend' to change a recorded value)`,
      );
    }
  }
  // party_type: 'unspecified'/'none' are empty (fillable); a concrete role is locked.
  if (
    original.party_type !== 'unspecified' &&
    original.party_type !== 'none' &&
    row.party_type !== original.party_type
  ) {
    throw fieldError(
      'party_type',
      "classify cannot overwrite party_type (use correction_kind='amend')",
    );
  }
  // direction: 'unspecified'/'none' are empty (fillable); a stated direction is locked.
  if (
    original.direction !== 'unspecified' &&
    original.direction !== 'none' &&
    row.direction !== original.direction
  ) {
    throw fieldError(
      'direction',
      "classify cannot overwrite direction (use correction_kind='amend')",
    );
  }
  // channel is never empty on a communication -> effectively immutable here.
  if (row.channel !== original.channel) {
    throw fieldError('channel', "classify cannot change channel (use correction_kind='amend')");
  }
  // atomic resolve: naming a party_id requires resolving the role too.
  if (row.party_id != null && row.party_type === 'unspecified') {
    throw fieldError(
      'party_type',
      'classify must resolve party_type (tenant/vendor/inspector/other) when setting party_id',
    );
  }
}
