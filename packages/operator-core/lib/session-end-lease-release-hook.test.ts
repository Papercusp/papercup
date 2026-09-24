import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  partitionReapableTasks,
  runSessionEndLeaseRelease,
  scheduleSessionEndLeaseRelease,
  type SessionEndLeaseReleaseDeps,
  type SessionEndLeaseRow,
} from './session-end-lease-release-hook';
import type { TaskRow } from './task-manager/types';

const ENDED: SessionEndLeaseRow = {
  id: 77,
  workspaceId: 'papercusp-workspace',
  coordOwnerId: 'su-ended',
  sessionId: 'native-session-ended',
  cwd: '/repo',
  endedAt: new Date('2026-08-22T20:01:13Z'),
  ownerHasOpenSession: false,
};

const h = {
  loadRow: vi.fn<NonNullable<SessionEndLeaseReleaseDeps['loadRow']>>(),
  loadProtectedOwners: vi.fn<NonNullable<SessionEndLeaseReleaseDeps['loadProtectedOwners']>>(),
  releaseLocks: vi.fn<NonNullable<SessionEndLeaseReleaseDeps['releaseLocks']>>(),
  releaseWorkItems: vi.fn<NonNullable<SessionEndLeaseReleaseDeps['releaseWorkItems']>>(),
  listTasks: vi.fn<NonNullable<SessionEndLeaseReleaseDeps['listTasks']>>(),
  killTask: vi.fn<NonNullable<SessionEndLeaseReleaseDeps['killTask']>>(),
  closeAdoptedTerminalSessions: vi.fn<NonNullable<SessionEndLeaseReleaseDeps['closeAdoptedTerminalSessions']>>(),
};

function deps(): SessionEndLeaseReleaseDeps {
  return {
    loadRow: h.loadRow,
    loadProtectedOwners: h.loadProtectedOwners,
    releaseLocks: h.releaseLocks,
    releaseWorkItems: h.releaseWorkItems,
    listTasks: h.listTasks,
    killTask: h.killTask,
    closeAdoptedTerminalSessions: h.closeAdoptedTerminalSessions,
  };
}

beforeEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  h.loadRow.mockResolvedValue(ENDED);
  h.loadProtectedOwners.mockResolvedValue(new Set());
  h.releaseLocks.mockResolvedValue({
    released: ['a.ts', 'b.ts'],
    heldBefore: 2,
    crossDomainReleased: [],
    granularReleased: 0,
    resourcesReleased: 1,
  });
  h.releaseWorkItems.mockResolvedValue({ releasedIds: ['EI-1'], claimsCleared: 1 });
  h.listTasks.mockResolvedValue([]);
  h.killTask.mockResolvedValue({ ok: true, taskId: 'unused', action: 'kill' });
  h.closeAdoptedTerminalSessions.mockResolvedValue({ closedTaskIds: [], stillLiveTaskIds: [] });
});

describe('runSessionEndLeaseRelease', () => {
  it('releases every lease only after the tracked owner is ended and unprotected', async () => {
    const result = await runSessionEndLeaseRelease(77, deps());

    expect(h.releaseLocks).toHaveBeenCalledWith({ ownerId: 'su-ended', primaryCoordinationDomain: '/repo' });
    expect(h.releaseWorkItems).toHaveBeenCalledWith('su-ended');
    expect(h.listTasks).toHaveBeenCalledWith({
      workspaceId: 'papercusp-workspace',
      sessionId: 'native-session-ended',
      states: ['pending', 'running'],
      classes: ['agent-session'],
      limit: 2_000,
    });
    expect(result).toMatchObject({
      ok: true,
      ownerId: 'su-ended',
      releasedPaths: ['a.ts', 'b.ts'],
      resourcesReleased: 1,
      releasedWorkItems: ['EI-1'],
      claimsCleared: 1,
      agentSessionTaskIds: [],
      reapedTaskIds: [],
      failedTaskIds: [],
    });
  });

  it('protects a carry/resume successor represented by a newer open session row', async () => {
    h.loadRow.mockResolvedValueOnce({ ...ENDED, ownerHasOpenSession: true, poisoned: true });
    await expect(runSessionEndLeaseRelease(77, deps())).resolves.toMatchObject({
      ok: false,
      reason: 'owner-resumed',
    });
    expect(h.loadProtectedOwners).not.toHaveBeenCalled();
    expect(h.releaseLocks).not.toHaveBeenCalled();
    expect(h.releaseWorkItems).not.toHaveBeenCalled();
    expect(h.listTasks).not.toHaveBeenCalled();
  });

  it('passes the ENDING owner id to the protection loader so its own still-fresh presence row cannot protect it (EI-22651749738479868)', async () => {
    // STALE_MS=600s presence vs a <=60s release-retry span: without this arg the
    // ending owner's own heartbeat reads "owner-live" on every attempt and the
    // lease is never released.
    await expect(runSessionEndLeaseRelease(77, deps())).resolves.toMatchObject({ ok: true });
    expect(h.loadProtectedOwners).toHaveBeenCalledWith('su-ended');
  });

  it('protects a live owner even when the old adv row is ended', async () => {
    h.loadProtectedOwners.mockResolvedValueOnce(new Set(['su-ended']));
    await expect(runSessionEndLeaseRelease(77, deps())).resolves.toMatchObject({
      ok: false,
      reason: 'owner-live',
    });
    expect(h.releaseLocks).not.toHaveBeenCalled();
    expect(h.releaseWorkItems).not.toHaveBeenCalled();
    expect(h.listTasks).not.toHaveBeenCalled();
  });

  it('releases leases for an exact poisoned incarnation despite its stale live-host signal', async () => {
    h.loadRow.mockResolvedValueOnce({ ...ENDED, poisoned: true });
    h.loadProtectedOwners.mockResolvedValueOnce(new Set(['su-ended']));
    await expect(runSessionEndLeaseRelease(77, deps())).resolves.toMatchObject({
      ok: true,
      ownerId: 'su-ended',
      releasedWorkItems: ['EI-1'],
      claimsCleared: 1,
    });
    expect(h.releaseWorkItems).toHaveBeenCalledWith('su-ended');
  });

  it.each([
    ['row-not-found', null],
    ['row-not-ended', { ...ENDED, endedAt: null }],
    ['owner-missing', { ...ENDED, coordOwnerId: null }],
  ] as const)('fails closed on %s', async (reason, row) => {
    h.loadRow.mockResolvedValueOnce(row);
    await expect(runSessionEndLeaseRelease(77, deps())).resolves.toMatchObject({ ok: false, reason });
    expect(h.releaseLocks).not.toHaveBeenCalled();
    expect(h.releaseWorkItems).not.toHaveBeenCalled();
    expect(h.listTasks).not.toHaveBeenCalled();
  });

  it('isolates the two cleanup stores so one failure cannot skip the other', async () => {
    h.releaseLocks.mockRejectedValueOnce(new Error('locks db down'));
    const result = await runSessionEndLeaseRelease(77, deps());

    expect(h.releaseWorkItems).toHaveBeenCalledWith('su-ended');
    expect(result).toMatchObject({
      ok: false,
      reason: 'partial-failure',
      failedEffects: ['locks'],
      releasedWorkItems: ['EI-1'],
      claimsCleared: 1,
    });
  });

  it('reaps every live agent-session task linked to the ended native session', async () => {
    h.listTasks.mockResolvedValue([
      { taskId: 'task-a' } as TaskRow,
      { taskId: 'task-b' } as TaskRow,
    ]);
    h.killTask.mockImplementation(async (taskId) => ({ ok: true, taskId, action: 'kill' }));

    const result = await runSessionEndLeaseRelease(77, deps());

    expect(h.killTask).toHaveBeenCalledTimes(2);
    expect(h.killTask).toHaveBeenNthCalledWith(1, 'task-a', { reapTerminalResidue: true });
    expect(h.killTask).toHaveBeenNthCalledWith(2, 'task-b', { reapTerminalResidue: true });
    expect(result).toMatchObject({
      ok: true,
      agentSessionTaskIds: ['task-a', 'task-b'],
      reapedTaskIds: ['task-a', 'task-b'],
      failedTaskIds: [],
    });
  });

  it('NEVER auto-reaps a terminal-launched session, and reaps its neighbours in the same pass', async () => {
    // ⛔ OWNER RULING (plan terminal-psu-session-enrolment-2026-08-24 D-001, avi
    // 2026-08-24: "Visible only — never auto-reap"). WI-41197 enrols the psu
    // sessions a human started by typing in a terminal so they are VISIBLE and
    // so a person can make a DELIBERATE `processes:kill { taskId }`. This is the
    // ONE automated killer of live agent-session rows, and it must skip them.
    //
    // The stakes are physical, not cosmetic: we do not own a `vte-spawn` scope's
    // lifetime — the terminal window does — so reaping one of these rows closes
    // the owner's window and takes the live agent inside it with it.
    //
    // The mixed list is the point: a blanket "skip when any exempt row is
    // present" would also pass a same-population assertion, so the headless
    // neighbour must still die in the SAME pass.
    h.listTasks.mockResolvedValue([
      { taskId: 'task-headless', detail: { headless: true } } as unknown as TaskRow,
      {
        taskId: 'task-terminal',
        detail: { launchSurface: 'terminal', autoReapExempt: true, supervisorPid: 4242 },
      } as unknown as TaskRow,
    ]);
    h.killTask.mockImplementation(async (taskId) => ({ ok: true, taskId, action: 'kill' }));

    const result = await runSessionEndLeaseRelease(77, deps());

    expect(h.killTask).toHaveBeenCalledTimes(1);
    expect(h.killTask).toHaveBeenCalledWith('task-headless', { reapTerminalResidue: true });
    expect(h.killTask).not.toHaveBeenCalledWith('task-terminal', expect.anything());
    // Reported, not silently dropped: "we skipped one" and "there were none"
    // are different facts, and only one of them proves the exemption ran.
    expect(result).toMatchObject({
      ok: true,
      reapedTaskIds: ['task-headless'],
      exemptTaskIds: ['task-terminal'],
    });
    // Exempt from SIGNALS, not from bookkeeping: the row is still offered for
    // closure, which is what stops every ordinary psu exit becoming a strand.
    expect(h.closeAdoptedTerminalSessions).toHaveBeenCalledWith([
      expect.objectContaining({ taskId: 'task-terminal' }),
    ]);
  });

  it('accounts for per-task failures without skipping lock or work-item cleanup', async () => {
    h.listTasks.mockResolvedValue([
      { taskId: 'task-ok' } as TaskRow,
      { taskId: 'task-failed' } as TaskRow,
      { taskId: 'task-threw' } as TaskRow,
    ]);
    h.killTask
      .mockResolvedValueOnce({ ok: true, taskId: 'task-ok', action: 'kill' })
      .mockResolvedValueOnce({ ok: false, taskId: 'task-failed', action: 'kill', error: 'incomplete' })
      .mockRejectedValueOnce(new Error('systemd unavailable'));

    const result = await runSessionEndLeaseRelease(77, deps());

    expect(h.releaseLocks).toHaveBeenCalledTimes(1);
    expect(h.releaseWorkItems).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      ok: false,
      reason: 'partial-failure',
      failedEffects: ['tasks'],
      agentSessionTaskIds: ['task-ok', 'task-failed', 'task-threw'],
      reapedTaskIds: ['task-ok'],
      failedTaskIds: ['task-failed', 'task-threw'],
    });
  });

  it('accounts for a task-ledger read failure independently of both lease stores', async () => {
    h.listTasks.mockRejectedValueOnce(new Error('task ledger down'));

    const result = await runSessionEndLeaseRelease(77, deps());

    expect(h.releaseLocks).toHaveBeenCalledTimes(1);
    expect(h.releaseWorkItems).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      ok: false,
      reason: 'partial-failure',
      failedEffects: ['tasks'],
      reapedTaskIds: [],
      failedTaskIds: [],
    });
  });
});

/**
 * Falsifiability of the auto-reap exemption, proved the way CLAUDE.md prescribes
 * for "a MODULE / logic you import": a deliberately-wrong implementation kept
 * PERMANENTLY beside the real one as a control, plus a calibration the real
 * subject must pass. Never by mutating this shared tree — git-sync commits the
 * whole working tree on a schedule, so a probe that holds a file mutated for the
 * length of a suite run can have its mutant committed even when nothing goes
 * wrong and no handler fails.
 *
 * Without the control, `partitionReapableTasks` could quietly degrade to "put
 * everything in reapable" and every assertion here that only checks `reapable`
 * would still pass.
 */
describe('partitionReapableTasks — the owner ruling, and proof the guard can fail', () => {
  const terminalRow = {
    taskId: 'task-terminal',
    detail: { launchSurface: 'terminal', autoReapExempt: true },
  } as unknown as TaskRow;
  const headlessRow = { taskId: 'task-headless', detail: { headless: true } } as unknown as TaskRow;
  const noDetailRow = { taskId: 'task-legacy' } as unknown as TaskRow;

  /** The bug this guard exists to prevent: exemption ignored, everything reaped. */
  const WRONG_partition = (rows: readonly TaskRow[]) => ({ reapable: [...rows], exempt: [] as TaskRow[] });

  it('CALIBRATION: the real partition holds an auto-reap-exempt row back', () => {
    const { reapable, exempt } = partitionReapableTasks([headlessRow, terminalRow, noDetailRow]);
    expect(reapable.map((r) => r.taskId)).toEqual(['task-headless', 'task-legacy']);
    expect(exempt.map((r) => r.taskId)).toEqual(['task-terminal']);
  });

  it('CONTROL: the same assertion FAILS against a partition that ignores the exemption', () => {
    const { reapable, exempt } = WRONG_partition([headlessRow, terminalRow, noDetailRow]);
    // Stated as the inverse so this control is itself a passing test: if the
    // real implementation ever degraded to WRONG_partition, the calibration
    // above would go red — which is exactly the falsifiability claim.
    expect(reapable.map((r) => r.taskId)).toContain('task-terminal');
    expect(exempt).toEqual([]);
  });

  it('a row with no detail at all is reapable — absence of the marker is never exemption', () => {
    // Fails OPEN deliberately: every pre-existing headless row predates this
    // feature and carries no marker. Reading "no marker" as "exempt" would
    // silently disable the reaper for the whole fleet.
    expect(partitionReapableTasks([noDetailRow]).exempt).toEqual([]);
    expect(partitionReapableTasks([{ taskId: 'x', detail: {} } as unknown as TaskRow]).exempt).toEqual([]);
  });
});

describe('scheduleSessionEndLeaseRelease', () => {
  it('stops before teardown and joins a running pass without scheduling another retry', async () => {
    vi.useFakeTimers();
    let resolveOwners!: (owners: ReadonlySet<string>) => void;
    h.loadProtectedOwners.mockImplementation(() => new Promise((resolve) => { resolveOwners = resolve; }));
    const job = scheduleSessionEndLeaseRelease(77, { delayMs: 25, retryDelayMs: 25, deps: deps() });
    await vi.advanceTimersByTimeAsync(25);
    let stopped = false;
    const stopping = job.stop().then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);
    resolveOwners(new Set(['su-ended']));
    await stopping;
    await vi.advanceTimersByTimeAsync(200);
    expect(h.loadRow).toHaveBeenCalledTimes(1);
    expect(h.releaseWorkItems).not.toHaveBeenCalled();
  });

  it('can cancel a scheduled pass before it accesses its database', async () => {
    vi.useFakeTimers();
    const job = scheduleSessionEndLeaseRelease(77, { delayMs: 25, deps: deps() });
    await job.stop();
    await vi.advanceTimersByTimeAsync(100);
    expect(h.loadRow).not.toHaveBeenCalled();
  });

  it('leaves a reopened session alone without reporting a cleanup failure', async () => {
    vi.useFakeTimers();
    h.loadRow.mockResolvedValue({ ...ENDED, endedAt: null });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      scheduleSessionEndLeaseRelease(77, { delayMs: 25, retryDelayMs: 25, deps: deps() });
      await vi.advanceTimersByTimeAsync(200);
      expect(h.loadRow).toHaveBeenCalledTimes(1);
      expect(h.releaseLocks).not.toHaveBeenCalled();
      expect(h.releaseWorkItems).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
    } finally { warn.mockRestore(); }
  });

  it('does not run cleanup inline with the tracked end writer', async () => {
    vi.useFakeTimers();
    scheduleSessionEndLeaseRelease(77, { delayMs: 25, deps: deps() });
    expect(h.loadRow).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(24);
    expect(h.loadRow).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.releaseLocks).toHaveBeenCalledTimes(1);
    expect(h.releaseWorkItems).toHaveBeenCalledTimes(1);
  });

  it('retries a transient owner-live result and releases after the owner disappears', async () => {
    vi.useFakeTimers();
    h.loadProtectedOwners
      .mockResolvedValueOnce(new Set(['su-ended']))
      .mockResolvedValueOnce(new Set());

    scheduleSessionEndLeaseRelease(77, { delayMs: 25, retryDelayMs: 25, deps: deps() });
    await vi.advanceTimersByTimeAsync(25);
    expect(h.releaseLocks).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(24);
    expect(h.releaseLocks).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(h.loadProtectedOwners).toHaveBeenCalledTimes(2);
    expect(h.releaseLocks).toHaveBeenCalledTimes(1);
    expect(h.releaseWorkItems).toHaveBeenCalledTimes(1);
  });

  it('bounds repeated owner-live retries and leaves the periodic reaper as backstop', async () => {
    vi.useFakeTimers();
    h.loadProtectedOwners.mockResolvedValue(new Set(['su-ended']));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    scheduleSessionEndLeaseRelease(77, {
      delayMs: 25,
      retryDelayMs: 25,
      maxOwnerLiveRetries: 2,
      deps: deps(),
    });
    await vi.advanceTimersByTimeAsync(25);
    await vi.advanceTimersByTimeAsync(25);
    await vi.advanceTimersByTimeAsync(25);
    await vi.advanceTimersByTimeAsync(100);

    expect(h.loadProtectedOwners).toHaveBeenCalledTimes(3);
    expect(h.releaseLocks).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('periodic lease reaper remains the backstop'));
    warn.mockRestore();
  });
});

describe('markAdvSessionEnded wiring', () => {
  it('schedules the lease cleanup only after the tracked end update succeeds', () => {
    const source = readFileSync(new URL('./adv-sessions.ts', import.meta.url), 'utf8');
    const start = source.indexOf('export async function markAdvSessionEnded');
    const end = source.indexOf('/**\n * Re-activate a tracked session row on RESUME', start);
    const body = source.slice(start, end);
    const successfulUpdate = body.slice(body.indexOf('if (r.length) {'));

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(successfulUpdate).toContain("import('./session-end-lease-release-hook')");
    expect(successfulUpdate).toContain('scheduleSessionEndLeaseRelease(id)');
  });

  it('keeps the delayed lease hook free of an eager work-item module edge', () => {
    const source = readFileSync(new URL('./session-end-lease-release-hook.ts', import.meta.url), 'utf8');

    // work-item-lease-release -> work-items -> … -> adv-sessions closes the
    // dynamic hook edge back into this module. The production dependency must
    // stay lazy so merely importing adv-sessions cannot evaluate this cycle.
    expect(source).not.toContain("from './work-item-lease-release'");
    expect(source).toContain("import('./work-item-lease-release')");
  });
});
