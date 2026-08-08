/**
 * RECURRENCE GUARD — the substrate boot registry must stay pinned to the REALM,
 * not to this module record.
 *
 * The failure this guards (P-014 / EI-19899917753028359, measured 2026-08-08):
 * bg-host pid 1923950 HELD the papercusp corestore write lock (hyperbee/db/LOCK,
 * fd 164uW) while answering `booted: false` for that exact hive on its own
 * /api/internal/substrate/head-snapshot route — same pid, same instant, two
 * contradictory answers. `boot-all.ts` declared `const handles = new Map()` at
 * module scope, and bg-host evaluates this module twice (its own managed-timers
 * route reports `evaluations: 2` for several ALREADY-PINNED modules). One instance
 * booted the hive and owned the lock; the route read the other instance's empty map.
 *
 * It is self-sustaining, not transient: `getBootedHarness` returns null, fires
 * reboot-on-access, and that re-boot can never take the corestore lock, because its
 * own twin holds it. Downstream the P-019 no-outage sparse release cut refuses and
 * releases keep shipping full history.
 *
 * WHY THIS TEST IS SHAPED THIS WAY. A unit test cannot make the loader evaluate the
 * module twice, so it does the next best thing and reproduces the OBSERVABLE
 * consequence: a SECOND consumer of the same pinned key must see the SAME registry
 * that `getBootedHarness` reads. That is exactly what a duplicate module record is —
 * another holder of that key — so if these two ever diverge, the production bug is
 * back. Asserting "pinModuleState appears in the source" would pass against a
 * hand-rolled globalThis pin and prove nothing about behaviour.
 */
import { describe, expect, it } from 'vitest';
import { pinModuleState } from '@papercusp/module-singleton';
import { getBootedHarness } from './boot-all';
import type { BootedHarnessHandle } from './boot';

const BOOT_REGISTRY_KEY = '@papercusp/operator-core.hyperbeeBootAll';

/** The shape boot-all pins. If its init ever runs here, the key changed — see below. */
function freshRegistry() {
  return {
    handles: new Map<string, BootedHarnessHandle>(),
    inflight: new Map<string, Promise<BootedHarnessHandle>>(),
    lastAccess: new Map<string, number>(),
    evicted: new Set<string>(),
    deferredActivation: new Set<string>(),
    outboxWired: new Set<string>(),
    presenceWired: new Set<string>(),
    wiringInflight: new Map<string, Promise<void>>(),
  };
}

describe('substrate boot registry is realm-pinned', () => {
  it('a SECOND holder of the pinned key sees the same registry getBootedHarness reads', () => {
    // Importing boot-all above already pinned the key, so this call must NOT run its
    // init — it must hand back the registry the module itself is using.
    const asSecondModuleRecord = pinModuleState(BOOT_REGISTRY_KEY, freshRegistry);

    const ws = `ws-pin-guard-${Math.random().toString(36).slice(2)}`;
    const hive = 'papercusp';
    const handle = { workspaceId: ws, harnessSlug: hive } as unknown as BootedHarnessHandle;

    // Write through the SECOND reference — i.e. what the "other" module record would do
    // when it boots the hive and takes the corestore lock.
    asSecondModuleRecord.handles.set(`${ws}::${hive}`, handle);

    // ...and read through the module's own accessor, which is what the head-snapshot
    // route calls. Unpinned, this is `null` — the exact production symptom: booted:false
    // from the very process holding that hive's write lock.
    expect(getBootedHarness(ws, hive)).toBe(handle);

    asSecondModuleRecord.handles.delete(`${ws}::${hive}`);
    expect(getBootedHarness(ws, hive)).toBeNull();
  });

  it('the pinned key is stable — a renamed key silently re-splits the registry', () => {
    // Calibration control: pinning a DIFFERENT key must yield a DIFFERENT, empty
    // registry. Without this, the test above would also pass if pinModuleState were
    // broken into returning one shared object for every key.
    const other = pinModuleState(`${BOOT_REGISTRY_KEY}.not-the-real-key`, freshRegistry);
    const real = pinModuleState(BOOT_REGISTRY_KEY, freshRegistry);
    expect(other).not.toBe(real);
    expect(other.handles.size).toBe(0);
  });
});
