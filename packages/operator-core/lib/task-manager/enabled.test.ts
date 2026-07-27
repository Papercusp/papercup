/**
 * enabled.test.ts — the task-manager master switch (WI-6499).
 *
 * The behaviour worth pinning is the FAIL DIRECTION. The two call sites this
 * module replaced both did `.catch(() => true)`, so an unreachable flag backend
 * silently turned the whole subsystem on. For a subsystem the owner has declared
 * unready — one that confines and ledgers every spawn on the box — that default is
 * backwards, and it is exactly the kind of inversion that survives review because
 * nothing observable changes until the backend is down.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// vi.hoisted: the mock factory below is hoisted above ordinary `const`s, so the
// state it closes over has to be hoisted too or the factory hits a TDZ error.
const mocks = vi.hoisted(() => ({
  getFlag: vi.fn(),
  changeHandler: null as ((key: string | null) => void) | null,
}));
const { getFlag } = mocks;

vi.mock('@papercusp/flags/server', () => ({
  getFlag: (...a: unknown[]) => mocks.getFlag(...a),
  onFlagChange: (h: (key: string | null) => void) => {
    mocks.changeHandler = h;
    return () => {};
  },
}));

import {
  isTaskManagerEnabled,
  setTaskManagerEnabledForTest,
  taskManagerEnabledSync,
  warmTaskManagerFlag,
} from './enabled';

beforeEach(() => {
  getFlag.mockReset();
  setTaskManagerEnabledForTest(null);
});

describe('isTaskManagerEnabled', () => {
  it('returns the flag value', async () => {
    getFlag.mockResolvedValue(true);
    await expect(isTaskManagerEnabled()).resolves.toBe(true);

    getFlag.mockResolvedValue(false);
    await expect(isTaskManagerEnabled()).resolves.toBe(false);
  });

  it('FAILS CLOSED when the flag backend throws', async () => {
    getFlag.mockRejectedValue(new Error('posthog unreachable'));
    await expect(isTaskManagerEnabled()).resolves.toBe(false);
  });

  it('passes the call site through as the distinctId', async () => {
    getFlag.mockResolvedValue(true);
    await isTaskManagerEnabled('routine:task-reconcile');
    expect(getFlag).toHaveBeenCalledWith('papercusp-task-manager', 'routine:task-reconcile');
  });
});

describe('taskManagerEnabledSync', () => {
  it('is false before any resolve has landed', () => {
    expect(taskManagerEnabledSync()).toBe(false);
  });

  it('reflects the last resolved answer, both ways', async () => {
    getFlag.mockResolvedValue(true);
    await isTaskManagerEnabled();
    expect(taskManagerEnabledSync()).toBe(true);

    getFlag.mockResolvedValue(false);
    await isTaskManagerEnabled();
    expect(taskManagerEnabledSync()).toBe(false);
  });

  it('is false after a failed resolve, not stale-true', async () => {
    getFlag.mockResolvedValue(true);
    await isTaskManagerEnabled();
    expect(taskManagerEnabledSync()).toBe(true);

    getFlag.mockRejectedValue(new Error('backend died'));
    await isTaskManagerEnabled();
    expect(taskManagerEnabledSync()).toBe(false);
  });
});

describe('warmTaskManagerFlag', () => {
  it('coalesces concurrent warms into one backend read', async () => {
    let release: (v: boolean) => void = () => {};
    getFlag.mockReturnValue(new Promise<boolean>((r) => (release = r)));

    warmTaskManagerFlag();
    warmTaskManagerFlag();
    warmTaskManagerFlag();
    expect(getFlag).toHaveBeenCalledTimes(1);

    release(true);
    await vi.waitFor(() => expect(taskManagerEnabledSync()).toBe(true));
  });
});

describe('flag-change invalidation', () => {
  it('re-reads when the task-manager flag flips, so a flip needs no restart', async () => {
    getFlag.mockResolvedValue(true);
    await isTaskManagerEnabled();
    expect(taskManagerEnabledSync()).toBe(true);

    getFlag.mockResolvedValue(false);
    mocks.changeHandler?.('papercusp-task-manager');
    await vi.waitFor(() => expect(taskManagerEnabledSync()).toBe(false));
  });

  it('ignores an unrelated flag change', async () => {
    getFlag.mockResolvedValue(true);
    await isTaskManagerEnabled();
    getFlag.mockClear();

    mocks.changeHandler?.('papercusp-some-other-flag');
    expect(getFlag).not.toHaveBeenCalled();
    expect(taskManagerEnabledSync()).toBe(true);
  });
});
