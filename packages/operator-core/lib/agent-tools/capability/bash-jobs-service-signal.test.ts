/**
 * EI-24498234296505540 — a kill requested before a confined job's transient
 * `.service` unit is LIVE must not be lost.
 *
 * Measured incident (green-checkpoint, 2026-09-28 05:15:54 EDT): a user-manager
 * `daemon-reload` held the client's StartTransientUnit for 889ms. The caller's
 * abort arrived inside that window, `systemctl kill` reached no unit, its error
 * was swallowed, and the payload ran to completion while the job read `killed`.
 * On systemd 255 `kill` on a loaded unit whose process has not started yet also
 * exits 0 having signalled nothing, which is why the unit is STOPPED instead.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type ExecFileCallback = (err: Error | null) => void;
const execFileMock = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  execFile: execFileMock,
}));

import { SERVICE_UNIT_SIGNAL_RETRY_DELAYS_MS, signalServiceUnit } from './bash-jobs';

const UNIT = 'pc-0test00service00unit.service';

type Job = { scopeUnit: string | null; exitCode: number | null; endedAt: number | null };
const liveJob = (scopeUnit: string | null = UNIT): Job => ({ scopeUnit, exitCode: null, endedAt: null });

/** Every systemctl invocation that named the unit under test, as argv. */
function unitCalls(): string[][] {
  return execFileMock.mock.calls
    .filter(([file, args]) => file === 'systemctl' && Array.isArray(args) && args.includes(UNIT))
    .map(([, args]) => args as string[]);
}
const stopCalls = () => unitCalls().filter((a) => a.includes('stop'));
const killCalls = () => unitCalls().filter((a) => a.includes('kill'));

/** Answer systemctl the way systemd 255 does: `stop` on a unit that is not loaded exits 5. */
function unitLoadsAfter(refusals: number): void {
  let stopsSeen = 0;
  execFileMock.mockImplementation((file: string, args: string[], _opts: unknown, cb?: ExecFileCallback) => {
    if (file === 'systemctl' && args.includes(UNIT) && args.includes('stop')) {
      stopsSeen += 1;
      cb?.(stopsSeen <= refusals ? Object.assign(new Error(`Unit ${UNIT} not loaded.`), { code: 5 }) : null);
      return;
    }
    cb?.(null);
  });
}

describe('signalServiceUnit — a kill that lands before the unit is live (EI-24498234296505540)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    execFileMock.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('delivers SIGTERM as a non-blocking STOP of the unit, never a bare kill', () => {
    unitLoadsAfter(0);
    signalServiceUnit(liveJob(), 'SIGTERM');

    expect(stopCalls()).toEqual([['--user', '--no-block', 'stop', UNIT]]);
    // A bare `kill` on a loaded unit whose process has not started exits 0 and
    // signals nothing, which is the lost-kill this guards.
    expect(killCalls()).toEqual([]);
  });

  it('re-sends the stop until the unit exists instead of dropping the refusal', () => {
    unitLoadsAfter(2);
    signalServiceUnit(liveJob(), 'SIGTERM');
    expect(stopCalls()).toHaveLength(1);

    vi.advanceTimersByTime(SERVICE_UNIT_SIGNAL_RETRY_DELAYS_MS[0]!);
    expect(stopCalls()).toHaveLength(2);
    vi.advanceTimersByTime(SERVICE_UNIT_SIGNAL_RETRY_DELAYS_MS[1]!);
    expect(stopCalls()).toHaveLength(3);

    // The third attempt succeeded, so nothing further is scheduled.
    vi.advanceTimersByTime(60_000);
    expect(stopCalls()).toHaveLength(3);
  });

  it('stops retrying a SIGTERM once the job has ended (nothing left to signal)', () => {
    unitLoadsAfter(Number.POSITIVE_INFINITY);
    const job = liveJob();
    signalServiceUnit(job, 'SIGTERM');
    expect(stopCalls()).toHaveLength(1);

    job.exitCode = 0;
    job.endedAt = Date.now();
    vi.advanceTimersByTime(60_000);
    expect(stopCalls()).toHaveLength(2); // the retry already scheduled runs once, sees the end, stops
  });

  it('keeps chasing a SIGKILL after the client exits, bounded by the schedule', () => {
    unitLoadsAfter(Number.POSITIVE_INFINITY);
    const job = liveJob();
    signalServiceUnit(job, 'SIGKILL');
    // The caller kills the client's process group alongside; its exit says nothing
    // about a unit that has not started yet.
    job.exitCode = 137;
    job.endedAt = Date.now();

    vi.advanceTimersByTime(120_000);
    const attempts = SERVICE_UNIT_SIGNAL_RETRY_DELAYS_MS.length + 1;
    expect(stopCalls()).toHaveLength(attempts);
    expect(killCalls()).toHaveLength(attempts);
    expect(killCalls()[0]).toEqual(['--user', 'kill', '--signal=SIGKILL', UNIT]);
  });

  it('leaves non-service jobs to the process-group kill', () => {
    unitLoadsAfter(0);
    signalServiceUnit(liveJob('pc-0test00scope.scope'), 'SIGTERM');
    signalServiceUnit(liveJob(null), 'SIGKILL');
    expect(execFileMock).not.toHaveBeenCalledWith('systemctl', expect.anything(), expect.anything(), expect.anything());
  });

  it('keeps the retry schedule long enough to outlast a slow daemon-reload', () => {
    const total = SERVICE_UNIT_SIGNAL_RETRY_DELAYS_MS.reduce((sum, ms) => sum + ms, 0);
    expect(total).toBeGreaterThanOrEqual(20_000);
  });
});
