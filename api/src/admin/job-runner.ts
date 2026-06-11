import { getLogger } from '../log';

// Minimal in-process job runner (architecture plan, Phase 2.1).
//
// CONCURRENCY 1 BY DESIGN: jobs run strictly sequentially on a promise
// chain. The deploy target is a single small instance, and the jobs this
// runs (evidence-export PDF rendering, import recognition) are exactly the
// memory-/CPU-heavy work we just removed from request handlers -- running
// two at once recreates the OOM risk. When the service scales past one
// instance, this module is replaced by a jobs-table worker with
// FOR UPDATE SKIP LOCKED (Phase 3 scale-out ADR); job STATE already lives
// on the domain rows (evidence_exports.status, import_sessions.status), so
// that swap does not change any schema or contract.
//
// Job state is the domain row's responsibility, not the runner's: a job fn
// must itself flip its row to a terminal status on failure (the runner only
// logs). The queue does not survive a restart -- boot-recovery code marks
// orphaned rows failed (see recoverOrphanedEvidenceExports).

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
