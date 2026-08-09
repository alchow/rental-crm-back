// Daily Render entry point for automatic rent charges. Exit non-zero on a
// systemic scan failure or when every enabled account fails, so scheduling
// alerts. Log isolated account failures without aborting successful accounts;
// idempotency lets the next run heal them without double-billing.
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
