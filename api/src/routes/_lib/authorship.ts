// Authorship-capacity resolution (agent-api plan Workstream A; ADR-0008).
//
// `author_type` is stamped explicitly on every NEW journal write. Legacy
// rows (pre-capacity migration) carry NULL -- their authorship is already
// losslessly encoded in `actor` ('user:<uuid>' | 'tenant:<token_id>' |
// 'system'/'system:<job>' | 'other:<label>'), so the wire contract resolves
// it here instead of backfilling a possibly-false constant into an evidence
// table. The API never emits a null author_type.

export type AuthorType = 'landlord' | 'tenant' | 'agent' | 'system';

export function resolveAuthorType(row: {
  author_type?: string | null;
  actor: string;
}): AuthorType {
  if (
    row.author_type === 'landlord' ||
    row.author_type === 'tenant' ||
    row.author_type === 'agent' ||
    row.author_type === 'system'
  ) {
    return row.author_type;
  }
  // Legacy resolution from the actor prefix. 'other:<label>' rows (manual
  // attributions) resolve to 'system' -- they are not user-JWT writes.
  if (row.actor.startsWith('user:')) return 'landlord';
  if (row.actor.startsWith('tenant:')) return 'tenant';
  if (row.actor.startsWith('agent:')) return 'agent';
  return 'system';
}

/** Resolve in place for a wire response: author_type is never null on the wire. */
export function withResolvedAuthorship<
  T extends { author_type?: string | null; actor: string },
>(row: T): T & { author_type: AuthorType } {
  return { ...row, author_type: resolveAuthorType(row) };
}
