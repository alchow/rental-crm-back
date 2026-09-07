// Unit spec for the in-process daily scheduler and the job registry.
// No env, no DB: the logger is replaced with a sink.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pino } from 'pino';
import { _setLoggerForTests } from '../src/log';
import { jobStatus, msUntil, runJob, startScheduler } from '../src/admin/scheduler';
import { SCHEDULED_JOBS, type ScheduledJob } from '../src/admin/scheduled-jobs';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

beforeEach(() => {
  _setLoggerForTests(pino({ level: 'silent' }));
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe('msUntil', () => {
  const now = new Date('2026-09-07T10:00:00Z');
  it('later today', () => expect(msUntil('12:30', now)).toBe(2.5 * HOUR));
  it('already passed → tomorrow', () => expect(msUntil('08:00', now)).toBe(22 * HOUR));
  it('exactly now → tomorrow, never 0', () => expect(msUntil('10:00', now)).toBe(DAY));
  it('rejects a bad time', () => expect(() => msUntil('8:00', now)).toThrow(/HH:MM/));
});

describe('runJob', () => {
  it('records ok, a failed() verdict, and a throw', async () => {
    const ok = await runJob({ name: 'a', at: '00:00', run: async () => 1 });
    const bad = await runJob({ name: 'b', at: '00:00', run: async () => 1, failed: () => true });
    const threw = await runJob({ name: 'c', at: '00:00', run: async () => { throw new Error('x'); } });
    expect([ok.ok, bad.ok, threw.ok]).toEqual([true, false, false]);
    expect(jobStatus().a).toEqual(ok);
  });
});

describe('startScheduler', () => {
  it('fires at the job time daily, never overlapping, and stops cleanly', async () => {
    vi.setSystemTime(new Date('2026-09-07T07:59:00Z'));
    let runs = 0;
    let active = 0;
    let maxActive = 0;
    const job: ScheduledJob = {
      name: 'tick',
      at: '08:00',
      run: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 5 * 60_000)); // a slow 5-minute run
        active -= 1;
        runs += 1;
      },
    };
    const stop = startScheduler([job]);
    expect(jobStatus().tick).toBeNull();

    await vi.advanceTimersByTimeAsync(30_000);
    expect(runs).toBe(0);
    await vi.advanceTimersByTimeAsync(DAY); // through 08:00 today and its 5-min run
    expect(runs).toBe(1);
    await vi.advanceTimersByTimeAsync(DAY); // 08:00 tomorrow
    expect(runs).toBe(2);
    expect(maxActive).toBe(1);
    expect(jobStatus().tick?.ok).toBe(true);

    stop();
    await vi.advanceTimersByTimeAsync(2 * DAY);
    expect(runs).toBe(2);
  });
});

describe('SCHEDULED_JOBS registry', () => {
  it('has unique names and valid times', () => {
    const names = SCHEDULED_JOBS.map((j) => j.name);
    expect(new Set(names).size).toBe(names.length);
    for (const j of SCHEDULED_JOBS) expect(() => msUntil(j.at)).not.toThrow();
  });
  it('rent-charges fails only on a total wipeout', () => {
    const failed = SCHEDULED_JOBS.find((j) => j.name === 'rent-charges')!.failed!;
    expect(failed({ accounts_enabled: 3, accounts_processed: 0 })).toBe(true);
    expect(failed({ accounts_enabled: 3, accounts_processed: 1 })).toBe(false);
    expect(failed({ accounts_enabled: 0, accounts_processed: 0 })).toBe(false);
  });
});
