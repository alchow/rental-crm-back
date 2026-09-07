import { getLogger } from '../log';
import type { ScheduledJob } from './scheduled-jobs';

// In-process daily scheduler. One timer per job, re-armed only after the run
// settles, so a job never overlaps itself. State is memory-only: a restart
// re-arms from the clock and a run lost to a deploy heals on tomorrow's run.
// Render's zero-downtime deploy briefly runs two instances, so a job may fire
// twice that day — every job is idempotent for exactly this reason.

export interface JobRunRecord {
  started_at: string;
  /** null while the run is in progress. */
  ok: boolean | null;
  ms: number | null;
}

/** A run past this is logged as failed and re-armed; the stuck call is left to finish. */
const RUN_DEADLINE_MS = 2 * 3_600_000;

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

function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: NodeJS.Timeout;
  const deadline = new Promise<never>((_, reject) => {
    t = setTimeout(() => reject(new Error(`exceeded ${ms}ms deadline`)), ms);
    t.unref();
  });
  return Promise.race([p, deadline]).finally(() => clearTimeout(t));
}

export async function runJob(job: ScheduledJob): Promise<JobRunRecord> {
  const log = getLogger();
  const t0 = Date.now();
  const record: JobRunRecord = { started_at: new Date(t0).toISOString(), ok: null, ms: null };
  lastRuns.set(job.name, record);
  let err: unknown;
  try {
    const result = await withDeadline(job.run(), RUN_DEADLINE_MS);
    record.ok = !(job.failed?.(result) ?? false);
  } catch (e) {
    err = e;
    record.ok = false;
  }
  record.ms = Date.now() - t0;
  // Each runner logs its own result; this line is the operational trace
  // (alert on event=scheduled_job_failed).
  log[record.ok ? 'info' : 'error'](
    {
      event: record.ok ? 'scheduled_job_done' : 'scheduled_job_failed',
      job: job.name,
      ms: record.ms,
      err,
    },
    `${job.name} ${record.ok ? 'done' : 'failed'}`,
  );
  return record;
}

/** Arms every job's daily timer. The returned stop() resolves once in-flight runs settle. */
export function startScheduler(jobs: readonly ScheduledJob[]): () => Promise<void> {
  const log = getLogger();
  const timers = new Map<string, NodeJS.Timeout>();
  const inflight = new Map<string, Promise<unknown>>();
  let stopped = false;

  const arm = (job: ScheduledJob): void => {
    if (stopped) return;
    // Floor of 1s: a timer can fire a hair early, which would re-arm for "now".
    const t = setTimeout(
      () => {
        inflight.set(
          job.name,
          runJob(job).finally(() => {
            inflight.delete(job.name);
            arm(job);
          }),
        );
      },
      Math.max(msUntil(job.at), 1000),
    );
    t.unref();
    timers.set(job.name, t);
  };

  for (const job of jobs) {
    lastRuns.set(job.name, null);
    arm(job);
    log.info({ event: 'scheduled_job_armed', job: job.name, at: `${job.at}Z` }, 'job scheduled');
  }
  return async () => {
    stopped = true;
    for (const t of timers.values()) clearTimeout(t);
    await Promise.allSettled(inflight.values());
  };
}

/** Last run per registered job (null = not yet run since boot). For /healthz. */
export function jobStatus(): Record<string, JobRunRecord | null> {
  return Object.fromEntries(lastRuns);
}
