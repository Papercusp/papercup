/**
 * wi3893-repair-real-wire.integration.test.ts — WI-3893 (plan
 * p2p-live-federation-crack-2026-07-10 P-007, "recurrence guard"): real-wire
 * proof that WI-3684's repair-on-detect for `connected_never_replicated`
 * genuinely reconnects replication, not just swaps a fake session in a mock.
 *
 * WI-3684 (boot.ts `setReplicationRepairHandler` + `drainRepairQueue`) already
 * closes a stale, non-attaching remote-log session and re-opens a fresh one
 * via `openRemoteLog` when the liveness registry (replication-liveness.ts)
 * alarms on a swarm-connected-but-never-replicated log — the exact WI-183 /
 * EI-8895 zombie-connection class this plan's P-001 targets at the SOURCE
 * (attach at admission). Its only existing regression coverage
 * (boot.test.ts's "WI-3684 repair-on-detect (P-002)" describe) is a SYNTHETIC
 * unit test: both the stale AND the repaired session are hand-rolled fakes,
 * so it pins the queue/cap/event-recording mechanics but never proves the
 * repaired session actually attaches a live replicator over a REAL swarm —
 * unlike the sibling no_replicator self-heal (WI-1534/WI-752), which HAS a
 * real-wire integration test
 * (wi1534-quiescent-hive-self-heal.integration.test.ts).
 *
 * This test closes that gap. Peer B's FIRST admission of peer A's log is
 * handed a hand-rolled BROKEN session (peersCount() pinned at 0, no real
 * Hypercore machinery underneath) via `openRemoteLogOverride` — simulating a
 * late-admitted log whose corestore session never attaches despite a live
 * swarm connection (the WI-183 symptom). A short `replicationStallGraceMs`
 * lets the connected_never_replicated axis alarm quickly; repair-on-detect
 * then re-opens via the SAME override, which this time (2nd+ call) returns
 * the REAL `openRemoteLog` over peer B's real corestore + its real live swarm
 * connection to peer A. Since the broken stub can never attach on its own (it
 * isn't backed by a real Hypercore session), an eventual `peersCount() > 0`
 * can ONLY be explained by the repair having genuinely re-established
 * replication over the wire — real Hyperswarm/Noise/testnet-DHT, not a mock.
 *
 * Boot-order note: `replication-liveness.ts`'s `repairHandlers` (and its
 * liveness `registry`) are MODULE-LEVEL singletons keyed only by
 * `(workspaceId, harnessSlug)` — correct in production (one harness process
 * per machine, so the key is naturally unique per peer) but a genuine
 * same-process-test artifact here: `bootPresencePeer` pins every caller to
 * the SAME (workspaceId, harnessSlug) (so both simulated "machines" share one
 * swarm topic), and each `bootHarnessSubstrate` call unconditionally
 * OVERWRITES that key's repair handler with its own closure. Booting peer B
 * (the one under test) LAST makes B's registration the one left active for
 * the rest of the test — otherwise peer A's handler would intercept B's
 * episodes and silently no-op them (A's `drainRepairQueue` skips any keyHex
 * equal to A's OWN log key, which is exactly `aKey`).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  bootPresencePeer,
  makeTestnet,
  makeIdentity,
  rigAfterEach,
  pollUntil,
  presenceValue,
  cleanups,
  SHARED_PRESENCE_DDL,
  COORD_EVENT_LOG_DDL,
} from './_cross-peer-rig';
import { createFreshPgDb, type FreshPgDb } from '../../../../test/_pg-helpers';
import { openRemoteLog, type RemoteLog } from '../peer-log';
import { listBootHistory } from '../boot-history';
import {
  setReplicationStallEpisodeReporterForTests,
  setReplicationStallRecoveryReporterForTests,
} from '../replication-liveness';

afterEach(rigAfterEach);

/** A hand-rolled session that structurally CANNOT attach a live replicator —
 *  no real Hypercore machinery underneath, `peersCount()` pinned at 0. Mirrors
 *  boot.test.ts's `fakeCloseableRemoteLog`, but this file needs its own copy
 *  (that helper is scoped to boot.test.ts's describe block). */
function brokenNonAttachingLog(keyHex: string): RemoteLog {
  return {
    keyHex,
    length: 0,
    contiguousLength: 0,
    get: async () => null,
    update: async () => {},
    prefetch: () => {},
    has: () => false,
    peersCount: () => 0,
    close: async () => {},
  };
}

describe('WI-3893 (P-007) — connected_never_replicated repair-on-detect reconnects over the REAL wire', () => {
  it(
    "peer B's broken first session for peer A's log is repaired into a real, live-attached replicator",
    async () => {
      // Silence the default reporters (console.error + durable-EI lazy import)
      // — this test asserts on the repair MECHANICS (session swap + boot
      // event + real attach), not the diagnostic/escalation legs, and a real
      // connected_never_replicated alarm firing is expected, not a test
      // failure. Mirrors boot.test.ts's WI-3684 describe block. Pushed FIRST
      // so it runs LAST (LIFO) — after each peer's `handle.close()` (which
      // also reports recoveries through this same module-level seam).
      setReplicationStallEpisodeReporterForTests(() => {});
      setReplicationStallRecoveryReporterForTests(() => {});
      cleanups.push(() => {
        setReplicationStallEpisodeReporterForTests(null);
        setReplicationStallRecoveryReporterForTests(null);
      });

      const dbA: FreshPgDb = await createFreshPgDb('wi3893A');
      cleanups.push(() => dbA.cleanup());
      const dbB: FreshPgDb = await createFreshPgDb('wi3893B');
      cleanups.push(() => dbB.cleanup());
      await dbA.sql.unsafe(SHARED_PRESENCE_DDL);
      await dbB.sql.unsafe(SHARED_PRESENCE_DDL);
      await dbA.sql.unsafe(COORD_EVENT_LOG_DDL);
      await dbB.sql.unsafe(COORD_EVENT_LOG_DDL);

      const testnet = await makeTestnet();
      const idA = makeIdentity('alice3893', 4893, 'kc-alice3893');
      const idB = makeIdentity('bob3893', 7893, 'kc-bob3893');

      // Peer B: the FIRST `openRemoteLogOverride` call (peer A's admission)
      // gets the BROKEN stub; every subsequent call (the repair's re-open)
      // gets the REAL `openRemoteLog` over B's real corestore — a genuine
      // session that CAN attach over the real swarm.
      let openCalls = 0;
      const bOpenOverride = vi.fn(
        async (store: Parameters<typeof openRemoteLog>[0], keyHex: string) => {
          openCalls += 1;
          return openCalls === 1 ? brokenNonAttachingLog(keyHex) : openRemoteLog(store, keyHex);
        },
      );

      // Boot A FIRST, B SECOND: `replication-liveness.ts`'s repairHandlers map
      // is keyed only by (workspaceId, harnessSlug), and both peers share that
      // key here (see the boot-order note in the file header) — the LAST
      // `bootHarnessSubstrate` call's handler registration wins for the rest
      // of the test, so B (the peer under test) must boot last.
      const peerA = await bootPresencePeer({
        testnetBootstrap: testnet.bootstrap,
        rootPrefix: 'wi3893-A-',
        identity: idA,
        sql: dbA.sql,
        verify: (uid) => (uid === idB.userId ? 'verified' : 'fail'),
      });
      const peerB = await bootPresencePeer({
        testnetBootstrap: testnet.bootstrap,
        rootPrefix: 'wi3893-B-',
        identity: idB,
        sql: dbB.sql,
        verify: (uid) => (uid === idA.userId ? 'verified' : 'fail'),
        openRemoteLogOverride: bOpenOverride,
        replicationStallGraceMs: 200,
      });

      const aKey = peerA.handle.ownLog.keyHex;

      // Own-presence appends drive the mutual admission handshake (mirrors
      // federateTwoPeerPresence) — peer B ends up admitting A's log via the
      // BROKEN override on the first call.
      await peerA.handle.append({
        type: 'put',
        table: 'presence',
        hbKey: `${idA.userId}/machine-A`,
        value: presenceValue(idA.userId, 'machine-A', idA.devicePubkey),
        ts: 1000,
        schema_version: 1,
        writerPubkey: idA.devicePubkey,
      });
      await peerB.handle.append({
        type: 'put',
        table: 'presence',
        hbKey: `${idB.userId}/machine-B`,
        value: presenceValue(idB.userId, 'machine-B', idB.devicePubkey),
        ts: 1001,
        schema_version: 1,
        writerPubkey: idB.devicePubkey,
      });

      // B must actually admit A's log (via the broken override) before we can
      // prove the repair reconnects it.
      const admitted = await pollUntil(
        async () => {
          await peerB.handle.mergeNow();
          return peerB.handle.admitted.has(aKey) ? true : undefined;
        },
        { timeoutMs: 15_000, intervalMs: 200 },
      );
      expect(admitted, "peer B never admitted peer A's log").toBe(true);
      expect(
        openCalls,
        'the broken-stub override was never invoked for the first admission',
      ).toBeGreaterThanOrEqual(1);

      const brokenSession = peerB.handle.admitted.get(aKey) as RemoteLog | undefined;
      expect(brokenSession?.peersCount?.(), "the broken stub wasn't actually installed first").toBe(0);

      // Drive merge passes on both sides: B's swarm holds a live connection to
      // A (real Hyperswarm) while the broken stub can never attach — so, after
      // the 200ms grace, the connected_never_replicated axis alarms and
      // repair-on-detect enqueues a re-open, applied at the top of the NEXT
      // pass (boot.ts drainRepairQueue).
      const repaired = await pollUntil(
        async () => {
          await peerB.handle.mergeNow();
          await peerA.handle.mergeNow();
          const current = peerB.handle.admitted.get(aKey) as RemoteLog | undefined;
          return current && current !== brokenSession ? true : undefined;
        },
        { timeoutMs: 20_000, intervalMs: 200 },
      );
      expect(repaired, 'the broken session was never swapped out by repair-on-detect').toBe(true);

      // The repair event was actually recorded — proves it was the repair
      // path (not some other admission churn) that swapped the session.
      const repairEvents = listBootHistory({
        workspaceId: peerB.handle.workspaceId,
        harnessSlug: peerB.handle.harnessSlug,
        kinds: ['replication_repair'],
      });
      expect(
        repairEvents.length,
        'no replication_repair boot event was recorded',
      ).toBeGreaterThanOrEqual(1);

      // THE PROOF: the repaired session is a REAL corestore session (opened
      // via the real openRemoteLog over B's real swarm connection to A) and
      // it GENUINELY attaches a live replicator — something the broken stub
      // could structurally never do. This can only be explained by
      // repair-on-detect having actually re-established replication over the
      // real wire (real Hyperswarm/Noise/testnet-DHT).
      const liveAttached = await pollUntil(
        async () => {
          await peerB.handle.mergeNow();
          await peerA.handle.mergeNow();
          const current = peerB.handle.admitted.get(aKey) as RemoteLog | undefined;
          const n = current?.peersCount?.() ?? 0;
          return n > 0 ? n : undefined;
        },
        { timeoutMs: 20_000, intervalMs: 200 },
      );
      expect(
        liveAttached,
        'WI-3893 regression: repair-on-detect swapped the session but it never attached ' +
          'a live replicator over the real wire',
      ).toBeTruthy();
    },
    60_000,
  );
});
