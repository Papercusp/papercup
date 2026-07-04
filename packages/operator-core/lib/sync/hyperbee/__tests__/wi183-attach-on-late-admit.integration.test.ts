/**
 * wi183-attach-on-late-admit.integration.test.ts — WI-183 M1 ("admitted-but-never
 * -attached") reproduction probe.
 *
 * The P-014 reverse-leg blocker (WI-183 class, 35c3b's fresh-.deb matrix): a peer
 * log is ADMITTED (openRemoteLog runs — proven live via the sidecar boot-history
 * ring: all announce_admitted, zero rejected) yet its Hypercore NEVER attaches a
 * live replicator peer (`core.peers.length` stays 0 for >1h, no self-heal), so
 * nothing folds and the reverse-leg materializes nothing on the member.
 *
 * This test reproduces the EXACT structural ordering in-process over the real
 * (testnet-DHT) transport: two peers connect FIRST, then each admits the OTHER's
 * log AFTER the connection is established (announce-after-connect), then merges.
 * The WI-183 assertion is the one the rig fails: once B has admitted A's log, that
 * admitted remote log must show a LIVE replicator peer (peersCount() > 0).
 *
 * If this goes GREEN, in-process late-admit ATTACH works (corestore's
 * ondownloading→attachAll, driven by mergeOnePass's per-remote update()), which
 * would mean the rig failure is NOT an in-process attach-code gap but a transport
 * (dead-data-path) phenomenon — a re-attach-on-admit fix would be a no-op. If it
 * goes RED, there is a genuine in-process attach gap to fix at the attach seam.
 */
import { afterEach, describe, it, expect } from 'vitest';
import { federateTwoPeerPresence, rigAfterEach, pollUntil } from './_cross-peer-rig';

describe('WI-183 — a peer log admitted AFTER connect attaches a live replicator (in-process, real testnet transport)', () => {
  afterEach(rigAfterEach);

  it(
    "B admits A's log after connect; A's admitted remote log shows a live replicator peer (peersCount > 0)",
    async () => {
      const { peerA, peerB, federated } = await federateTwoPeerPresence();

      // Federation completing at all means replication DID deliver A's presence to
      // B (and vice-versa) — i.e. a replicator attached at some point.
      expect(
        federated,
        'two-peer presence federation timed out (replication never delivered)',
      ).toBeTruthy();

      const aKey = peerA.handle.ownLog.keyHex;
      const bKey = peerB.handle.ownLog.keyHex;

      // Both admitted the other (post-connect announce → admit → openRemoteLog).
      const aOnB = peerB.handle.admitted.get(aKey) as
        | { peersCount?: () => number | undefined }
        | undefined;
      const bOnA = peerA.handle.admitted.get(bKey) as
        | { peersCount?: () => number | undefined }
        | undefined;
      expect(aOnB, "B never admitted A's log").toBeTruthy();
      expect(bOnA, "A never admitted B's log").toBeTruthy();

      // THE WI-183 SIGNAL: poll a few merge passes (each mergeNow calls
      // update() on every admitted remote → corestore ondownloading→attachAll)
      // and require a LIVE replicator peer to be attached on BOTH sides.
      const attached = await pollUntil(
        async () => {
          await peerA.handle.mergeNow();
          await peerB.handle.mergeNow();
          const pa = aOnB!.peersCount?.() ?? 0;
          const pb = bOnA!.peersCount?.() ?? 0;
          return pa > 0 && pb > 0 ? { pa, pb } : undefined;
        },
        { timeoutMs: 15_000, intervalMs: 250 },
      );

      expect(
        attached,
        "admitted-but-never-attached (WI-183 M1): a peer log is in `admitted` but its " +
          'Hypercore shows 0 live replicator peers after repeated merge passes',
      ).toBeTruthy();
      expect(attached!.pa, "A's log on B has no live replicator peer").toBeGreaterThan(0);
      expect(attached!.pb, "B's log on A has no live replicator peer").toBeGreaterThan(0);
    },
    60_000,
  );
});
