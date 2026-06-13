/**
 * leave-hive-tombstone-federation.integration.test.ts — the end-to-end proof for
 * EI-469's tail (shared-hive-hardening-2026-06-13): a presence TOMBSTONE
 * published on leave federates across the real Hyperswarm replication path and
 * DELETES the leaver's row from a peer's `shared_presence` — not just appends an
 * op, but the remote PG row actually disappears.
 *
 * Reuses the two-peer rig (_cross-peer-rig.ts): two REAL bootHarnessSubstrate
 * Swarms of one Hive on a loopback testnet DHT, each projecting federated ops
 * into its OWN throwaway PG via the REAL presence projection. This is the
 * in-process LOCAL-PARITY equivalent of the real-hardware run (plan D-003):
 * replication is real, latency is ~zero. What it proves: the del op flows A→B
 * and B's projection removes peer A's presence row (the ts-guarded deleteFromPg).
 * What it does NOT prove (the D-003 residual): that the leave DRAIN window in
 * leaveHive is long enough under REAL network latency before the swarm closes —
 * that needs two real machines.
 */
import { afterEach, describe, it, expect } from 'vitest';
import {
  federateTwoPeerPresence,
  devicePubkeysFor,
  pollUntil,
  rigAfterEach,
} from './_cross-peer-rig';
import { buildPresenceTombstoneOp } from '../presence-announce';

afterEach(rigAfterEach);

describe('presence tombstone federation (EI-469)', () => {
  it("peer A's leave tombstone deletes peer A's row from peer B's shared_presence", async () => {
    const { dbB, idA, idB, peerA, peerB, federated } = await federateTwoPeerPresence();
    // Precondition: federation complete — peer B holds peer A's presence row.
    expect(federated).toBeDefined();
    expect((await devicePubkeysFor(dbB.sql)).has(idA.devicePubkey)).toBe(true);

    // Peer A publishes a presence TOMBSTONE on its own log — exactly what
    // hive:leave does via publishPresenceTombstoneForHarness (buildPresenceTombstoneOp,
    // appended while the swarm is still live). ts well past the announce so the
    // projection's ts-guard lets the delete win.
    await peerA.handle.append({
      ...buildPresenceTombstoneOp({ githubUserId: idA.userId, machineLabel: 'machine-A' }, 5000),
      writerPubkey: idA.devicePubkey,
    });

    // It federates A→B and peer B's read-merge DELETES peer A's presence row.
    const dropped = await pollUntil(
      async () => {
        await peerB.handle.mergeNow();
        const devsB = await devicePubkeysFor(dbB.sql);
        return !devsB.has(idA.devicePubkey) ? true : undefined;
      },
      { timeoutMs: 25_000, intervalMs: 250 },
    );
    expect(dropped).toBe(true);

    // The del is scoped to peer A's key — peer B's OWN presence row is untouched.
    expect((await devicePubkeysFor(dbB.sql)).has(idB.devicePubkey)).toBe(true);
  });
});
