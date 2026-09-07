import { runEvidenceRetention } from './evidence';
import { runMaintenanceJanitors } from './maintenance-janitors';
import { runRentCharges } from './rent-charges';

// The single registry of daily jobs. The API process runs them in-process
// (admin/scheduler.ts, started from index.ts) and `pnpm --filter ./api job
// <name>` runs one by hand. Every job must be idempotent: a delayed, repeated,
// or missed run heals on the next one without double effects.

export interface ScheduledJob {
  name: string;
  /** Daily run time, UTC, "HH:MM". */
  at: string;
  run: () => Promise<unknown>;
  /** A run that completed but should still count as failed (logged, exit 1). */
  failed?: (result: unknown) => boolean;
}

// Erases T so the registry is homogeneous; the registry is the only construction site.
function job<T>(def: {
  name: string;
  at: string;
  run: () => Promise<T>;
  failed?: (result: T) => boolean;
}): ScheduledJob {
  return def as ScheduledJob;
}

export const SCHEDULED_JOBS: readonly ScheduledJob[] = [
  job({ name: 'evidence-retention', at: '03:30', run: () => runEvidenceRetention() }),
  job({ name: 'maintenance-janitors', at: '03:45', run: () => runMaintenanceJanitors() }),
  // 08:00 UTC = early US morning, so an advance-billed charge is waiting when
  // the landlord wakes; date math stays clear of the midnight boundary.
  job({
    name: 'rent-charges',
    at: '08:00',
    run: () => runRentCharges(),
    // Total wipeout while accounts were enabled. Partial failure heals next run.
    failed: (r) => r.accounts_enabled > 0 && r.accounts_processed === 0,
  }),
];

export function findScheduledJob(name: string): ScheduledJob | undefined {
  return SCHEDULED_JOBS.find((j) => j.name === name);
}
