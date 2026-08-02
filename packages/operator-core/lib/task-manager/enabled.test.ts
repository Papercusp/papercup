/**
 * enabled.test.ts — the task-manager master switch (WI-6499, re-pointed WI-6844).
 *
 * The behaviour worth pinning is the FAIL DIRECTION, and it has now been correct
 * in BOTH directions at different times, which is exactly why it needs a test
 * rather than a comment. WI-6499 made it fail CLOSED while the owner had declared
 * the subsystem unready: an unreachable backend must not silently confine and
 * ledger every process on the box. WI-6844 graduated the flag to default-ON as
 * part of the standard release, which inverts the argument — for a SHIPPED
 * subsystem the absence is the outage, and an unenrolled spawn is invisible to
 * the ledger forever because enrolment binds at spawn.
 *
 * So: unknown ⇒ ON. An EXPLICIT `false` is still honoured in every path — the
 * kill-switch has to keep working, and that is the other half of what is pinned
 * here. This is the kind of inversion that survives review because nothing
 * observable changes until the backend is down.
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

  it('FAILS OPEN when the flag backend throws', async () => {
    getFlag.mockRejectedValue(new Error('posthog unreachable'));
    await expect(isTaskManagerEnabled()).resolves.toBe(true);
  });

  it('still honours an EXPLICIT false — the kill-switch survives graduation', async () => {
    getFlag.mockResolvedValue(false);
    await expect(isTaskManagerEnabled()).resolves.toBe(false);
    expect(taskManagerEnabledSync()).toBe(false);
  });

  it('passes the call site through as the distinctId', async () => {
    getFlag.mockResolvedValue(true);
    await isTaskManagerEnabled('routine:task-reconcile');
    expect(getFlag).toHaveBeenCalledWith('papercusp-task-manager', 'routine:task-reconcile');
  });
});

describe('taskManagerEnabledSync', () => {
  // The boot window. A spawn here is enrolled rather than skipped, because an
  // unenrolled spawn can never be adopted later — enrolment binds at spawn.
  it('is true before any resolve has landed', () => {
    expect(taskManagerEnabledSync()).toBe(true);
  });

  it('reflects the last resolved answer, both ways', async () => {
    getFlag.mockResolvedValue(true);
    await isTaskManagerEnabled();
    expect(taskManagerEnabledSync()).toBe(true);

    getFlag.mockResolvedValue(false);
    await isTaskManagerEnabled();
    expect(taskManagerEnabledSync()).toBe(false);
  });

  it('is true after a failed resolve, not stale-false', async () => {
    getFlag.mockResolvedValue(false);
    await isTaskManagerEnabled();
    expect(taskManagerEnabledSync()).toBe(false);

    getFlag.mockRejectedValue(new Error('backend died'));
    await isTaskManagerEnabled();
    expect(taskManagerEnabledSync()).toBe(true);
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
