import { getLogger } from '../log';
import type { ScheduledJob } from './scheduled-jobs';

// In-process daily scheduler. One timer per job; the next timer is armed only
// after the current run settles, so a job never overlaps itself. State lives
// in memory only: a restart re-arms from the clock, and a run that fell inside
// a deploy window is simply picked up by tomorrow's (idempotent) run.
// INVARIANT: single API instance. A second instance would double-run every job.

export interface JobRunRecord {
  started_at: string;
  ok: boolean;
  ms: number;
}

const lastRuns = new Map<string, JobRunRecord | null>();

/** Milliseconds until the next UTC occurrence of "HH:MM" (never 0). */
export function msUntil(at: string, now: Date = new Date()): number {
  const m = /^(\d{2}):(\d{2})$/.exec(at);
  if (!m) throw new Error(`bad job time "${at}" (want HH:MM)`);
  const next = new Date(now);
  next.setUTCHours(Number(m[1]), Number(m[2]), 0, 0);
  if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime() - now.getTime();
}

export async function runJob(job: ScheduledJob): Promise<JobRunRecord> {
  const log = getLogger();
  const t0 = Date.now();
  const record: JobRunRecord = { started_at: new Date(t0).toISOString(), ok: false, ms: 0 };
  try {
    const result = await job.run();
    record.ok = !(job.failed?.(result) ?? false);
    record.ms = Date.now() - t0;
    log[record.ok ? 'info' : 'error'](
      { event: record.ok ? 'job_done' : 'job_failed', job: job.name, ms: record.ms, result },
      `${job.name} ${record.ok ? 'done' : 'failed'}`,
    );
  } catch (err) {
    record.ms = Date.now() - t0;
    log.error({ event: 'job_failed', job: job.name, ms: record.ms, err }, `${job.name} threw`);
  }
  lastRuns.set(job.name, record);
  return record;
}

/** Arms every job's daily timer. Returns a stop function for shutdown. */
export function startScheduler(jobs: readonly ScheduledJob[]): () => void {
  const log = getLogger();
  const timers = new Map<string, NodeJS.Timeout>();
  let stopped = false;

  const arm = (job: ScheduledJob): void => {
    if (stopped) return;
    const delay = msUntil(job.at);
    const t = setTimeout(() => {
      void runJob(job).finally(() => arm(job));
    }, delay);
    t.unref();
    timers.set(job.name, t);
  };

  for (const job of jobs) {
    lastRuns.set(job.name, null);
    arm(job);
    log.info({ event: 'job_scheduled', job: job.name, at: `${job.at}Z` }, 'job scheduled');
  }
  return () => {
    stopped = true;
    for (const t of timers.values()) clearTimeout(t);
  };
}

/** Last run per registered job (null = not yet run since boot). For /healthz. */
export function jobStatus(): Record<string, JobRunRecord | null> {
  return Object.fromEntries(lastRuns);
}
