/**
 * workspace-brain-scope.test.ts — the shared K1 keying logic
 * (workspace-scoped-coordination-2026-06-20 D-006). Pure functions; the flag-read
 * (isWorkspaceCoordinationOn) is integration-covered via its consumers.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const h = vi.hoisted(() => ({
  getFlag: vi.fn(async () => false),
  handlers: [] as Array<(key: string | null) => void>,
}));

vi.mock('@papercusp/flags/server', () => ({
  getFlag: h.getFlag,
  onFlagChange: (handler: (key: string | null) => void) => {
    h.handlers.push(handler);
    return () => {
      const i = h.handlers.indexOf(handler);
      if (i >= 0) h.handlers.splice(i, 1);
    };
  },
}));

import { isWorkspaceCoordinationOn, workspaceBrainScopeKey, workspaceBrainReadKeys } from './workspace-brain-scope';

const WS = 'papercusp-workspace';
const HIVE = 'papercusp';

beforeEach(() => {
  h.getFlag.mockReset();
  h.getFlag.mockResolvedValue(false);
  for (const handler of h.handlers) handler('papercusp-workspace-coordination');
});

describe('isWorkspaceCoordinationOn — sticky topology read', () => {
  it('does not re-read the backend on every caller', async () => {
    h.getFlag.mockResolvedValueOnce(true);
    expect(await isWorkspaceCoordinationOn()).toBe(true);
    h.getFlag.mockResolvedValueOnce(false);
    expect(await isWorkspaceCoordinationOn()).toBe(true);
    expect(h.getFlag).toHaveBeenCalledTimes(1);
  });

  it('does not oscillate to the default when a later backend read would differ', async () => {
    h.getFlag.mockResolvedValueOnce(false);
    expect(await isWorkspaceCoordinationOn()).toBe(false);
    h.getFlag.mockResolvedValueOnce(true);
    expect(await isWorkspaceCoordinationOn()).toBe(false);
    expect(h.getFlag).toHaveBeenCalledTimes(1);
  });

  it('invalidates only on an intentional matching flag change', async () => {
    h.getFlag.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    expect(await isWorkspaceCoordinationOn()).toBe(false);
    for (const handler of h.handlers) handler('papercusp-workspace-coordination');
    expect(await isWorkspaceCoordinationOn()).toBe(true);
    expect(h.getFlag).toHaveBeenCalledTimes(2);
  });
});

/**
 * EI-19455760069884279 — stickiness must apply to RESOLVED values only, never to the error
 * fallback. The `catch` RESOLVES (rather than rejecting) to a fail-closed `false`, so before the
 * fix that `false` was cached exactly like a real read and ONE transient getFlag failure pinned
 * the whole process to legacy per-hive keying until a flag flip or restart — while production is
 * ON. Every test below fails against that old shape, which is what makes them a guard rather than
 * a description.
 */
describe('isWorkspaceCoordinationOn — a FAILED read is never cached', () => {
  it('surfaces the failure instead of pinning silently', async () => {
    // The log is throttled to 5 min PER PROCESS, so this must be the first failing read in the
    // file; the error tests below deliberately assert nothing about the log for that reason.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    h.getFlag.mockRejectedValueOnce(new Error('flag store unreachable'));
    await isWorkspaceCoordinationOn();
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('WORKSPACE_COORDINATION read FAILED'));
    spy.mockRestore();
  });

  it('fails to legacy keying for THAT call, then recovers on the next', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    h.getFlag.mockRejectedValueOnce(new Error('transient'));
    expect(await isWorkspaceCoordinationOn()).toBe(false); // fail-closed, this operation only
    h.getFlag.mockResolvedValueOnce(true);
    expect(await isWorkspaceCoordinationOn()).toBe(true); // NOT pinned — the cache stayed unset
    expect(h.getFlag).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });

  it('keeps retrying while the failure persists', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    h.getFlag.mockRejectedValue(new Error('sustained outage'));
    expect(await isWorkspaceCoordinationOn()).toBe(false);
    expect(await isWorkspaceCoordinationOn()).toBe(false);
    expect(await isWorkspaceCoordinationOn()).toBe(false);
    expect(h.getFlag).toHaveBeenCalledTimes(3);
    spy.mockRestore();
  });

  it('resumes normal stickiness once a read genuinely resolves', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    h.getFlag.mockRejectedValueOnce(new Error('transient'));
    expect(await isWorkspaceCoordinationOn()).toBe(false);
    h.getFlag.mockResolvedValueOnce(true);
    expect(await isWorkspaceCoordinationOn()).toBe(true);
    h.getFlag.mockResolvedValueOnce(false);
    expect(await isWorkspaceCoordinationOn()).toBe(true); // sticky again — the fix is narrow
    expect(h.getFlag).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });
});

describe('workspaceBrainScopeKey (K1 write key)', () => {
  it('OFF → legacy per-hive slug (byte-identical to today)', () => {
    expect(workspaceBrainScopeKey(WS, HIVE, false)).toBe(HIVE);
  });
  it('ON → workspace sentinel (= workspaceId)', () => {
    expect(workspaceBrainScopeKey(WS, HIVE, true)).toBe(WS);
  });
  it('ON → sentinel regardless of which hive emitted it (one row per workspace)', () => {
    expect(workspaceBrainScopeKey(WS, 'other-hive', true)).toBe(WS);
    expect(workspaceBrainScopeKey(WS, 'spreadsheet-hive', true)).toBe(WS);
  });
});

describe('workspaceBrainReadKeys (K1 read-fallback order)', () => {
  it('OFF → only the per-hive row', () => {
    expect(workspaceBrainReadKeys(WS, HIVE, false)).toEqual([HIVE]);
  });
  it('ON → prefer the workspace sentinel, then fall back to the per-hive row', () => {
    expect(workspaceBrainReadKeys(WS, HIVE, true)).toEqual([WS, HIVE]);
  });
  it('ON + workspace==hive shape → de-duplicates to a single key', () => {
    expect(workspaceBrainReadKeys(WS, WS, true)).toEqual([WS]);
  });
  it('ON + no per-hive slug → just the sentinel', () => {
    expect(workspaceBrainReadKeys(WS, '', true)).toEqual([WS]);
  });
  it('OFF + no per-hive slug → empty (nothing to read)', () => {
    expect(workspaceBrainReadKeys(WS, '', false)).toEqual([]);
  });
});
