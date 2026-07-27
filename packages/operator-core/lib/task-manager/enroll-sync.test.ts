/**
 * enroll-sync.test.ts — the flag gate at the spawn chokepoint (WI-6499).
 *
 * This is the seam that matters: `managedSpawn` has no production callers, while
 * `beginSyncEnrolment` is what console-spawn, capability:bash and the orchestrator
 * runner all go through. So "the task manager is off" is TRUE only if it is true
 * here.
 *
 * The assertions are about the OFF path being genuinely inert — no confinement AND
 * no ledger write. A half-gate that skipped confinement but kept writing rows would
 * be worse than no gate: the reconciler is not running to close them, so every
 * spawn would leak a row that stays `running` forever.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// vi.hoisted — the mock factories below are hoisted above ordinary `const`s.
const m = vi.hoisted(() => ({
  taskManagerEnabledSync: vi.fn<() => boolean>(),
  scopeSupportKnown: vi.fn<() => { ok: boolean; reason?: string } | null>(),
  registerTask: vi.fn(async (..._a: unknown[]) => ({})),
  markSpawned: vi.fn(async (..._a: unknown[]) => ({})),
  closeTask: vi.fn(async (..._a: unknown[]) => ({})),
}));
const { taskManagerEnabledSync, scopeSupportKnown, registerTask, markSpawned, closeTask } = m;

vi.mock('./enabled', () => ({ taskManagerEnabledSync: () => m.taskManagerEnabledSync() }));
vi.mock('./managed-spawn', () => ({ scopeSupportKnown: () => m.scopeSupportKnown() }));
vi.mock('./store', () => ({
  registerTask: (...a: unknown[]) => m.registerTask(...a),
  markSpawned: (...a: unknown[]) => m.markSpawned(...a),
  closeTask: (...a: unknown[]) => m.closeTask(...a),
}));
vi.mock('../process-identity', () => ({ readProcessIdentity: () => 'linux:boot:1' }));
vi.mock('./cgroup-read', () => ({
  nodeCgroupFs: {},
  readProcessCgroupPath: () => '/sys/fs/cgroup/x',
}));

import { beginSyncEnrolment, completeSyncEnrolment, finishSyncEnrolment } from './enroll-sync';

const spec = { class: 'bash-job' as const, title: 't', argv: ['echo'], launchedBy: { kind: 'agent' as const, id: 'a' } };

beforeEach(() => {
  vi.clearAllMocks();
  scopeSupportKnown.mockReturnValue({ ok: true });
});

describe('with the task manager OFF', () => {
  beforeEach(() => taskManagerEnabledSync.mockReturnValue(false));

  it('does not enrol and does not confine, even when scopes are available', () => {
    const e = beginSyncEnrolment({ class: 'bash-job' });
    expect(e.enrolled).toBe(false);
    expect(e.confined).toBe(false);
    expect(e.scopeUnit).toBeNull();
  });

  it('leaves argv completely untouched — no systemd-run wrapper', () => {
    const e = beginSyncEnrolment({ class: 'bash-job' });
    expect(e.wrap('/bin/bash', ['-lc', 'echo hi'])).toEqual({ binary: '/bin/bash', argv: ['-lc', 'echo hi'] });
  });

  it('writes NO ledger rows', async () => {
    const e = beginSyncEnrolment({ class: 'bash-job' });
    completeSyncEnrolment(e, spec as never, 4242);
    await vi.waitFor(() => expect(registerTask).not.toHaveBeenCalled());
    expect(markSpawned).not.toHaveBeenCalled();
  });

  it('closes nothing on finish — there is no row to close', () => {
    const e = beginSyncEnrolment({ class: 'bash-job' });
    finishSyncEnrolment(e, { state: 'exited', exitCode: 0 });
    expect(closeTask).not.toHaveBeenCalled();
  });
});

describe('with the task manager ON', () => {
  beforeEach(() => taskManagerEnabledSync.mockReturnValue(true));

  it('enrols and confines when the probe says scopes work', () => {
    const e = beginSyncEnrolment({ class: 'bash-job' });
    expect(e.enrolled).toBe(true);
    expect(e.confined).toBe(true);
    expect(e.scopeUnit).toContain(e.taskId);
    expect(e.wrap('/bin/bash', ['-lc', 'x']).binary).toBe('systemd-run');
  });

  it('still enrols when the host cannot make scopes — unconfined but accounted', () => {
    scopeSupportKnown.mockReturnValue({ ok: false, reason: 'no systemd' });
    const e = beginSyncEnrolment({ class: 'bash-job' });
    expect(e.enrolled).toBe(true);
    expect(e.confined).toBe(false);
  });

  it('still enrols when the probe has not landed yet', () => {
    scopeSupportKnown.mockReturnValue(null);
    const e = beginSyncEnrolment({ class: 'bash-job' });
    expect(e.enrolled).toBe(true);
    expect(e.confined).toBe(false);
  });

  it('honours a caller-side confine:false veto without skipping the ledger', () => {
    const e = beginSyncEnrolment({ class: 'bash-job' }, { confine: false });
    expect(e.enrolled).toBe(true);
    expect(e.confined).toBe(false);
  });

  it('writes the ledger rows', async () => {
    const e = beginSyncEnrolment({ class: 'bash-job' });
    completeSyncEnrolment(e, spec as never, 4242);
    await vi.waitFor(() => expect(registerTask).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(markSpawned).toHaveBeenCalledTimes(1));
  });

  it('closes the row on finish', () => {
    const e = beginSyncEnrolment({ class: 'bash-job' });
    finishSyncEnrolment(e, { state: 'exited', exitCode: 0 });
    expect(closeTask).toHaveBeenCalledWith(e.taskId, { state: 'exited', exitCode: 0 });
  });
});

describe('a flag flip mid-job', () => {
  it('cannot orphan a row — complete/finish follow the enrolment, not the live flag', async () => {
    // Enrolled while ON...
    taskManagerEnabledSync.mockReturnValue(true);
    const e = beginSyncEnrolment({ class: 'bash-job' });
    completeSyncEnrolment(e, spec as never, 1);
    await vi.waitFor(() => expect(registerTask).toHaveBeenCalledTimes(1));

    // ...owner flips OFF while the job is still running. The row exists, so it
    // must still be closed — otherwise it stays `running` forever.
    taskManagerEnabledSync.mockReturnValue(false);
    finishSyncEnrolment(e, { state: 'exited', exitCode: 0 });
    expect(closeTask).toHaveBeenCalledTimes(1);
  });
});
