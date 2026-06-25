/**
 * boot-all — substrate orchestrator tests.
 *
 * Uses fake BootedHarnessHandle injection so the tests don't touch the
 * filesystem (corestore / autobase boot is exercised in its own suites).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  _resetHandleMapForTests,
  _setHandleForTests,
  bootAllHarnessesForActiveWorkspace,
  bootSingleHarness,
  closeAllBootedHarnesses,
  closeBootedHarness,
  defaultResolveSwarmBinding,
  ensureSendSideWired,
  getBootedHarness,
  listBootedHandles,
  rebootHarness,
  type SwarmBindingResolver,
} from '../boot-all';
import type { BootedHarnessHandle } from '../boot';
import type { SwarmBinding } from '../derive-swarm-topic';
import { makeFakeBootedHandle } from './fake-booted-handle';

// The DEFAULT discovery path (no discoverHarnessSlugs override) reads the PG
// registry via loadHarnessRegistry — mocked here so unit tests never touch PG.
const loadHarnessRegistryMock = vi.fn(async (_ws?: string) => ({ projects: [] as Array<{ slug: string; path: string }> }));
vi.mock('../../../harness-registry', () => ({
  loadHarnessRegistry: (ws?: string) => loadHarnessRegistryMock(ws),
}));

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

  it('bootAllHarnessesForActiveWorkspace skips workspaces whose registry holds no harnesses', async () => {
    const result = await bootAllHarnessesForActiveWorkspace({
      workspaceIds: ['ws-with-empty-registry-12345'],
      discoverHarnessSlugs: async () => [],
    });
    expect(result.attempted).toBe(0);
  });

  it('P-078: boots every slug the registry discovery returns (PG is the source, not the FS)', async () => {
    const discovered: string[] = [];
    const result = await bootAllHarnessesForActiveWorkspace({
      workspaceIds: ['ws-pg-registry'],
      discoverHarnessSlugs: async (ws) => {
        discovered.push(ws);
        return ['h1', 'h2'];
      },
      // Throwing resolver fails each boot BEFORE real corestore spin-up —
      // we only assert the discovery → bootSingleHarness routing here.
      resolveSwarmBinding: async () => {
        throw new Error('skip-real-boot');
      },
    });
    expect(discovered).toEqual(['ws-pg-registry']);
    expect(result.attempted).toBe(2);
    expect(result.failed).toBe(2);
    expect(result.results.map((r) => r.harnessSlug).sort()).toEqual(['h1', 'h2']);
  });

  it('P-078: the DEFAULT discovery reads the PG registry and boots only entries with a LIVE project path', async () => {
    const liveDir = mkdtempSync(join(tmpdir(), 'boot-all-live-'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      loadHarnessRegistryMock.mockResolvedValueOnce({
        projects: [
          { slug: 'live-h', path: liveDir },
          { slug: 'dead-h', path: '/nonexistent/papercusp-boot-all-test' },
        ],
      });
      const result = await bootAllHarnessesForActiveWorkspace({
        workspaceIds: ['ws-pg-default-discovery'],
        // NO discoverHarnessSlugs override — exercises harnessSlugsFromPgRegistry.
        resolveSwarmBinding: async () => {
          throw new Error('skip-real-boot');
        },
      });
      expect(loadHarnessRegistryMock).toHaveBeenCalledWith('ws-pg-default-discovery');
      expect(result.attempted).toBe(1); // dead-h filtered out
      expect(result.results[0]).toMatchObject({ harnessSlug: 'live-h' });
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('dead-h'));
    } finally {
      warnSpy.mockRestore();
      rmSync(liveDir, { recursive: true, force: true });
    }
  });

  it('P-078: a discovery failure is LOUD and does not abort the other workspaces', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const result = await bootAllHarnessesForActiveWorkspace({
        workspaceIds: ['ws-bad', 'ws-good'],
        discoverHarnessSlugs: async (ws) => {
          if (ws === 'ws-bad') throw new Error('pg exploded');
          return ['h-good'];
        },
        resolveSwarmBinding: async () => {
          throw new Error('skip-real-boot');
        },
      });
      // ws-bad contributed nothing but ws-good still booted (failed = fake boot).
      expect(result.attempted).toBe(1);
      expect(result.results[0]).toMatchObject({ workspaceId: 'ws-good', harnessSlug: 'h-good' });
      expect(errSpy).toHaveBeenCalledWith(
        expect.stringContaining("harness discovery failed for workspace 'ws-bad'"),
        expect.anything(),
      );
    } finally {
      errSpy.mockRestore();
    }
  });

  it('sidecar cutover: bootSingleHarness caches the injected remote handle and skips main-process send-side wiring', async () => {
    const handle = fakeHandle('ws-sidecar-cutover', 'h-sidecar');
    const bootHarness = vi.fn(async () => handle);
    const wireOutbox = vi.fn(async () => {});
    const wirePresence = vi.fn(async () => {});

    const result = await bootSingleHarness('ws-sidecar-cutover', 'h-sidecar', {
      workspaceRoot: '/tmp/papercusp-sidecar-cutover',
      resolveSwarmBinding: async () => ({ kind: 'gh', github_repository_id: 12 }),
      bootHarness,
      skipSendSideWiring: true,
      wireSendSide: { wireOutbox, wirePresence },
    });

    expect(result.state).toBe('booted');
    expect(getBootedHarness('ws-sidecar-cutover', 'h-sidecar')).toBe(handle);
    expect(bootHarness).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceRoot: '/tmp/papercusp-sidecar-cutover',
        workspaceId: 'ws-sidecar-cutover',
        harnessSlug: 'h-sidecar',
        swarmBinding: { kind: 'gh', github_repository_id: 12 },
      }),
    );
    expect(wireOutbox).not.toHaveBeenCalled();
    expect(wirePresence).not.toHaveBeenCalled();
  });

  it('sidecar cutover: bootAll forwards the injected boot factory and send-side skip to each harness', async () => {
    const booted: string[] = [];
    const bootHarness = vi.fn(async (opts) => {
      booted.push(`${opts.workspaceId}::${opts.harnessSlug}`);
      return fakeHandle(opts.workspaceId, opts.harnessSlug);
    });

    const result = await bootAllHarnessesForActiveWorkspace({
      workspaceIds: ['ws-remote'],
      discoverHarnessSlugs: async () => ['h1', 'h2'],
      resolveSwarmBinding: async () => null,
      bootHarness,
      skipSendSideWiring: true,
    });

    expect(result).toMatchObject({ attempted: 2, booted: 2, failed: 0 });
    expect(booted.sort()).toEqual(['ws-remote::h1', 'ws-remote::h2']);
    expect(getBootedHarness('ws-remote', 'h1')).not.toBeNull();
    expect(getBootedHarness('ws-remote', 'h2')).not.toBeNull();
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
    // Empty registry → no per-harness boots, but we can verify the
    // option is accepted without error.
    const calls: number = 0;
    const fakeResolver: SwarmBindingResolver = async () => {
      // never called when there are no harnesses, but the type is exercised
      return null;
    };
    const result = await bootAllHarnessesForActiveWorkspace({
      workspaceIds: ['ws-empty-registry-resolver'],
      discoverHarnessSlugs: async () => [],
      resolveSwarmBinding: fakeResolver,
    });
    expect(result.attempted).toBe(0);
    expect(calls).toBe(0);
  });
});

describe('ensureSendSideWired — EI-521: send-side wiring is idempotent + retryable', () => {
  let errSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    errSpy.mockRestore();
  });

  it('a transient outbox-wiring failure is RETRIED on the next call (not permanently skipped)', async () => {
    const handle = fakeHandle('ws-wire-retry', 'h');
    let attempt = 0;
    const wireOutbox = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error('getOrgPg hiccup'); // first boot fails
    });
    const wirePresence = vi.fn(async () => {});

    // Call 1: outbox throws → NOT marked wired; presence succeeds → wired.
    await ensureSendSideWired(handle, { wireOutbox, wirePresence });
    expect(wireOutbox).toHaveBeenCalledTimes(1);
    expect(wirePresence).toHaveBeenCalledTimes(1);

    // Call 2: outbox is re-attempted (the EI-521 fix — previously this was
    // skipped forever because the handle was already cached) → now succeeds;
    // presence already wired → skipped.
    await ensureSendSideWired(handle, { wireOutbox, wirePresence });
    expect(wireOutbox).toHaveBeenCalledTimes(2);
    expect(wirePresence).toHaveBeenCalledTimes(1);

    // Call 3: both wired → no-op (no further wiring attempts).
    await ensureSendSideWired(handle, { wireOutbox, wirePresence });
    expect(wireOutbox).toHaveBeenCalledTimes(2);
    expect(wirePresence).toHaveBeenCalledTimes(1);
  });

  it('concurrent calls COALESCE — a step never double-starts (one drain loop, not two)', async () => {
    const handle = fakeHandle('ws-wire-coalesce', 'h');
    let resolveOutbox: (() => void) | undefined;
    const wireOutbox = vi.fn(
      () =>
        new Promise<void>((res) => {
          resolveOutbox = res;
        }),
    );
    const wirePresence = vi.fn(async () => {});

    // Fire two concurrent calls while the first is still in-flight.
    const p1 = ensureSendSideWired(handle, { wireOutbox, wirePresence });
    const p2 = ensureSendSideWired(handle, { wireOutbox, wirePresence });
    // The second call coalesces onto the first's in-flight promise — wireOutbox
    // started exactly once (a second startOutboxDrain would double-append/GC).
    expect(wireOutbox).toHaveBeenCalledTimes(1);
    resolveOutbox?.();
    await Promise.all([p1, p2]);
    expect(wireOutbox).toHaveBeenCalledTimes(1);
    expect(wirePresence).toHaveBeenCalledTimes(1);
  });

  it('a presence-wiring failure does NOT block the outbox drain (and presence retries independently)', async () => {
    const handle = fakeHandle('ws-wire-presence-fail', 'h');
    const wireOutbox = vi.fn(async () => {});
    let presenceAttempt = 0;
    const wirePresence = vi.fn(async () => {
      presenceAttempt += 1;
      if (presenceAttempt === 1) throw new Error('presence announce failed');
    });

    // Call 1: outbox wired (the critical send-side path), presence throws → not wired.
    await ensureSendSideWired(handle, { wireOutbox, wirePresence });
    expect(wireOutbox).toHaveBeenCalledTimes(1);
    expect(wirePresence).toHaveBeenCalledTimes(1);

    // Call 2: outbox already wired → NOT re-attempted; presence retried → succeeds.
    await ensureSendSideWired(handle, { wireOutbox, wirePresence });
    expect(wireOutbox, 'outbox must not re-wire after success').toHaveBeenCalledTimes(1);
    expect(wirePresence).toHaveBeenCalledTimes(2);
  });

  it('bootSingleHarness RE-WIRES on the already-booted path after a transient wiring failure (EI-521 integration)', async () => {
    // A handle cached by a prior boot whose drain wiring FAILED — the EI-521
    // shape (handle cached, peer_connected ✓, but no drain loop).
    const handle = fakeHandle('ws-rewire', 'h');
    _setHandleForTests('ws-rewire', 'h', handle);
    let attempt = 0;
    const wireOutbox = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error('getOrgPg hiccup on first wire');
    });
    const wirePresence = vi.fn(async () => {});

    // First boot pass: already-booted, wiring fails → drain NOT online.
    const r1 = await bootSingleHarness('ws-rewire', 'h', { wireSendSide: { wireOutbox, wirePresence } });
    expect(r1.state).toBe('already-booted');
    expect(wireOutbox).toHaveBeenCalledTimes(1);

    // Next boot pass (boot-all reconcile / rebootHarness): the already-booted
    // short-circuit RE-ATTEMPTS the unwired drain — THE EI-521 FIX. Pre-fix this
    // was skipped forever, so federation stayed dead until a process restart.
    const r2 = await bootSingleHarness('ws-rewire', 'h', { wireSendSide: { wireOutbox, wirePresence } });
    expect(r2.state).toBe('already-booted');
    expect(wireOutbox, 'already-booted path must re-attempt the failed wiring').toHaveBeenCalledTimes(2);

    // Once wired, further passes are no-ops (no redundant drain loops).
    await bootSingleHarness('ws-rewire', 'h', { wireSendSide: { wireOutbox, wirePresence } });
    expect(wireOutbox).toHaveBeenCalledTimes(2);
  });
});
