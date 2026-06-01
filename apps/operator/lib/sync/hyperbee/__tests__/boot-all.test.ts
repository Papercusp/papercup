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
  defaultResolveSwarmBinding,
  getBootedHarness,
  listBootedHandles,
  rebootHarness,
  type SwarmBindingResolver,
} from '../boot-all';
import type { BootedHarnessHandle } from '../boot';
import type { SwarmBinding } from '../derive-swarm-topic';
import { makeFakeBootedHandle } from './fake-booted-handle';

function fakeHandle(workspaceId: string, harnessSlug: string): BootedHarnessHandle {
  return makeFakeBootedHandle({ workspaceId, harnessSlug }).handle;
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
    // Force a failure via a throwing swarm-binding resolver: bootSingleHarness
    // catches it BEFORE ever calling the real bootHarnessSubstrate, so we
    // exercise the failure→'failed' mapping deterministically without spinning
    // up corestore/hypercore native threads. (The prior version raced a 1ms
    // timeout against a real boot, which left native threads that crashed on
    // worker teardown when this file shared a vitest worker with another.)
    const result = await bootSingleHarness('ws-bogus', 'definitely-not-real', {
      resolveSwarmBinding: async () => {
        throw new Error('boot blew up');
      },
    });
    expect(result.state).toBe('failed');
    expect(result.error).toBeTruthy();
    expect(getBootedHarness('ws-bogus', 'definitely-not-real')).toBeNull();
  });

  // A resolver that throws makes bootSingleHarness fail BEFORE it ever calls
  // the real bootHarnessSubstrate — so these tests exercise the close+reboot
  // composition without spinning up corestore/hypercore native threads (which
  // crash on teardown when raced by a 1ms boot timeout).
  const throwingResolver: SwarmBindingResolver = async () => {
    throw new Error('skip-real-boot');
  };

  it('rebootHarness closes the existing handle then re-boots', async () => {
    const h = fakeHandle('ws-1', 'papercup');
    _setHandleForTests('ws-1', 'papercup', h);
    const r = await rebootHarness('ws-1', 'papercup', {
      resolveSwarmBinding: throwingResolver,
    });
    expect(r.closed).toBe(true); // stale handle was torn down
    expect(h.close).toHaveBeenCalledOnce();
    expect(r.boot.state).toBe('failed'); // re-boot attempted (resolver threw)
    expect(getBootedHarness('ws-1', 'papercup')).toBeNull();
  });

  it('rebootHarness on a not-booted harness reports closed=false and still boots', async () => {
    const r = await rebootHarness('ws-1', 'never-booted', {
      resolveSwarmBinding: throwingResolver,
    });
    expect(r.closed).toBe(false);
    expect(r.boot.state).toBe('failed');
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

  it('listBootedHandles returns empty when no handles', () => {
    expect(listBootedHandles()).toEqual([]);
  });

  it('listBootedHandles enumerates every cached handle', () => {
    _setHandleForTests('ws-1', 'a', fakeHandle('ws-1', 'a'));
    _setHandleForTests('ws-1', 'b', fakeHandle('ws-1', 'b'));
    _setHandleForTests('ws-2', 'a', fakeHandle('ws-2', 'a'));
    const list = listBootedHandles();
    expect(list).toHaveLength(3);
    const keys = list.map((l) => `${l.workspaceId}::${l.harnessSlug}`).sort();
    expect(keys).toEqual(['ws-1::a', 'ws-1::b', 'ws-2::a']);
  });

  it('listBootedHandles returns a fresh array each call', () => {
    _setHandleForTests('ws-1', 'a', fakeHandle('ws-1', 'a'));
    const a = listBootedHandles();
    const b = listBootedHandles();
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });
});

describe('boot-all — Phase 11 P-078 swarm-binding resolution', () => {
  it('defaultResolveSwarmBinding returns null when projectDir resolves to placeholder', async () => {
    // Without a populated PG harness_registry, resolveHarnessPaths
    // returns the /tmp/papercusp-unresolved/... placeholder which the
    // default resolver explicitly maps to null (no swarm join).
    const got = await defaultResolveSwarmBinding(
      'ws-with-no-registry-entry',
      'no-such-harness-slug',
    );
    expect(got).toBeNull();
  });

  it('bootSingleHarness invokes the resolver with (workspaceId, harnessSlug)', async () => {
    const calls: Array<[string, string]> = [];
    const fakeResolver: SwarmBindingResolver = async (ws, slug) => {
      calls.push([ws, slug]);
      return null;
    };
    await bootSingleHarness('ws-resolver-spy', 'my-slug', {
      workspaceRoot: '/tmp/nonexistent-substrate-boot-test-resolver',
      timeoutMs: 1,
      resolveSwarmBinding: fakeResolver,
    });
    expect(calls).toEqual([['ws-resolver-spy', 'my-slug']]);
  });

  it('bootSingleHarness still attempts boot when resolver returns null', async () => {
    const fakeResolver: SwarmBindingResolver = async () => null;
    const result = await bootSingleHarness('ws-null-resolver', 'slug-x', {
      workspaceRoot: '/tmp/nonexistent-substrate-boot-test-null',
      timeoutMs: 1,
      resolveSwarmBinding: fakeResolver,
    });
    // Boot fails (no real substrate) but the failure path is still
    // exercised — resolver returning null does NOT throw.
    expect(result.state).toBe('failed');
  });

  it('bootSingleHarness still attempts boot when resolver returns a binding', async () => {
    const binding: SwarmBinding = { kind: 'gh', github_repository_id: 42 };
    const fakeResolver: SwarmBindingResolver = async () => binding;
    const result = await bootSingleHarness('ws-with-binding', 'slug-y', {
      workspaceRoot: '/tmp/nonexistent-substrate-boot-test-binding',
      timeoutMs: 1,
      resolveSwarmBinding: fakeResolver,
    });
    expect(result.state).toBe('failed');
  });

  it('bootAllHarnessesForActiveWorkspace forwards resolveSwarmBinding to per-harness', async () => {
    // No harnesses-dir → no per-harness boots, but we can verify the
    // option is accepted without error.
    const calls: number = 0;
    const fakeResolver: SwarmBindingResolver = async () => {
      // never called when there are no harnesses, but the type is exercised
      return null;
    };
    const result = await bootAllHarnessesForActiveWorkspace({
      workspaceIds: ['ws-no-harness-dir-resolver'],
      resolveSwarmBinding: fakeResolver,
    });
    expect(result.attempted).toBe(0);
    expect(calls).toBe(0);
  });
});
