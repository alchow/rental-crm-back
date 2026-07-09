// Operational entry point for service-role janitors whose core logic lives in
// SQL RPCs. Scheduled by the Render cron `maintenance-janitors` (render.yaml).
//
//   pnpm --filter ./api janitors:maintenance
//
// Exits non-zero on systemic failures so the scheduler alerts. Per-account
// chain-sweep failures are logged and counted but do not fail the whole run:
// one bad account must not prevent retention/status cleanup for the fleet.
import { runMaintenanceJanitors } from './maintenance-janitors';

runMaintenanceJanitors()
  .then((result) => {
    console.info(JSON.stringify(result));
    process.exit(0);
  })
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.stack : String(err));
    process.exit(1);
  });
