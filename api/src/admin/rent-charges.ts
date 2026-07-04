import { getLogger } from '../log';
import { getAdminClient } from './supabase-admin';
import { ApiError } from '../routes/_lib/error';

// ============================================================================
// Automatic rent-charge generator (admin-side, service-role). Migration
// 20260704000001 shipped generate_rent_charges() as an idempotent, opt-in
// generator but deliberately did NOT schedule it (the "define, don't schedule"
// pattern) — this module is the runner that the Render cron
// `rent-charge-generator` invokes daily via `pnpm --filter ./api charges:generate`.
//
// Why admin-side / service-role: generate_rent_charges is SECURITY DEFINER and
// its EXECUTE grant is service-role-only (RLS-bypassing; anon/authenticated are
// revoked). No user JWT is present in a cron context, so the service-role
// client is the only caller that can reach it — the exact same reasoning as the
// evidence-retention janitor (admin/evidence.ts).
//
// Enumeration is OPT-IN ONLY: we bill just the accounts that set
// auto_charge_enabled = true. This is defence-in-depth with the generator,
// which re-checks the SAME flag on every call and returns the empty set for a
// non-opted-in (or missing) account — so even a loose enumeration here (or a
// stray manual RPC elsewhere) can never surprise-bill an account that never
// opted in.
//
// PER-ACCOUNT calls (not one fleet-wide RPC): each generate_rent_charges call
// takes the migration's per-account advisory lock and runs in its own short
// audit-chain transaction, so one account's work never blocks another's and
// each account's hash chain stays contiguous. A single account's failure is
// loud but NOT fatal (same "loud, not fatal" philosophy as evidence.ts's
// per-blob remove): the generator is idempotent, so the next daily run — or a
// manual re-run — heals a transient miss without double-billing. Advance timing
// (the charge is created the day AFTER the current period's due date) gives the
// slack that makes a one-day heal harmless.

export interface RentChargeRunResult {
  /** Accounts with auto_charge_enabled = true (the enumeration set). */
  accounts_enabled: number;
  /** Accounts whose generate_rent_charges call completed without error. */
  accounts_processed: number;
  /** Total charge rows inserted across all accounts this pass. */
  charges_created: number;
  /** Accounts whose call errored (logged as rent_charges_account_failed). */
  failures: number;
}

interface GenRow {
  o_charge_id: string;
  o_schedule_id: string;
  o_period_start: string;
  o_amount_cents: number;
}

/**
 * Generate rent charges for every opted-in account, one per-account RPC at a
 * time. Idempotent and crash-safe by construction (the generator dedupes on
 * ON CONFLICT (source_schedule_id, period_start)), so a retried or overlapping
 * run cannot double-bill. Throws only on a SYSTEMIC failure (the opt-in account
 * scan itself failing) — a per-account failure is logged and the run continues,
 * mirroring the evidence-retention janitor.
 */
export async function runRentCharges(now: Date = new Date()): Promise<RentChargeRunResult> {
  const log = getLogger();
  const admin = getAdminClient();
  const asOf = now.toISOString();

  // Enumerate ALL opted-in accounts, paginated. A bare select is capped by
  // PostgREST's max-rows (default 1000) and returns the first page with NO
  // error -- for a billing job that would silently stop billing every account
  // past the cap, nondeterministically. Page through with an ordered range
  // until a short page proves we've reached the end.
  const PAGE = 1000;
  const accounts: { id: string }[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error: aErr } = await admin
      .from('accounts')
      .select('id')
      .eq('auto_charge_enabled', true)
      .is('deleted_at', null)
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (aErr) {
      throw new ApiError(500, 'database_error', `opt-in account scan failed: ${aErr.message}`);
    }
    const page = (data ?? []) as { id: string }[];
    accounts.push(...page);
    if (page.length < PAGE) break;
  }

  const result: RentChargeRunResult = {
    accounts_enabled: accounts.length,
    accounts_processed: 0,
    charges_created: 0,
    failures: 0,
  };

  for (const row of accounts) {
    const accountId = row.id;
    const { data, error } = await admin.rpc('generate_rent_charges', {
      p_account_id: accountId,
      p_as_of: asOf,
    });
    if (error) {
      // Loud, not fatal: one account must not wedge the whole fleet. The
      // generator is idempotent, so the next run heals a transient miss.
      result.failures += 1;
      log.error(
        { event: 'rent_charges_account_failed', account_id: accountId, err: error.message },
        'rent charge generation failed for account',
      );
      continue;
    }
    const created = ((data as GenRow[] | null) ?? []).length;
    result.accounts_processed += 1;
    result.charges_created += created;
    log.info(
      { event: 'rent_charges_account_done', account_id: accountId, charges_created: created },
      'rent charges generated for account',
    );
  }

  log.info(
    { event: 'rent_charges_run_done', ...result, as_of: asOf },
    'rent charge generation pass',
  );
  return result;
}
