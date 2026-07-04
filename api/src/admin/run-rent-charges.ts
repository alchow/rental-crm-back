// Operational entry point for the automatic rent-charge generator
// (admin/rent-charges.ts). Scheduled by the Render cron `rent-charge-generator`
// (render.yaml), which runs daily:
//
//   pnpm --filter ./api charges:generate
//
// Requires the API's env (SUPABASE_URL, SUPABASE_ANON_KEY,
// SUPABASE_SERVICE_ROLE_KEY). Exits non-zero on a SYSTEMIC failure (the opt-in
// account scan itself failing) so the scheduler alerts; per-account failures
// are logged loudly (event: rent_charges_account_failed) and do NOT fail the
// run, because the generator is idempotent — a missed account heals on the next
// daily run without double-billing. Same convention as run-evidence-retention.ts.
import { runRentCharges } from './rent-charges';

runRentCharges()
  .then((result) => {
    console.info(JSON.stringify(result));
    process.exit(0);
  })
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.stack : String(err));
    process.exit(1);
  });
