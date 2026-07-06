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

// A tenancy whose active-lease contracted rent no longer agrees with the total
// of its open kind='rent' schedules -- i.e. the billing instruction drifted
// away from the instrument that authorises it. detect_rent_drift surfaces these
// so the daily run can flag them loudly; it never blocks billing.
interface DriftRow {
  o_tenancy_id: string;
  o_lease_id: string;
  o_lease_amount_cents: number;
  o_lease_currency: string;
  o_schedule_total_cents: number;
  o_schedule_currencies: string[];
  o_auto_charge_enabled: boolean;
}

const ACCOUNT_PAGE = 1000;

// Enumerate account ids, paginated. A bare select is capped by PostgREST's
// max-rows (default 1000) and returns the first page with NO error -- for a
// fleet job that would silently skip every account past the cap,
// nondeterministically. Page through with an ordered range until a short page
// proves we've reached the end. `optedInOnly` narrows to the billing set
// (auto_charge_enabled = true); the drift sweep passes false to cover EVERY
// live account. A scan failure is SYSTEMIC (not a per-account miss) and throws.
async function enumerateAccountIds(
  admin: ReturnType<typeof getAdminClient>,
  optedInOnly: boolean,
): Promise<{ id: string }[]> {
  const accounts: { id: string }[] = [];
  for (let from = 0; ; from += ACCOUNT_PAGE) {
    let q = admin.from('accounts').select('id').is('deleted_at', null);
    if (optedInOnly) q = q.eq('auto_charge_enabled', true);
    const { data, error } = await q
      .order('id', { ascending: true })
      .range(from, from + ACCOUNT_PAGE - 1);
    if (error) {
      throw new ApiError(
        500,
        'database_error',
        `${optedInOnly ? 'opt-in account' : 'account'} scan failed: ${error.message}`,
      );
    }
    const page = (data ?? []) as { id: string }[];
    accounts.push(...page);
    if (page.length < ACCOUNT_PAGE) break;
  }
  return accounts;
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

  // Enumerate ALL opted-in accounts (the billing set), paginated to dodge
  // PostgREST's silent max-rows cap -- see enumerateAccountIds.
  const accounts = await enumerateAccountIds(admin, true);

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

  // Drift sweep over EVERY live account (not just the opted-in ones billed
  // above). ADR-0012 calls detect_rent_drift the backstop for whatever bypasses
  // the change-rent verb, so it must also cover accounts that bill MANUALLY:
  // their lease contract can still diverge from their open rent schedules. The
  // urgency differs by mode -- auto-charge drift means WRONG INVOICES are going
  // out, manual drift means a WRONG LEDGER -- so each emitted row carries
  // auto_charge_enabled for operators to rank by. Kept loud-but-not-fatal per
  // account (a per-account RPC error warns as rent_drift_check_failed and the
  // sweep continues); detect_rent_drift is SECURITY INVOKER, and the
  // service-role admin client sees every account. Runs AFTER billing so a slow
  // fleet-wide scan never delays a charge.
  const allAccounts = await enumerateAccountIds(admin, false);
  for (const { id: accountId } of allAccounts) {
    const { data: driftData, error: driftErr } = await admin.rpc('detect_rent_drift', {
      p_account_id: accountId,
    });
    if (driftErr) {
      log.warn(
        { event: 'rent_drift_check_failed', account_id: accountId, err: driftErr.message },
        'rent drift detection failed for account',
      );
      continue;
    }
    const drift = (driftData as DriftRow[] | null) ?? [];
    if (drift.length > 0) {
      log.warn(
        {
          event: 'rent_drift_detected',
          account_id: accountId,
          count: drift.length,
          rows: drift.map((d) => ({
            tenancy_id: d.o_tenancy_id,
            lease_id: d.o_lease_id,
            lease_amount_cents: d.o_lease_amount_cents,
            lease_currency: d.o_lease_currency,
            schedule_total_cents: d.o_schedule_total_cents,
            schedule_currencies: d.o_schedule_currencies,
            auto_charge_enabled: d.o_auto_charge_enabled,
          })),
        },
        'lease rent drifted from open rent schedules',
      );
    }
  }

  log.info(
    { event: 'rent_charges_run_done', ...result, as_of: asOf },
    'rent charge generation pass',
  );
  return result;
}
