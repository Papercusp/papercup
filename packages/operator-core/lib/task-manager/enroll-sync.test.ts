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
  absCgroupDir: vi.fn((relative: string) => `/sys/fs/cgroup${relative}`),
  readCgroupProcs: vi.fn<(_abs: string, _fs: unknown) => number[]>(() => []),
  sampleCgroup: vi.fn<(_abs: string, _fs: unknown) => { pidsCurrent: number | null }>(() => ({ pidsCurrent: null })),
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
  absCgroupDir: (...a: unknown[]) => m.absCgroupDir(...(a as [string])),
  readCgroupProcs: (...a: unknown[]) => m.readCgroupProcs(...(a as [string, unknown])),
  sampleCgroup: (...a: unknown[]) => m.sampleCgroup(...(a as [string, unknown])),
  readProcessCgroupPath: () => '/user.slice/user-1000.slice/user@1000.service/papercup-dev-api.service',
}));

import { beginSyncEnrolment, completeSyncEnrolment, finishSyncEnrolment, syncEnrolmentScopePath } from './enroll-sync';

const spec = {
  class: 'bash-job' as const,
  title: 't',
  argv: ['echo'],
  launchedBy: { kind: 'agent' as const, id: 'a' },
};

beforeEach(() => {
  vi.clearAllMocks();
  scopeSupportKnown.mockReturnValue({ ok: true });
  m.readCgroupProcs.mockReturnValue([]);
  m.sampleCgroup.mockReturnValue({ pidsCurrent: null });
  registerTask.mockResolvedValue({});
  markSpawned.mockResolvedValue({});
  closeTask.mockResolvedValue({});
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

  it('D-014: reports flag-off as the reason, ahead of the probe', () => {
    // The flag short-circuits first, so this must say 'flag-off' even though the
    // probe would independently have produced an unconfined spawn too.
    scopeSupportKnown.mockReturnValue(null);
    const e = beginSyncEnrolment({ class: 'bash-job' });
    expect(e.confined).toBe(false);
    expect(e.unconfinedReason).toBe('flag-off');
  });
});

describe('with the task manager ON', () => {
  beforeEach(() => taskManagerEnabledSync.mockReturnValue(true));

  it('enrols and confines when the probe says scopes work', () => {
    const e = beginSyncEnrolment({ class: 'bash-job' });
    expect(e.enrolled).toBe(true);
    expect(e.confined).toBe(true);
    expect(e.unitKind).toBe('service');
    expect(e.scopeUnit).toMatch(/\.service$/);
    expect(e.scopeUnit).toContain(e.taskId);
    expect(e.wrap('/bin/bash', ['-lc', 'x'])).toEqual({
      binary: 'systemd-run',
      argv: [
        '--user',
        '--pipe',
        '--wait',
        '--quiet',
        '--collect',
        `--unit=${e.scopeUnit}`,
        '--slice=papercusp-bash-job.slice',
        '--property=KillMode=control-group',
        '--property=TimeoutStopSec=10s',
        '/bin/bash',
        '-lc',
        'x',
      ],
    });
  });

  it('passes explicit child env to a transient service as sorted setenv flags', () => {
    const e = beginSyncEnrolment({ class: 'bash-job' });
    expect(e.wrap('/bin/bash', ['-lc', 'printf'], { ZED: 'last', EMPTY: '', OMIT: undefined, FOO: 'bar' })).toEqual({
      binary: 'systemd-run',
      argv: [
        '--user',
        '--pipe',
        '--wait',
        '--quiet',
        '--collect',
        `--unit=${e.scopeUnit}`,
        '--slice=papercusp-bash-job.slice',
        '--property=KillMode=control-group',
        '--property=TimeoutStopSec=10s',
        '--setenv=EMPTY=',
        '--setenv=FOO=bar',
        '--setenv=ZED=last',
        '/bin/bash',
        '-lc',
        'printf',
      ],
    });
  });

  it('retains a transient scope for every non-bash sync-enrolled class', () => {
    const e = beginSyncEnrolment({ class: 'sidecar' });
    expect(e.unitKind).toBe('scope');
    expect(e.scopeUnit).toMatch(/\.scope$/);
    expect(e.wrap('/bin/node', ['child.js'])).toEqual({
      binary: 'systemd-run',
      argv: [
        '--user',
        '--scope',
        '--quiet',
        '--collect',
        `--unit=${e.scopeUnit}`,
        '--slice=papercusp-sidecar.slice',
        '/bin/node',
        'child.js',
      ],
    });
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

  /**
   * D-014 (process-lifecycle-no-orphans-2026-08-02). `confined:false` collapses four
   * causes into one boolean. Three are permanent and expected; ONE — 'probe-pending',
   * the first job after boot — is a transient race whose symptom was until now
   * indistinguishable from 'no-scope-support' on a host that can never confine.
   *
   * The pair below is the whole point, and it is the assertion that fails if anyone
   * "simplifies" the reason back to `probe?.ok === true`: a null probe (not landed)
   * and `{ok:false}` (host cannot do scopes) produce the SAME `confined:false` and
   * MUST produce different reasons.
   *
   * This is reporting only. D-014 records that the behaviour is correct and must not
   * be made symmetric — so every case here still asserts `enrolled:true`, i.e. the
   * task is in the ledger and remains reapable.
   */
  describe('D-014: an unconfined task reports WHICH of the four causes produced it', () => {
    it('distinguishes a not-yet-landed probe from a host that cannot make scopes', () => {
      scopeSupportKnown.mockReturnValue(null);
      const pending = beginSyncEnrolment({ class: 'bash-job' });

      scopeSupportKnown.mockReturnValue({ ok: false, reason: 'no systemd' });
      const unsupported = beginSyncEnrolment({ class: 'bash-job' });

      // Identical on the boolean — which is exactly why the reason has to exist.
      expect(pending.confined).toBe(false);
      expect(unsupported.confined).toBe(false);

      expect(pending.unconfinedReason).toBe('probe-pending');
      expect(unsupported.unconfinedReason).toBe('no-scope-support');
      expect(pending.unconfinedReason).not.toBe(unsupported.unconfinedReason);
    });

    it('reports caller-veto ahead of the probe, matching the short-circuit order', () => {
      scopeSupportKnown.mockReturnValue(null);
      const e = beginSyncEnrolment({ class: 'bash-job' }, { confine: false });
      // The probe is ALSO unknown here; the reason must name the condition that
      // actually decided it, not the first true one.
      expect(e.unconfinedReason).toBe('caller-veto');
      expect(e.enrolled).toBe(true);
    });

    it('is null when the task is confined', () => {
      const e = beginSyncEnrolment({ class: 'bash-job' });
      expect(e.confined).toBe(true);
      expect(e.unconfinedReason).toBeNull();
    });
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
    expect(registerTask).toHaveBeenCalledWith(
      spec,
      expect.objectContaining({ reserveScope: true, unitKind: 'service' }),
    );
  });

  it('closes only after the asynchronous registration insert has completed', async () => {
    let releaseRegistration!: () => void;
    const registration = new Promise<void>((resolve) => {
      releaseRegistration = resolve;
    });
    registerTask.mockImplementationOnce(async () => {
      await registration;
      return {};
    });

    const e = beginSyncEnrolment({ class: 'bash-job' });
    completeSyncEnrolment(e, spec as never, 4242);
    finishSyncEnrolment(e, { state: 'exited', exitCode: 0 });

    // Before the INSERT resolves, closeTask must not be able to miss the row.
    expect(closeTask).not.toHaveBeenCalled();

    releaseRegistration();
    await vi.waitFor(() => expect(closeTask).toHaveBeenCalledWith(e.taskId, { state: 'exited', exitCode: 0 }));
    expect(registerTask.mock.invocationCallOrder[0]).toBeLessThan(closeTask.mock.invocationCallOrder[0]!);
  });

  it('logs a bounded diagnostic when fire-and-forget enrolment fails, while remaining fail-open', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    registerTask.mockRejectedValueOnce(new Error('database unavailable'));
    const e = beginSyncEnrolment({ class: 'bash-job' });

    completeSyncEnrolment(e, spec as never, 4242);

    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(`[task-manager] sync enrollment failed for task ${e.taskId}: database unavailable`),
    );
    expect(markSpawned).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('closes the row on finish', () => {
    const e = beginSyncEnrolment({ class: 'bash-job' });
    finishSyncEnrolment(e, { state: 'exited', exitCode: 0 });
    expect(closeTask).toHaveBeenCalledWith(e.taskId, { state: 'exited', exitCode: 0 });
  });

  it('leaves a live row when the confined client exits before its scope payload', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const e = beginSyncEnrolment({ class: 'bash-job' });
    m.readCgroupProcs.mockReturnValue([4242]);

    finishSyncEnrolment(
      e,
      { state: 'exited', exitCode: null, exitReason: 'client signal' },
      { scopeCgroupPath: '/user.slice/papercusp.slice/pc-test.scope' },
    );

    expect(closeTask).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('scope still holds processes'));
    warn.mockRestore();
  });

  it('does not warn when a clean client exit leaves the scope for reconciliation', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const e = beginSyncEnrolment({ class: 'bash-job' });
    m.readCgroupProcs.mockReturnValue([4242]);

    finishSyncEnrolment(
      e,
      { state: 'exited', exitCode: 0 },
      { scopeCgroupPath: '/user.slice/papercusp.slice/pc-test.scope' },
    );

    expect(closeTask).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith(expect.stringContaining('scope still holds processes'));
    warn.mockRestore();
    info.mockRestore();
  });

  it('derives a confined scope path from the operator cgroup, never the client pid', () => {
    const e = beginSyncEnrolment({ class: 'bash-job' });
    expect(syncEnrolmentScopePath(e, 'bash-job')).toBe(
      '/user.slice/user-1000.slice/user@1000.service/papercusp.slice/papercusp-bash.slice/papercusp-bash-job.slice/' +
        `${e.scopeUnit}`,
    );
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
    await vi.waitFor(() => expect(closeTask).toHaveBeenCalledTimes(1));
  });
});
