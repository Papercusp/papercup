import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
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
};

function deps(): SessionEndLeaseReleaseDeps {
  return {
    loadRow: h.loadRow,
    loadProtectedOwners: h.loadProtectedOwners,
    releaseLocks: h.releaseLocks,
    releaseWorkItems: h.releaseWorkItems,
    listTasks: h.listTasks,
    killTask: h.killTask,
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
    resourcesReleased: 1,
  });
  h.releaseWorkItems.mockResolvedValue({ releasedIds: ['EI-1'], claimsCleared: 1 });
  h.listTasks.mockResolvedValue([]);
  h.killTask.mockResolvedValue({ ok: true, taskId: 'unused', action: 'kill' });
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
    h.loadRow.mockResolvedValueOnce({ ...ENDED, ownerHasOpenSession: true });
    await expect(runSessionEndLeaseRelease(77, deps())).resolves.toMatchObject({
      ok: false,
      reason: 'owner-resumed',
    });
    expect(h.loadProtectedOwners).not.toHaveBeenCalled();
    expect(h.releaseLocks).not.toHaveBeenCalled();
    expect(h.releaseWorkItems).not.toHaveBeenCalled();
    expect(h.listTasks).not.toHaveBeenCalled();
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

describe('scheduleSessionEndLeaseRelease', () => {
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
});
