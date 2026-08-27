/**
 * reverify-admitted.test.ts — channel-2 re-verification of admitted peers
 * (substrate-revocation-v2 Component A; harden-shared-hive-to-256-peers P-002).
 *
 * Verifies that bootHarnessSubstrate periodically re-verifies every admitted
 * peer's channel-2 binding and drops peers whose binding conclusively fails,
 * while keeping peers on a transient result (fail-open per D-004).
 *
 * P-002 architecture: the GitHub `verifyBinding` I/O runs LOCKLESS — OFF the
 * merge lock. `reverifyAdmitted()` is now a PRODUCER: it makes the verify calls
 * off the lock and ENQUEUES each conclusive-fail logKey onto a drop queue; the
 * actual drop (map mutation + peer_revoked) is APPLIED on a SUBSEQUENT merge
 * pass UNDER the gate (mirror of admissionQueue / drainAdmissionQueue). So to
 * observe a drop a test calls `reverifyAdmitted()` THEN `mergeNow()`.
 *
 * Key invariants under test:
 *   1. Admit a peer (announce → 'verified') → flip verifyBinding to 'fail' →
 *      call reverifyAdmitted() by hand (ENQUEUES, does NOT drop synchronously) →
 *      mergeNow() applies the drop: peer dropped from admitted, a peer_revoked
 *      event recorded, pubkey NOT added to the published `revoked` set (so a
 *      later re-announce with 'verified' is admitted again).
 *   2. verifyBinding returns 'pending' on re-verify → fail-open, peer kept.
 *   3. The own log is never re-verified or dropped.
 *   4. Timer: reverifyIntervalMs: 0 disables the auto kick-off (tests drive
 *      reverifyAdmitted directly); handle.close() clears all timers (no leak).
 *   5. (P-002) The auto path runs the verify OFF the lock: a mergeNow KICKS OFF
 *      the verify fire-and-forget and does NOT block on it (a held-mid-flight
 *      verify leaves the merge pass free and the peer still admitted); once the
 *      verify resolves 'fail', the drop lands on a SUBSEQUENT pass via the queue.
 *
 * Uses the boot test seams:
 *   - `verifyBindingOverride` (injectable + mutable for flip-after-admit)
 *   - `mergePollMs: 0` (disable background merge timer)
 *   - `pendingRetryMs: 0` (disable pending-retry timer)
 *   - `reverifyIntervalMs: 0` (disable the auto kick-off in mergeNow; drive
 *     reverifyAdmitted() + mergeNow() by hand via the handle)
 *   - `loadRevokedOverride: async () => new Set()` (avoid real PG loader)
 *
 * No real PG or network is needed.
 *
 * Plan: substrate-revocation-v2, Component A; harden-shared-hive-to-256-peers P-002.
 */

import { afterEach, describe, it, expect } from 'vitest';
import { generateKeyPairSync, sign as nodeSign } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootHarnessSubstrate } from '../boot';
import { buildAnnounce, type SignedAnnounce } from '../announce';
import { _resetCacheForTests } from '../corestore';
import { _clearRegistryForTests } from '../projection';
import { _resetBootHistoryForTests, listBootHistory } from '../boot-history';

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

/** Generate a real Ed25519 keypair; return the base64 pubkey + a signer. */
function makeDevice() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const devicePubkey = (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('base64');
  const sign = async (bytes: Buffer) => nodeSign(null, bytes, privateKey);
  return { devicePubkey, sign };
}

/** Build a VALID signed announce from a device. */
async function makeAnnounce(
  device: ReturnType<typeof makeDevice>,
  logCoreKey: string,
  githubLogin = 'alice',
  githubUserId = 4242,
): Promise<SignedAnnounce> {
  return buildAnnounce(
    {
      device_pubkey: device.devicePubkey,
      github_user_id: githubUserId,
      github_login: githubLogin,
      attestation_gist_id: 'gist-test',
      log_core_key: logCoreKey,
    },
    device.sign,
  );
}

describe('channel-2 re-verify for admitted peers (rev-v2 Component A)', () => {
  // ── Test 1: conclusive 'fail' drops peer, no permanent blocklist ───────────
  it("re-verify 'fail': peer dropped from admitted, peer_revoked recorded, pubkey NOT in revoked (re-admittable)", async () => {
    // Start with 'verified' so the peer is admitted initially.
    let bindingResult: 'verified' | 'pending' | 'fail' = 'verified';
    const verifyBindingOverride = async (
      _dpk: string,
      _login: string,
      _uid: number,
    ): Promise<'verified' | 'pending' | 'fail'> => bindingResult;

    const handle = await bootHarnessSubstrate({
      rekeyDepsOverride: null, // unit boot must not auto-build re-key deps through real PG
      workspaceRoot: tmpDir('mb-rv2-fail-host-'),
      workspaceId: 'ws-rv2-fail',
      harnessSlug: 'rv2-fail-1',
      mergePollMs: 0,
      pendingRetryMs: 0,
      reverifyIntervalMs: 0, // disable auto-throttle; drive by hand
      loadRevokedOverride: async () => new Set(),
      verifyBindingOverride,
    });
    cleanups.push(() => handle.close());

    const device = makeDevice();
    const logCoreKey = 'aa'.repeat(32);
    const frame = await makeAnnounce(device, logCoreKey, 'peer-alice', 1001);

    // Admit the peer (binding = 'verified').
    const admitDecision = await handle.onAnnounce(frame);
    expect(admitDecision.admit).toBe(true);
    expect(handle.admitted.has(logCoreKey)).toBe(true);

    // ── Flip binding to 'fail' (GitHub admin deleted the branch). ──
    bindingResult = 'fail';

    // Drive the LOCKLESS re-verify producer by hand (reverifyIntervalMs: 0
    // disables the auto kick-off). It ENQUEUES the conclusive-fail drop but
    // does NOT mutate `admitted` — so the peer is STILL admitted right after.
    await handle.reverifyAdmitted();
    expect(handle.admitted.has(logCoreKey)).toBe(true); // (a) NOT dropped synchronously

    // The drop is applied on a SUBSEQUENT merge pass, via the drop queue,
    // UNDER the merge gate (mirror of drainAdmissionQueue).
    await handle.mergeNow();

    // Peer must now be dropped from admitted.
    expect(handle.admitted.has(logCoreKey)).toBe(false);
    // Only the own log remains.
    expect([...handle.admitted.keys()]).toEqual([handle.ownLog.keyHex]);

    // A peer_revoked boot-history event must have been recorded.
    const revokedEvents = listBootHistory({
      workspaceId: 'ws-rv2-fail',
      harnessSlug: 'rv2-fail-1',
      kinds: ['peer_revoked'],
      limit: 10,
    });
    expect(revokedEvents.length).toBeGreaterThan(0);

    // ── Key invariant: pubkey is NOT in the published `revoked` set. ──
    // A channel-2 drop is a GitHub-side deletion, not a permanent blocklist.
    // A later re-announce with 'verified' must be admitted again.
    bindingResult = 'verified';
    const frame2 = await makeAnnounce(device, logCoreKey, 'peer-alice', 1001);
    const reAdmitDecision = await handle.onAnnounce(frame2);
    expect(reAdmitDecision.admit).toBe(true);
    expect(handle.admitted.has(logCoreKey)).toBe(true);
  });

  // ── Test 2: 'pending' on re-verify → fail-open, peer kept ─────────────────
  it("re-verify 'pending': fail-open, peer kept in admitted set", async () => {
    let bindingResult: 'verified' | 'pending' | 'fail' = 'verified';
    const verifyBindingOverride = async (
      _dpk: string,
      _login: string,
      _uid: number,
    ): Promise<'verified' | 'pending' | 'fail'> => bindingResult;

    const handle = await bootHarnessSubstrate({
      rekeyDepsOverride: null, // unit boot must not auto-build re-key deps through real PG
      workspaceRoot: tmpDir('mb-rv2-pending-host-'),
      workspaceId: 'ws-rv2-pending',
      harnessSlug: 'rv2-pending-1',
      mergePollMs: 0,
      pendingRetryMs: 0,
      reverifyIntervalMs: 0,
      loadRevokedOverride: async () => new Set(),
      verifyBindingOverride,
    });
    cleanups.push(() => handle.close());

    const device = makeDevice();
    const logCoreKey = 'bb'.repeat(32);
    const frame = await makeAnnounce(device, logCoreKey, 'peer-bob', 2002);

    // Admit the peer.
    await handle.onAnnounce(frame);
    expect(handle.admitted.has(logCoreKey)).toBe(true);

    // Flip to 'pending' (transient GitHub API lag).
    bindingResult = 'pending';
    await handle.reverifyAdmitted();
    // 'pending' enqueues nothing; a drain pass changes nothing.
    await handle.mergeNow();

    // Peer must still be admitted (fail-open per D-004).
    expect(handle.admitted.has(logCoreKey)).toBe(true);
    // No peer_revoked event.
    const revokedEvents = listBootHistory({
      workspaceId: 'ws-rv2-pending',
      harnessSlug: 'rv2-pending-1',
      kinds: ['peer_revoked'],
      limit: 10,
    });
    expect(revokedEvents).toHaveLength(0);
  });

  // ── Test 3: own log is never re-verified or dropped ───────────────────────
  it('own log is never touched by reverifyAdmitted', async () => {
    // verifyBinding always returns 'fail' — if the own log is mistakenly
    // re-verified, it would be dropped.
    const verifyBindingOverride = async (): Promise<'verified' | 'pending' | 'fail'> => 'fail';

    const handle = await bootHarnessSubstrate({
      rekeyDepsOverride: null, // unit boot must not auto-build re-key deps through real PG
      workspaceRoot: tmpDir('mb-rv2-own-'),
      workspaceId: 'ws-rv2-own',
      harnessSlug: 'rv2-own-1',
      mergePollMs: 0,
      pendingRetryMs: 0,
      reverifyIntervalMs: 0,
      loadRevokedOverride: async () => new Set(),
      verifyBindingOverride,
    });
    cleanups.push(() => handle.close());

    const ownKeyHex = handle.ownLog.keyHex;
    expect(handle.admitted.has(ownKeyHex)).toBe(true);

    // Run re-verify + a drain pass — own log must survive even though binding
    // returns 'fail' (the producer never enqueues the own log; the drain
    // defensively skips it too).
    await handle.reverifyAdmitted();
    await handle.mergeNow();

    expect(handle.admitted.has(ownKeyHex)).toBe(true);
    // No peer_revoked events (no peers were dropped).
    const revokedEvents = listBootHistory({
      workspaceId: 'ws-rv2-own',
      harnessSlug: 'rv2-own-1',
      kinds: ['peer_revoked'],
      limit: 10,
    });
    expect(revokedEvents).toHaveLength(0);
  });

  // ── Test 4: thrown error during re-verify → fail-open, peer kept ──────────
  it('thrown error during re-verify → fail-open, peer kept, announce_error recorded', async () => {
    let bindingResult: 'verified' | 'pending' | 'fail' | 'throw' = 'verified';
    const verifyBindingOverride = async (
      _dpk: string,
      _login: string,
      _uid: number,
    ): Promise<'verified' | 'pending' | 'fail'> => {
      if (bindingResult === 'throw') throw new Error('GitHub API timeout');
      return bindingResult;
    };

    const handle = await bootHarnessSubstrate({
      rekeyDepsOverride: null, // unit boot must not auto-build re-key deps through real PG
      workspaceRoot: tmpDir('mb-rv2-throw-host-'),
      workspaceId: 'ws-rv2-throw',
      harnessSlug: 'rv2-throw-1',
      mergePollMs: 0,
      pendingRetryMs: 0,
      reverifyIntervalMs: 0,
      loadRevokedOverride: async () => new Set(),
      verifyBindingOverride,
    });
    cleanups.push(() => handle.close());

    const device = makeDevice();
    const logCoreKey = 'cc'.repeat(32);
    const frame = await makeAnnounce(device, logCoreKey, 'peer-carol', 3003);

    await handle.onAnnounce(frame);
    expect(handle.admitted.has(logCoreKey)).toBe(true);

    // Flip to throwing (transient network error).
    bindingResult = 'throw';
    await handle.reverifyAdmitted();
    // A thrown verify enqueues nothing; a drain pass changes nothing.
    await handle.mergeNow();

    // Peer must still be admitted (fail-open per D-004).
    expect(handle.admitted.has(logCoreKey)).toBe(true);
    // No peer_revoked event.
    const revokedEvents = listBootHistory({
      workspaceId: 'ws-rv2-throw',
      harnessSlug: 'rv2-throw-1',
      kinds: ['peer_revoked'],
      limit: 10,
    });
    expect(revokedEvents).toHaveLength(0);
    // An announce_error event is recorded for the transient failure.
    const errorEvents = listBootHistory({
      workspaceId: 'ws-rv2-throw',
      harnessSlug: 'rv2-throw-1',
      kinds: ['announce_error'],
      limit: 10,
    });
    expect(errorEvents.length).toBeGreaterThan(0);
  });

  // ── Test 5: reverifyIntervalMs: 0 disables auto-timer; close has no leak ──
  it('reverifyIntervalMs: 0 disables auto-throttle; close() is clean (no timer leak)', async () => {
    // With reverifyIntervalMs: 0, the throttled path in mergeNow is a no-op.
    // We verify this by having verifyBinding always return 'fail' — if
    // maybeReverifyAdmitted fired during mergeNow, the admitted peer would
    // be dropped, which would be visible. It must NOT be dropped until we
    // call reverifyAdmitted() by hand.
    let autoFired = false;
    const verifyBindingOverride = async (
      _dpk: string,
      _login: string,
      _uid: number,
    ): Promise<'verified' | 'pending' | 'fail'> => {
      autoFired = true;
      return 'fail';
    };

    const handle = await bootHarnessSubstrate({
      rekeyDepsOverride: null, // unit boot must not auto-build re-key deps through real PG
      workspaceRoot: tmpDir('mb-rv2-timer-'),
      workspaceId: 'ws-rv2-timer',
      harnessSlug: 'rv2-timer-1',
      mergePollMs: 0,
      pendingRetryMs: 0,
      reverifyIntervalMs: 0, // disabled
      loadRevokedOverride: async () => new Set(),
      // Override so the initial onAnnounce verifyBinding returns 'verified',
      // then flips — but we can't control call ordering that way. Instead,
      // we'll admit the peer first (with 'verified'), THEN set verifyBinding
      // to 'fail', and assert that mergeNow does NOT auto-drop it.
      // We'll use a separate flag to detect if verifyBinding was called
      // during mergeNow (indicating the auto-throttle fired).
      verifyBindingOverride: async (_dpk, _login, _uid) => {
        autoFired = true;
        return 'fail';
      },
    });
    cleanups.push(() => handle.close());

    // With verifyBinding always returning 'fail', a direct onAnnounce will
    // be rejected (binding_invalid). So we need a separate handle that admits
    // the peer first, then re-verify. But for this specific timer test,
    // we just verify that:
    //   (a) reverifyIntervalMs: 0 means maybeReverifyAdmitted is a no-op
    //   (b) handle.close() resolves cleanly (no dangling timer).

    // Reset the flag — boot itself calls mergeNow which calls
    // maybeReverifyAdmitted, but with reverifyIntervalMs=0 it should be a
    // no-op and NOT call verifyBinding.
    autoFired = false;

    // Trigger a manual mergeNow — maybeReverifyAdmitted must NOT fire.
    await handle.mergeNow();
    expect(autoFired).toBe(false);

    // close() must resolve cleanly.
    await expect(handle.close()).resolves.toBeUndefined();
  });

  // ── Test 6 (P-002): auto-reverify via mergeNow runs the verify I/O OFF the
  //    lock — the merge pass does NOT block on it, and a conclusive-fail peer is
  //    dropped on a SUBSEQUENT pass via the drop queue ──────────────────────────
  it('auto-reverify runs verify OFF the merge lock: the pass does not block on it; a fail-peer drops on a SUBSEQUENT pass via the drop queue', async () => {
    let bindingResult: 'verified' | 'pending' | 'fail' = 'verified';
    // A controllable gate so the test can HOLD the 'fail' verify mid-flight,
    // proving the merge pass returns without waiting on the GitHub I/O.
    let releaseVerify: (() => void) | null = null;
    const verifyBindingOverride = async (
      _dpk: string,
      _login: string,
      _uid: number,
    ): Promise<'verified' | 'pending' | 'fail'> => {
      if (bindingResult === 'fail') {
        // Park here until the test explicitly releases the verify.
        await new Promise<void>((res) => {
          releaseVerify = res;
        });
      }
      return bindingResult;
    };

    const handle = await bootHarnessSubstrate({
      rekeyDepsOverride: null, // unit boot must not auto-build re-key deps through real PG
      workspaceRoot: tmpDir('mb-rv2-offlock-host-'),
      workspaceId: 'ws-rv2-offlock',
      harnessSlug: 'rv2-offlock-1',
      mergePollMs: 0,
      pendingRetryMs: 0,
      reverifyIntervalMs: 1, // 1ms — auto kick-off fires on the next mergeNow
      loadRevokedOverride: async () => new Set(),
      verifyBindingOverride,
    });
    cleanups.push(() => handle.close());

    const device = makeDevice();
    const logCoreKey = 'dd'.repeat(32);
    const frame = await makeAnnounce(device, logCoreKey, 'peer-dave', 4004);

    // Admit the peer (binding = 'verified', resolves immediately — no gate).
    const admitDecision = await handle.onAnnounce(frame);
    expect(admitDecision.admit).toBe(true);
    expect(handle.admitted.has(logCoreKey)).toBe(true);

    // Flip to 'fail' (which now PARKS inside verifyBinding until released) and
    // wait > 1ms so the cadence elapses for the next kick-off.
    bindingResult = 'fail';
    await new Promise((r) => setTimeout(r, 5));

    // (b) Drive a mergeNow. It KICKS OFF the lockless verify (now parked on the
    // gate) fire-and-forget but must NOT block on it: the pass returns promptly
    // while the verify is still in flight, so the peer is STILL admitted. Under
    // the OLD design the verify ran under the lock and the peer would already
    // be dropped here.
    await handle.mergeNow();
    expect(releaseVerify).not.toBeNull(); // the verify was kicked off
    expect(handle.admitted.has(logCoreKey)).toBe(true); // pass did NOT block / drop

    // Nothing applied yet — no peer_revoked.
    expect(
      listBootHistory({
        workspaceId: 'ws-rv2-offlock',
        harnessSlug: 'rv2-offlock-1',
        kinds: ['peer_revoked'],
        limit: 10,
      }),
    ).toHaveLength(0);

    // (a) Release the verify. It resolves 'fail', enqueues the drop, and
    // requests a merge pass; the drop is APPLIED UNDER the gate on a SUBSEQUENT
    // pass via the drop queue.
    releaseVerify!();
    for (let i = 0; i < 50 && handle.admitted.has(logCoreKey); i++) {
      await new Promise((r) => setTimeout(r, 1));
      await handle.mergeNow();
    }

    expect(handle.admitted.has(logCoreKey)).toBe(false);
    expect([...handle.admitted.keys()]).toEqual([handle.ownLog.keyHex]);

    // peer_revoked event recorded by the drain.
    const revokedEvents = listBootHistory({
      workspaceId: 'ws-rv2-offlock',
      harnessSlug: 'rv2-offlock-1',
      kinds: ['peer_revoked'],
      limit: 10,
    });
    expect(revokedEvents.length).toBeGreaterThan(0);
  });
});

/**
 * P-021 (shared-hive-cross-machine-scale-10k): the re-verify sweep is
 * ROUND-ROBIN BATCHED, so the GitHub API call rate is O(1) in membership.
 *
 * Before this, every pass verified all N admitted peers — 4N calls/hour at the
 * 15-min cadence, which exceeds GitHub's 5,000/hr limit around ~1,250 members.
 * The failure mode is silent, not loud: a rate-limited check returns 'pending'
 * and fail-open (D-004) keeps the peer, so revocation just stops being detected.
 *
 * These tests pin the three properties that make the bound trustworthy:
 *   1. a pass verifies AT MOST `reverifyBatchSize` peers (the rate bound), and
 *   2. successive passes still cover EVERY peer and WRAP (no peer is starved),
 *   3. a throwing verify still advances the cursor (one unreachable peer cannot
 *      pin the sweep in place forever).
 */
describe('P-021: re-verify is round-robin batched (bounded GitHub call rate)', () => {
  /** Admit `count` peers with deterministic logKeys ('11'*32, '22'*32, ...). */
  async function admitPeers(
    handle: Awaited<ReturnType<typeof bootHarnessSubstrate>>,
    count: number,
  ): Promise<string[]> {
    const logKeys: string[] = [];
    for (let i = 1; i <= count; i++) {
      const device = makeDevice();
      const logCoreKey = String(i).repeat(2).repeat(32); // '11'*32, '22'*32, ...
      const frame = await makeAnnounce(device, logCoreKey, `p${i}`, 5000 + i);
      const decision = await handle.onAnnounce(frame);
      expect(decision.admit).toBe(true);
      logKeys.push(logCoreKey);
    }
    return logKeys;
  }

  it('a pass verifies at most reverifyBatchSize peers, and successive passes round-robin over all of them (wrapping)', async () => {
    // Record which peer each verifyBinding call was for, by github login.
    let calls: string[] = [];
    const verifyBindingOverride = async (
      _dpk: string,
      login: string,
      _uid: number,
    ): Promise<'verified' | 'pending' | 'fail'> => {
      calls.push(login);
      return 'verified';
    };

    const handle = await bootHarnessSubstrate({
      rekeyDepsOverride: null, // unit boot must not auto-build re-key deps through real PG
      workspaceRoot: tmpDir('mb-rv2-batch-'),
      workspaceId: 'ws-rv2-batch',
      harnessSlug: 'rv2-batch-1',
      mergePollMs: 0,
      pendingRetryMs: 0,
      reverifyIntervalMs: 0, // drive reverifyAdmitted() by hand
      reverifyBatchSize: 2,
      loadRevokedOverride: async () => new Set(),
      verifyBindingOverride,
    });
    cleanups.push(() => handle.close());

    await admitPeers(handle, 5);
    calls = []; // discard the admission-path calls; count only the sweep

    // Pass 1: the two SMALLEST logKeys — NOT all five. This is the rate bound.
    await handle.reverifyAdmitted();
    expect(calls).toEqual(['p1', 'p2']);

    // Pass 2: resumes strictly after the cursor — no re-verify of p1/p2.
    calls = [];
    await handle.reverifyAdmitted();
    expect(calls).toEqual(['p3', 'p4']);

    // Pass 3: takes the tail then WRAPS to the smallest key. Every peer has
    // now been swept exactly once within ceil(5/2) = 3 passes.
    calls = [];
    await handle.reverifyAdmitted();
    expect(calls).toEqual(['p5', 'p1']);
  });

  it('batchSize >= membership sweeps every peer in one pass (unchanged behaviour at or below the 256-peer ceiling)', async () => {
    let calls: string[] = [];
    const verifyBindingOverride = async (
      _dpk: string,
      login: string,
      _uid: number,
    ): Promise<'verified' | 'pending' | 'fail'> => {
      calls.push(login);
      return 'verified';
    };

    const handle = await bootHarnessSubstrate({
      rekeyDepsOverride: null, // unit boot must not auto-build re-key deps through real PG
      workspaceRoot: tmpDir('mb-rv2-batch-full-'),
      workspaceId: 'ws-rv2-batch-full',
      harnessSlug: 'rv2-batch-full-1',
      mergePollMs: 0,
      pendingRetryMs: 0,
      reverifyIntervalMs: 0,
      // Default batch (256) — not passed, to prove the DEFAULT preserves the
      // full-sweep behaviour a small hive had before P-021.
      loadRevokedOverride: async () => new Set(),
      verifyBindingOverride,
    });
    cleanups.push(() => handle.close());

    await admitPeers(handle, 3);
    calls = [];

    await handle.reverifyAdmitted();
    expect(calls.sort()).toEqual(['p1', 'p2', 'p3']);
    // The own log is still never verified (batching must not resurrect it).
    expect(calls).toHaveLength(3);
  });

  it('a throwing verify still advances the cursor — one unreachable peer cannot pin the sweep', async () => {
    let calls: string[] = [];
    // p1 becomes unreachable only AFTER admission (throwing during admission
    // would reject the peer and there would be nothing to sweep).
    let phase: 'admit' | 'sweep' = 'admit';
    const verifyBindingOverride = async (
      _dpk: string,
      login: string,
      _uid: number,
    ): Promise<'verified' | 'pending' | 'fail'> => {
      calls.push(login);
      if (phase === 'sweep' && login === 'p1') throw new Error('GitHub API timeout');
      return 'verified';
    };

    const handle = await bootHarnessSubstrate({
      rekeyDepsOverride: null, // unit boot must not auto-build re-key deps through real PG
      workspaceRoot: tmpDir('mb-rv2-batch-throw-'),
      workspaceId: 'ws-rv2-batch-throw',
      harnessSlug: 'rv2-batch-throw-1',
      mergePollMs: 0,
      pendingRetryMs: 0,
      reverifyIntervalMs: 0,
      reverifyBatchSize: 1,
      loadRevokedOverride: async () => new Set(),
      verifyBindingOverride,
    });
    cleanups.push(() => handle.close());

    await admitPeers(handle, 3);
    calls = [];
    phase = 'sweep';

    // p1 throws — the cursor must still move past it.
    await handle.reverifyAdmitted();
    expect(calls).toEqual(['p1']);

    calls = [];
    await handle.reverifyAdmitted();
    expect(calls).toEqual(['p2']); // NOT 'p1' again

    calls = [];
    await handle.reverifyAdmitted();
    expect(calls).toEqual(['p3']);
  });
});
