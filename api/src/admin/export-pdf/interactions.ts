import type { CastRow } from '../export-pdf';

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
  const byCorrects = new Map(
    rows.filter((r) => r.corrects_id).map((r) => [String(r.corrects_id), r]),
  );
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
// for a role-unknown capture). Empty only for a party-LESS row (party_type
// 'none') — agent_events and notes with no counterparty. A note that names a
// counterparty (campaign-4 §12) carries party_type 'tenant'/'vendor'/… and so
// renders that party here, exactly like any other row.
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
export function interactionCastDisplay(cast: CastRow[], partyNames: Map<string, string>): string {
  if (cast.length === 0) return '';
  const name = (p: CastRow): string => {
    const resolved = p.label ?? (p.party_id ? partyNames.get(p.party_id) : undefined);
    if (resolved && p.address) return `${resolved} (${p.address})`;
    return resolved ?? p.address ?? p.party_type;
  };
  const parts: string[] = [];
  const byRole = (role: string) =>
    cast.filter((p) => p.role === role && p.party_type !== 'platform');
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

// Marker line for a RETRACTED journal row (today only unverified-journal
// receipts are soft-deletable — 20260723000003). The row is INCLUDED in the
// export but renders as this marker alone, never its body/labels: silent
// omission from a legal bundle looks like spoliation, while the stamped
// retraction IS the audit trail — mirroring the "(removed)" inspection-item
// and "(soft-deleted)" tenancy annotations. The content is withheld because
// the entry was withdrawn precisely for its repudiated identity claim.
// Exported for unit testing (mirrors interactionPartyDisplay).
export function retractedInteractionMarker(
  row: Record<string, unknown>,
  userNames: Map<string, string>,
): string {
  const by = row.deleted_by
    ? (userNames.get(String(row.deleted_by)) ?? `user:${String(row.deleted_by)}`)
    : 'unknown';
  const att = row.attestation ? `${String(row.attestation)} entry ` : 'entry ';
  const reason = row.deleted_reason
    ? String(row.deleted_reason).slice(0, 400)
    : 'no reason recorded';
  return `(retracted ${att}— by ${by} on ${String(row.deleted_at)}: ${reason})`;
}
