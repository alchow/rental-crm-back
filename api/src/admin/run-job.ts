// Manual entry point for one registered job:  pnpm --filter ./api job <name>
// Needs the API env (SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY).
import { SCHEDULED_JOBS, findScheduledJob } from './scheduled-jobs';
import { runJob } from './scheduler';

const job = findScheduledJob(process.argv[2] ?? '');
if (!job) {
  console.error(`usage: job <${SCHEDULED_JOBS.map((j) => j.name).join('|')}>`);
  process.exit(2);
}
runJob(job).then((r) => process.exit(r.ok ? 0 : 1));
