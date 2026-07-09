// Operational entry point for the comms evidence retention janitor
// (admin/evidence.ts). Scheduled by the Render cron `evidence-retention`
// (render.yaml), and still safe to run manually:
//
//   pnpm --filter ./api retention:evidence
//
// Requires the API's env (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, optional
// COMM_EVIDENCE_RETENTION_DAYS). Exits non-zero on failure so the scheduler
// alerts.
import { runEvidenceRetention } from './evidence';

runEvidenceRetention()
  .then((result) => {
    console.info(JSON.stringify(result));
    process.exit(0);
  })
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.stack : String(err));
    process.exit(1);
  });
