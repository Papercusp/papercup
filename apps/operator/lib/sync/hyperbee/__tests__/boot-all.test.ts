/**
 * boot-all — substrate orchestrator tests.
 *
 * Uses fake BootedHarnessHandle injection so the tests don't touch the
 * filesystem (corestore / autobase boot is exercised in its own suites).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  _resetHandleMapForTests,
  _setHandleForTests,
  bootAllHarnessesForActiveWorkspace,
  bootSingleHarness,
  closeAllBootedHarnesses,
  closeBootedHarness,
  getBootedHarness,
} from '../boot-all';
import type { BootedHarnessHandle } from '../boot';

function fakeHandle(workspaceId: string, harnessSlug: string): BootedHarnessHandle {
  return {
    workspaceId,
    harnessSlug,
    store: {} as never,
    base: {} as never,
    close: vi.fn(async () => {}),
  };
}

afterEach(async () => {
  await closeAllBootedHarnesses();
  _resetHandleMapForTests();
});

describe('boot-all — substrate orchestrator', () => {
  it('getBootedHarness returns null when not booted', () => {
    expect(getBootedHarness('ws-1', 'papercup')).toBeNull();
  });

  it('_setHandleForTests + getBootedHarness round-trip', () => {
    const h = fakeHandle('ws-1', 'papercup');
    _setHandleForTests('ws-1', 'papercup', h);
    expect(getBootedHarness('ws-1', 'papercup')).toBe(h);
  });

  it('keys (workspace, harness) independently', () => {
    _setHandleForTests('ws-1', 'a', fakeHandle('ws-1', 'a'));
    _setHandleForTests('ws-1', 'b', fakeHandle('ws-1', 'b'));
    _setHandleForTests('ws-2', 'a', fakeHandle('ws-2', 'a'));
    expect(getBootedHarness('ws-1', 'a')).not.toBeNull();
    expect(getBootedHarness('ws-1', 'b')).not.toBeNull();
    expect(getBootedHarness('ws-2', 'a')).not.toBeNull();
    expect(getBootedHarness('ws-3', 'a')).toBeNull();
  });

  it('closeBootedHarness removes + calls close()', async () => {
    const h = fakeHandle('ws-1', 'papercup');
    _setHandleForTests('ws-1', 'papercup', h);
    const removed = await closeBootedHarness('ws-1', 'papercup');
    expect(removed).toBe(true);
    expect(h.close).toHaveBeenCalledOnce();
    expect(getBootedHarness('ws-1', 'papercup')).toBeNull();
  });

  it('closeBootedHarness on missing returns false', async () => {
    expect(await closeBootedHarness('ws-1', 'missing')).toBe(false);
  });

  it('closeAllBootedHarnesses closes every handle', async () => {
    const a = fakeHandle('ws-1', 'a');
    const b = fakeHandle('ws-1', 'b');
    _setHandleForTests('ws-1', 'a', a);
    _setHandleForTests('ws-1', 'b', b);
    const n = await closeAllBootedHarnesses();
    expect(n).toBe(2);
    expect(a.close).toHaveBeenCalledOnce();
    expect(b.close).toHaveBeenCalledOnce();
    expect(getBootedHarness('ws-1', 'a')).toBeNull();
    expect(getBootedHarness('ws-1', 'b')).toBeNull();
  });

  it('bootSingleHarness returns already-booted when cached', async () => {
    _setHandleForTests('ws-1', 'papercup', fakeHandle('ws-1', 'papercup'));
    const result = await bootSingleHarness('ws-1', 'papercup');
    expect(result.state).toBe('already-booted');
  });

  it('bootSingleHarness surfaces boot errors as failed', async () => {
    // No fake handle set, real boot would touch FS — kill it fast via
    // a 1ms timeout. corestore initialisation will fail or hang;
    // either way the timeout race resolves with `failed`.
    const result = await bootSingleHarness('ws-bogus', 'definitely-not-real', {
      workspaceRoot: '/tmp/nonexistent-substrate-boot-test',
      timeoutMs: 1,
    });
    expect(result.state).toBe('failed');
    expect(result.error).toBeTruthy();
    expect(getBootedHarness('ws-bogus', 'definitely-not-real')).toBeNull();
  });

  it('bootAllHarnessesForActiveWorkspace returns 0 attempts for empty workspace list', async () => {
    const result = await bootAllHarnessesForActiveWorkspace({
      workspaceIds: [],
    });
    expect(result.attempted).toBe(0);
    expect(result.booted).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.results).toEqual([]);
  });

  it('bootAllHarnessesForActiveWorkspace skips workspaces with no harnesses dir', async () => {
    const result = await bootAllHarnessesForActiveWorkspace({
      workspaceIds: ['ws-with-no-harnesses-dir-12345'],
    });
    expect(result.attempted).toBe(0);
  });
});
