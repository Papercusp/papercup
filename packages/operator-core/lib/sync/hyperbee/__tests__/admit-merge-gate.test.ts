/**
 * admit-merge-gate.test.ts — audit P-022 (EI-115/EI-116 contributor).
 *
 * Three contracts around peer admission:
 *
 *  1. SERIALIZED ADMISSION: an announce arriving while a merge pass is in
 *     flight is queued and drained under the merge gate — the admitted-set is
 *     never mutated mid-pass, and the awaited onAnnounce resolves only after
 *     the admission was actually processed (the coalescing mergeNow re-runs
 *     the pass instead of dropping the request on the floor).
 *  2. 'admitted' EVENT: handle.onAdmitted fires once per newly-admitted remote
 *     log (no 100ms polling), and not again on a duplicate announce.
 *  3. PENDING-RETRY RE-ENTRANCY: the retry loop is a sequential setTimeout
 *     chain — a slow tick can never overlap the next one (the old bare
 *     setInterval(async …) double-processed pending peers).
 */

import { afterEach, describe, expect, it } from 'vitest';
import { generateKeyPairSync, sign as nodeSign } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  bootHarnessSubstrate as bootHarnessSubstrateImpl,
  type BootHarnessOpts,
} from '../boot';
import { buildAnnounce, type SignedAnnounce } from '../announce';
import { _resetCacheForTests } from '../corestore';
import { _clearRegistryForTests } from '../projection';
import { _resetBootHistoryForTests } from '../boot-history';

/**
 * Keep this suite hermetic. Production resolves re-key dependencies
 * fail-closed, but these unit cases exercise the substrate with no real PG.
 * Individual tests can still override this default through the existing seam.
 */
function bootHarnessSubstrate(opts: BootHarnessOpts) {
  return bootHarnessSubstrateImpl({ rekeyDepsOverride: null, ...opts });
}

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length) {
    try {
      await cleanups.pop()!();
    } catch {}
  }
  _resetCacheForTests();
  _clearRegistryForTests();
  _resetBootHistoryForTests();
});

function tmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  });
  return dir;
}

/** Build a VALID signed announce with a freshly-generated Ed25519 keypair. */
async function validAnnounce(logCoreKey: string): Promise<SignedAnnounce> {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const rawPub = (publicKey.export({ type: 'spki', format: 'der' }) as Buffer)
    .subarray(-32)
    .toString('base64');
  const body = {
    device_pubkey: rawPub,
    github_user_id: 4242,
    github_login: 'alice',
    attestation_gist_id: 'gist-test',
    log_core_key: logCoreKey,
  };
  return buildAnnounce(body, async (bytes) => nodeSign(null, bytes, privateKey));
}

describe('admission is serialized with the merge gate (audit P-022)', () => {
  it('an announce mid-merge is queued, drained under the gate, and admitted before the awaited onAnnounce resolves', async () => {
    // applyOverride gate: the first apply BLOCKS until released, pinning the
    // merge pass open while the announce arrives.
    let releaseApply!: () => void;
    const applyGate = new Promise<void>((r) => (releaseApply = r));
    let applies = 0;
    const handle = await bootHarnessSubstrate({
      workspaceRoot: tmpDir('mb-gate-'),
      workspaceId: 'ws-gate-1',
      harnessSlug: 'gate-1',
      mergePollMs: 0,
      pendingRetryMs: 0,
      loadRevokedOverride: async () => new Set(),
      verifyBindingOverride: async () => 'verified',
      applyOverride: async () => {
        applies++;
        if (applies === 1) await applyGate;
        return true;
      },
    });
    cleanups.push(() => handle.close());

    // Give the merge pass real work so it blocks on the apply gate.
    await handle.append({
      type: 'put',
      table: 'perf-rep',
      hbKey: 'k-block',
      value: { v: 1 },
      ts: Date.now(),
      schema_version: 1,
    });
    const mergeInFlight = handle.mergeNow(); // blocks on apply #1

    // While the pass is pinned open: announce a peer. The admission must NOT
    // land mid-pass…
    const logCoreKey = 'ab'.repeat(32);
    const frame = await validAnnounce(logCoreKey);
    const announced = handle.onAnnounce(frame);
    await new Promise((r) => setTimeout(r, 50));
    expect(handle.admitted.has(logCoreKey)).toBe(false); // queued, not raced in

    // …but once the pass releases, the coalesced re-run drains the queue, so
    // the awaited onAnnounce observes its admission complete.
    releaseApply();
    const decision = await announced;
    expect(decision).toEqual({ admit: true });
    expect(handle.admitted.has(logCoreKey)).toBe(true);
    await mergeInFlight;
  });

  it("onAdmitted fires exactly once per newly-admitted peer (and not on a duplicate announce)", async () => {
    const handle = await bootHarnessSubstrate({
      workspaceRoot: tmpDir('mb-evt-'),
      workspaceId: 'ws-evt-1',
      harnessSlug: 'evt-1',
      mergePollMs: 0,
      pendingRetryMs: 0,
      loadRevokedOverride: async () => new Set(),
      verifyBindingOverride: async () => 'verified',
      applyOverride: async () => true,
    });
    cleanups.push(() => handle.close());

    const events: Array<{ logKeyHex: string; admittedSize: number }> = [];
    const off = handle.onAdmitted((info) => events.push(info));

    const logCoreKey = 'cd'.repeat(32);
    const frame = await validAnnounce(logCoreKey);
    await handle.onAnnounce(frame);
    expect(events).toEqual([{ logKeyHex: logCoreKey, admittedSize: 2 }]); // own log + peer

    // A duplicate announce re-records identity but admits nothing new → no event.
    await handle.onAnnounce(frame);
    expect(events).toHaveLength(1);

    // Unsubscribed listeners stop firing.
    off();
    const frame2 = await validAnnounce('ef'.repeat(32));
    await handle.onAnnounce(frame2);
    expect(events).toHaveLength(1);
  });
});

describe('pending-retry re-entrancy (audit P-022)', () => {
  it('a slow retry tick never overlaps the next one (sequential rescheduling)', async () => {
    // verifyBinding: 'pending' forever, but SLOW (60ms) from the second call —
    // far slower than the 15ms retry cadence. The old setInterval stacked
    // ticks; the setTimeout chain must keep concurrency at 1.
    let inFlight = 0;
    let maxInFlight = 0;
    let calls = 0;
    const handle = await bootHarnessSubstrate({
      workspaceRoot: tmpDir('mb-reent-'),
      workspaceId: 'ws-reent-1',
      harnessSlug: 'reent-1',
      mergePollMs: 0,
      pendingRetryMs: 15,
      loadRevokedOverride: async () => new Set(),
      verifyBindingOverride: async () => {
        calls++;
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        if (calls > 1) await new Promise((r) => setTimeout(r, 60));
        inFlight--;
        return 'pending';
      },
      applyOverride: async () => true,
    });
    cleanups.push(() => handle.close());

    // Seed one pending peer (first verify call is fast).
    const frame = await validAnnounce('a1'.repeat(32));
    const decision = await handle.onAnnounce(frame);
    expect(decision).toEqual({ admit: false, reason: 'pending' });

    // Poll until the sequential retry chain has ticked several times, rather
    // than sleeping a fixed 250ms and asserting a count. A fixed wall-clock
    // sleep is flaky: on a loaded/oversubscribed gate host the retry timers are
    // starved, so fewer ticks complete in the window and the count undercounts
    // (observed: only 2 ticks in 250ms → gate red). Waiting for the CONDITION
    // keeps the real timers + real re-entrancy behavior under test while
    // decoupling from host load. The invariant that actually matters — a slow
    // tick never overlaps the next (maxInFlight === 1) — holds however long the
    // individual ticks take under load.
    const deadline = Date.now() + 4000;
    while (calls < 3 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(calls).toBeGreaterThanOrEqual(3); // the chain IS still retrying
    expect(maxInFlight).toBe(1); // …but never concurrently
  }, 20_000);
});
