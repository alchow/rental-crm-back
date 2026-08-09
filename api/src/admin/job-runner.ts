import { getLogger } from '../log';

// Single-concurrency in-process queue for memory-heavy work. Domain rows own
// job state and must record terminal failures; boot recovery marks rows orphaned
// by restart. Horizontal scale requires a persisted SKIP LOCKED worker, but no
// domain contract change because status already lives on those rows.

let chain: Promise<void> = Promise.resolve();
let pending = 0;

export function enqueue(label: string, fn: () => Promise<void>): void {
  pending += 1;
  const log = getLogger();
  log.info({ event: 'job_queued', label, pending }, 'job queued');
  chain = chain.then(async () => {
    const t0 = performance.now();
    log.info({ event: 'job_started', label }, 'job started');
    try {
      await fn();
      log.info(
        { event: 'job_done', label, ms: Math.round(performance.now() - t0) },
        'job done',
      );
    } catch (err) {
      // The job fn is responsible for marking its own row failed; this log
      // is the operational trace.
      log.error(
        { event: 'job_failed', label, err, ms: Math.round(performance.now() - t0) },
        'job failed',
      );
    } finally {
      pending -= 1;
    }
  });
}

/** Test-only: resolves when every job enqueued so far has finished. */
export function _drainJobsForTests(): Promise<void> {
  return chain;
}
