// Operational entry point for the automatic rent-charge generator
// (admin/rent-charges.ts). Scheduled by the Render cron `rent-charge-generator`
// (render.yaml), which runs daily:
//
//   pnpm --filter ./api charges:generate
//
// Requires the API's env (SUPABASE_URL, SUPABASE_ANON_KEY,
// SUPABASE_SERVICE_ROLE_KEY). Exits non-zero so the scheduler alerts when
// either (a) a SYSTEMIC failure occurs (the opt-in account scan throws) or
// (b) accounts were opted in but NONE could be processed (every per-account
// RPC failed) — a run that billed nobody while billing was enabled is not a
// success. An INDIVIDUAL account failure while others succeed is logged loudly
// (event: rent_charges_account_failed) but does NOT fail the run: the generator
// is idempotent, so a missed account heals on the next daily run without
// double-billing. Same convention as run-evidence-retention.ts.
import { runRentCharges } from './rent-charges';

runRentCharges()
  .then((result) => {
    console.info(JSON.stringify(result));
    // Total wipeout while accounts were enabled → alert (exit 1). A partial
    // failure (some processed) stays exit 0 and heals next run.
    process.exit(result.accounts_enabled > 0 && result.accounts_processed === 0 ? 1 : 0);
  })
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.stack : String(err));
    process.exit(1);
  });
