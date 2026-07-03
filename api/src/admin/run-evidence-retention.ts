// Operational entry point for the comms evidence retention janitor
// (admin/evidence.ts). Scheduled outside the API process (Render cron /
// ops runbook), same convention as prune_inbound_raw's pg_cron schedule:
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
