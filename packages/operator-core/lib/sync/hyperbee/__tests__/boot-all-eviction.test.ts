/**
 * boot-all-eviction.test.ts — LAZY_SUBSTRATE_BOOT wiring in boot-all (P-008 /
 * WI-596): access tracking, the v1 fact-gathering boundary (swarmed/peered =
 * pinned), the race-guarded engine eviction, and reboot-on-access.
 *
 * Uses fake handle injection — no PG, no corestore. The harness-registry import
 * is mocked so importing boot-all never touches PG.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _resetHandleMapForTests,
  _resetEvictionTrackingForTests,
  _setHandleForTests,
  _setRebootOnAccessForTests,
  enableSubstrateEvictionTracking,
  evictBootedHarnessEngine,
  gatherBootedHarnessFacts,
  getBootedHarness,
  handleOutboxNotifyForEvictedHarness,
} from '../boot-all';
import type { BootedHarnessHandle } from '../boot';
import type { AdmittedLog } from '../read-merge';
import type { SwarmHandle } from '../swarm';
import { makeFakeBootedHandle } from './fake-booted-handle';
import { RemoteBootedHarnessHandle } from '../remote-booted-harness';

vi.mock('../../../harness-registry', () => ({
  loadHarnessRegistry: async () => ({ projects: [] as Array<{ slug: string; path: string }> }),
}));

function fakeHandle(
  workspaceId: string,
  harnessSlug: string,
  over: { swarm?: SwarmHandle | null; extraPeer?: boolean } = {},
): BootedHarnessHandle {
  const { handle } = makeFakeBootedHandle({ workspaceId, harnessSlug });
  if (over.swarm !== undefined) (handle as { swarm: SwarmHandle | null }).swarm = over.swarm;
  if (over.extraPeer) {
    // Seed a second admitted log so admitted.size > 1 (≥1 remote peer).
    handle.admitted.set('bb'.repeat(32), {} as AdmittedLog);
  }
  return handle;
}

/** A real RemoteBootedHarnessHandle over a stub RPC client — swarm=null and
 *  admitted=∅ by design (the engine lives in the sidecar), which is exactly
 *  the blindness the WI-1544 Leg-D pin must guard against. */
function fakeRemoteHandle(workspaceId: string, harnessSlug: string) {
  const call = vi.fn(async () => ({}) as never);
  const handle = new RemoteBootedHarnessHandle({
    workspaceId,
    harnessSlug,
    storeId: `${workspaceId}::${harnessSlug}`,
    client: { call },
    ownLogKey: 'aa'.repeat(32),
    ownLogLength: 0,
  } as ConstructorParameters<typeof RemoteBootedHarnessHandle>[0]);
  return { handle, call };
}

beforeEach(() => {
  _resetHandleMapForTests();
  _resetEvictionTrackingForTests();
  // Neutralise the reboot-on-access trigger by default so no test accidentally
  // fires a REAL corestore boot. Tests that assert on it override with a spy.
  _setRebootOnAccessForTests(() => {});
});
afterEach(() => {
  _resetHandleMapForTests();
  _resetEvictionTrackingForTests();
});

describe('gatherBootedHarnessFacts (v1 boundary)', () => {
  it('reports a swarmed harness as pinned (never evicted)', () => {
    _setHandleForTests('ws', 'shared', fakeHandle('ws', 'shared', { swarm: {} as SwarmHandle }));
    const facts = gatherBootedHarnessFacts(123);
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({ key: 'ws::shared', pinned: true });
  });

  it('reports a harness with admitted remote peers as hasActivePeer', () => {
    _setHandleForTests('ws', 'peered', fakeHandle('ws', 'peered', { extraPeer: true }));
    const facts = gatherBootedHarnessFacts(123);
    expect(facts[0]).toMatchObject({ key: 'ws::peered', hasActivePeer: true });
  });

  it('a private (swarm-less, peerless) harness is an eviction candidate (not pinned, no peer)', () => {
    _setHandleForTests('ws', 'private', fakeHandle('ws', 'private'));
    const facts = gatherBootedHarnessFacts(123);
    expect(facts[0]).toMatchObject({ key: 'ws::private', pinned: false, hasActivePeer: false });
  });

  it('defaults lastAccessMs to `now` for an untracked handle (treated HOT)', () => {
    _setHandleForTests('ws', 'p', fakeHandle('ws', 'p'));
    expect(gatherBootedHarnessFacts(999).find((f) => f.key === 'ws::p')!.lastAccessMs).toBe(999);
  });

  it('pins a RELOCATED (sidecar) handle even though its swarm/admitted proxies read inert (WI-1544 Leg D)', () => {
    const { handle } = fakeRemoteHandle('ws', 'relocated');
    // The proxy really is blind — that is the hazard under test.
    expect(handle.swarm).toBeNull();
    expect(handle.admitted.size).toBe(0);
    _setHandleForTests('ws', 'relocated', handle);
    const facts = gatherBootedHarnessFacts(123);
    expect(facts[0]).toMatchObject({ key: 'ws::relocated', pinned: true });
  });
});

describe('access tracking via getBootedHarness', () => {
  it('bumps lastAccess when tracking is ON (so a recent access reads back, not the now-default)', () => {
    enableSubstrateEvictionTracking();
    _setHandleForTests('ws', 'p', fakeHandle('ws', 'p'));
    getBootedHarness('ws', 'p'); // bump to real Date.now()
    // Pass now=0; a tracked handle reads its (large) real bump time, not 0.
    const f = gatherBootedHarnessFacts(0).find((x) => x.key === 'ws::p')!;
    expect(f.lastAccessMs).toBeGreaterThan(0);
  });

  it('does NOT bump lastAccess when tracking is OFF (byte-identical OFF path)', () => {
    _setHandleForTests('ws', 'p', fakeHandle('ws', 'p'));
    getBootedHarness('ws', 'p');
    expect(gatherBootedHarnessFacts(0).find((x) => x.key === 'ws::p')!.lastAccessMs).toBe(0);
  });
});

describe('evictBootedHarnessEngine (race-guarded)', () => {
  it('evicts an idle private engine (close called, removed from map)', async () => {
    enableSubstrateEvictionTracking();
    const handle = fakeHandle('ws', 'private');
    _setHandleForTests('ws', 'private', handle);
    const did = await evictBootedHarnessEngine('ws::private', { now: 2_000_000, idleMs: 1000 });
    expect(did).toBe(true);
    expect(handle.close).toHaveBeenCalledOnce();
    expect(getBootedHarness('ws', 'private')).toBeNull();
  });

  it('SKIPS a harness that gained a swarm since the snapshot (v1 boundary)', async () => {
    enableSubstrateEvictionTracking();
    const handle = fakeHandle('ws', 'shared', { swarm: {} as SwarmHandle });
    _setHandleForTests('ws', 'shared', handle);
    const did = await evictBootedHarnessEngine('ws::shared', { now: 2_000_000, idleMs: 1000 });
    expect(did).toBe(false);
    expect(handle.close).not.toHaveBeenCalled();
  });

  it('SKIPS a harness with admitted remote peers', async () => {
    enableSubstrateEvictionTracking();
    const handle = fakeHandle('ws', 'peered', { extraPeer: true });
    _setHandleForTests('ws', 'peered', handle);
    const did = await evictBootedHarnessEngine('ws::peered', { now: 2_000_000, idleMs: 1000 });
    expect(did).toBe(false);
    expect(handle.close).not.toHaveBeenCalled();
  });

  it('SKIPS a harness that got hot since the snapshot (freshness re-check closes the race)', async () => {
    enableSubstrateEvictionTracking();
    const handle = fakeHandle('ws', 'p');
    _setHandleForTests('ws', 'p', handle);
    getBootedHarness('ws', 'p'); // bumps lastAccess to ~Date.now()
    // Evict with now ≈ the access time + a large idle window → still hot → skip.
    const did = await evictBootedHarnessEngine('ws::p', { now: Date.now(), idleMs: 60 * 60_000 });
    expect(did).toBe(false);
    expect(handle.close).not.toHaveBeenCalled();
  });

  it('returns false for an unknown key', async () => {
    enableSubstrateEvictionTracking();
    expect(await evictBootedHarnessEngine('ws::nope', { now: 1, idleMs: 1 })).toBe(false);
  });

  it('NEVER evicts a relocated (sidecar) handle, however idle it looks (WI-1544 Leg D)', async () => {
    enableSubstrateEvictionTracking();
    const { handle, call } = fakeRemoteHandle('ws', 'relocated');
    _setHandleForTests('ws', 'relocated', handle);
    // Way past any idle window, swarm=null, admitted=∅ — pre-fix this evicted the
    // live sidecar engine via substrate:closeStore and blacked out federation.
    const did = await evictBootedHarnessEngine('ws::relocated', { now: 2_000_000, idleMs: 1000 });
    expect(did).toBe(false);
    expect(call).not.toHaveBeenCalled(); // no substrate:closeStore RPC
    expect(getBootedHarness('ws', 'relocated')).toBe(handle); // still resident
  });
});

describe('reboot-on-access', () => {
  it('fires a background re-boot on the next access to an evicted engine, then clears the mark', async () => {
    enableSubstrateEvictionTracking();
    const reboot = vi.fn();
    _setRebootOnAccessForTests(reboot);
    const handle = fakeHandle('ws', 'private');
    _setHandleForTests('ws', 'private', handle);

    await evictBootedHarnessEngine('ws::private', { now: 2_000_000, idleMs: 1000 });
    expect(getBootedHarness('ws', 'private')).toBeNull(); // still null this access
    expect(reboot).toHaveBeenCalledExactlyOnceWith('ws', 'private');

    // Second access does NOT re-fire (the mark was cleared by the first).
    getBootedHarness('ws', 'private');
    expect(reboot).toHaveBeenCalledOnce();
  });

  it('does NOT reboot-on-access when tracking is OFF', async () => {
    // Evict while tracking is on so the key is marked evicted...
    enableSubstrateEvictionTracking();
    const reboot = vi.fn();
    _setRebootOnAccessForTests(reboot);
    _setHandleForTests('ws', 'p', fakeHandle('ws', 'p'));
    await evictBootedHarnessEngine('ws::p', { now: 2_000_000, idleMs: 1000 });
    // ...then turn tracking off; a later access must not reboot.
    _resetEvictionTrackingForTests();
    _setRebootOnAccessForTests(reboot);
    expect(getBootedHarness('ws', 'p')).toBeNull();
    expect(reboot).not.toHaveBeenCalled();
  });
});

describe('handleOutboxNotifyForEvictedHarness (re-boot-on-NOTIFY, AC#2)', () => {
  it('fires reboot-on-access when called for an evicted harness', async () => {
    enableSubstrateEvictionTracking();
    const reboot = vi.fn();
    _setRebootOnAccessForTests(reboot);
    _setHandleForTests('ws', 'private', fakeHandle('ws', 'private'));

    await evictBootedHarnessEngine('ws::private', { now: 2_000_000, idleMs: 1000 });
    handleOutboxNotifyForEvictedHarness('ws', 'private');
    expect(reboot).toHaveBeenCalledExactlyOnceWith('ws', 'private');
  });

  it('clears the evicted mark so a second NOTIFY does NOT re-fire', async () => {
    enableSubstrateEvictionTracking();
    const reboot = vi.fn();
    _setRebootOnAccessForTests(reboot);
    _setHandleForTests('ws', 'private', fakeHandle('ws', 'private'));

    await evictBootedHarnessEngine('ws::private', { now: 2_000_000, idleMs: 1000 });
    handleOutboxNotifyForEvictedHarness('ws', 'private');
    handleOutboxNotifyForEvictedHarness('ws', 'private'); // second NOTIFY
    expect(reboot).toHaveBeenCalledOnce(); // exactly once, not twice
  });

  it('is a no-op when the harness is currently booted (resident drain handles it)', () => {
    enableSubstrateEvictionTracking();
    const reboot = vi.fn();
    _setRebootOnAccessForTests(reboot);
    // Harness is IN the handle map (currently booted) — must not trigger re-boot.
    _setHandleForTests('ws', 'present', fakeHandle('ws', 'present'));
    handleOutboxNotifyForEvictedHarness('ws', 'present');
    expect(reboot).not.toHaveBeenCalled();
  });

  it('is a no-op when eviction tracking is OFF (flag-OFF path)', () => {
    // Do NOT call enableSubstrateEvictionTracking() — tracking stays off.
    const reboot = vi.fn();
    _setRebootOnAccessForTests(reboot);
    handleOutboxNotifyForEvictedHarness('ws', 'whatever');
    expect(reboot).not.toHaveBeenCalled();
  });

  it('is a no-op for a key that was never evicted (paranoid guard)', () => {
    enableSubstrateEvictionTracking();
    const reboot = vi.fn();
    _setRebootOnAccessForTests(reboot);
    // Key is not in handles and not in evicted.
    handleOutboxNotifyForEvictedHarness('ws', 'never-evicted');
    expect(reboot).not.toHaveBeenCalled();
  });
});
