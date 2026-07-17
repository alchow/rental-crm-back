// Premium-subdomain boot sync — reconcile the DB backstop to the config file.
//
// The premium reserved names live in api/src/config/premium-subdomains.json
// (loaded + frozen by routes/_lib/premium-subdomains.ts). The DB backstop
// (public.reserved_subdomain_labels, migration 20260721000001) must mirror the
// file's premium rows so the accounts write-trigger rejects them on the direct
// PostgREST path. This runs at API boot and makes the table follow the file:
//
//   * INSERT any file label missing from the table (a newly reserved name).
//   * DELETE any kind='premium' row NOT in the file (a sold/released name).
//   * NEVER touch kind='ops' rows — those are migration-managed.
//
// Uses the service-role client (hence this module lives in the admin
// quarantine). Idempotent — a second run with no config change is a no-op — and
// safe under concurrent multi-instance boot: inserts use ON CONFLICT DO NOTHING
// and deletes are set-based, so two instances racing converge without error.

import { getAdminClient } from './supabase-admin';
import { getLogger } from '../log';
import { PREMIUM_SUBDOMAINS } from '../routes/_lib/premium-subdomains';

/**
 * Reconcile public.reserved_subdomain_labels' premium rows to PREMIUM_SUBDOMAINS.
 * Resolves with the {inserted, deleted} row counts. Throws on a query error so
 * the caller (the boot wiring) can log a single failure line; a failure leaves
 * the last-synced backstop in place (stale, never wrong) until the next boot.
 */
export async function syncPremiumSubdomainLabels(): Promise<{ inserted: number; deleted: number }> {
  const log = getLogger();
  const admin = getAdminClient();
  const desired = new Set(PREMIUM_SUBDOMAINS);

  // Snapshot the current reserved labels (both kinds — we need ops rows to spot
  // a premium/ops collision, and premium rows to compute the delete set).
  const { data: existingRows, error: readErr } = await admin
    .from('reserved_subdomain_labels')
    .select('label, kind');
  if (readErr) throw new Error(`read reserved_subdomain_labels: ${readErr.message}`);

  const kindByLabel = new Map<string, string>();
  for (const row of existingRows ?? []) kindByLabel.set(row.label, row.kind);

  // Partition the file labels: new (insert), already-premium (skip), or
  // colliding with a NON-premium (ops) row. A collision is a config error —
  // ON CONFLICT DO NOTHING would silently leave it as ops, so surface it and
  // skip the insert rather than flip the kind.
  const insertable: string[] = [];
  const conflicting: string[] = [];
  for (const label of desired) {
    const kind = kindByLabel.get(label);
    if (kind === undefined) insertable.push(label);
    else if (kind !== 'premium') conflicting.push(label);
  }
  if (conflicting.length > 0) {
    log.error(
      { labels: conflicting },
      'premium subdomain sync: config labels collide with non-premium reserved rows — skipped (fix the config or the ops seed)',
    );
  }

  // Premium rows the file no longer reserves — a released/sold name.
  const toDelete = (existingRows ?? [])
    .filter((row) => row.kind === 'premium' && !desired.has(row.label))
    .map((row) => row.label);

  let inserted = 0;
  if (insertable.length > 0) {
    // ON CONFLICT DO NOTHING (ignoreDuplicates) → only genuinely-new rows come
    // back in the representation, so .select() gives the real inserted count and
    // a racing instance's duplicate insert is a harmless no-op.
    const { data, error } = await admin
      .from('reserved_subdomain_labels')
      .upsert(
        insertable.map((label) => ({ label, kind: 'premium' })),
        { onConflict: 'label', ignoreDuplicates: true },
      )
      .select('label');
    if (error) throw new Error(`insert premium labels: ${error.message}`);
    inserted = data?.length ?? 0;
  }

  let deleted = 0;
  if (toDelete.length > 0) {
    // kind='premium' guard makes the delete structurally unable to remove an ops
    // row even if a label somehow appeared under both kinds.
    const { data, error } = await admin
      .from('reserved_subdomain_labels')
      .delete()
      .eq('kind', 'premium')
      .in('label', toDelete)
      .select('label');
    if (error) throw new Error(`delete premium labels: ${error.message}`);
    deleted = data?.length ?? 0;
  }

  log.info({ inserted, deleted }, 'premium subdomain labels synced');
  return { inserted, deleted };
}
