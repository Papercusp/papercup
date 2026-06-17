/**
 * hive-membership-teardown-federation.integration.test.ts — the federation half of
 * the lifecycle membership-teardown gaps (test-coverage gaps G24 + G27,
 * shared-hive-federation-2026-06-08).
 *
 * Two REAL Swarms of one Hive over a loopback testnet DHT, each with the Hive's
 * `hive_members` admission record projected into its OWN throwaway PG via the REAL
 * mig-189 capture trigger + the REAL hive-members projection (the same path the
 * single-PG `hive-members-federation-trigger` + `hive-members.integration` tests
 * exercise, now end-to-end across two peers).
 *
 * ── What this PROVES (the substrate CAN federate a membership teardown) ──
 *   1. a hive_members row written on A federates to B (admission replication);
 *   2. DELETING that row on A (the membership-teardown leg) enqueues a `del` via
 *      the mig-189 custom capture trigger, federates A→B, and REMOVES the member
 *      from B's `hive_members` — the exact tombstone path G24 says dissolve "may
 *      not" have, and the persistent-membership path G27 says leave-hive doesn't
 *      clean. So the SUBSTRATE supports a federated membership teardown.
 *
 * ── What this DOCUMENTS (the real lifecycle gaps) ──
 *   `lifecycle-membership-teardown.gap.test.ts` (the sibling unit test) then proves
 *   that neither `leaveHive` nor `hive:dissolve` actually DELETES a hive_members
 *   row — so the federated teardown proven here is never TRIGGERED by either
 *   lifecycle op today. G24 (dissolve has no federated membership tombstone) and
 *   G27 (leave cleans presence but NOT membership) are both confirmed REAL gaps:
 *   the transport exists; the lifecycle ops don't call it.
 */
import { afterEach, describe, it, expect } from 'vitest';
import {
  bootTwoHivePeers,
  memberUserIds,
  pollUntil,
  rigAfterEach,
  WORKSPACE_ID,
  HIVE_SLUG,
} from './_hive-substrate-rig';
import { upsertHiveMember } from '../../../hive-membership-store';

afterEach(rigAfterEach);

describe('hive_members membership-teardown federation (G24 / G27 transport)', () => {
  it(
    "a member written on A federates to B; DELETING it on A federates a del that removes B's row",
    async () => {
      const { dbA, dbB, idA, idB, mergeBoth, drainBoth } = await bootTwoHivePeers();

      // ── Seed BOTH peers' OWN member row through the REAL store (fires the mig-189
      // capture trigger → outbox). Each peer is the sole writer of its own row. ──
      await upsertHiveMember(
        { workspaceId: WORKSPACE_ID, hiveHomeSlug: HIVE_SLUG, githubUserId: idA.userId, githubUsername: 'alice', bindingStatus: 'verified' },
        dbA.sql,
      );
      await upsertHiveMember(
        { workspaceId: WORKSPACE_ID, hiveHomeSlug: HIVE_SLUG, githubUserId: idB.userId, githubUsername: 'bob', bindingStatus: 'verified' },
        dbB.sql,
      );

      // Drain each peer's outbox onto its own log, then merge until BOTH peers hold
      // BOTH members (admission record federated).
      await drainBoth();
      const bothPresent = await pollUntil(
        async () => {
          await mergeBoth();
          await drainBoth();
          const a = await memberUserIds(dbA.sql);
          const b = await memberUserIds(dbB.sql);
          return a.has(idA.userId) && a.has(idB.userId) && b.has(idA.userId) && b.has(idB.userId)
            ? { a, b }
            : undefined;
        },
        { timeoutMs: 25_000, intervalMs: 250 },
      );
      expect(bothPresent, "members never fully federated A↔B").toBeTruthy();

      // ── THE TEARDOWN: delete peer A's OWN member row (a membership teardown). The
      // mig-189 custom capture trigger enqueues a `del` keyed by github_user_id,
      // scoped to the Hive home slug — exactly what a federated dissolve/leave would
      // produce IF it deleted the row. ──
      await dbA.sql`
        DELETE FROM harness_shared.hive_members
         WHERE workspace_id = ${WORKSPACE_ID} AND hive_home_slug = ${HIVE_SLUG}
           AND github_user_id = ${idA.userId}
      `;
      // Confirm the del was captured on A.
      const [{ n }] = await dbA.sql<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM harness_shared.substrate_outbox
         WHERE table_name = 'hive_members' AND op = 'del' AND key = ${String(idA.userId)}
      `;
      expect(n, "A's member DELETE was not captured as a del op").toBe(1);

      // It federates A→B and B's read-merge DELETES peer A's hive_members row.
      const droppedOnB = await pollUntil(
        async () => {
          await mergeBoth();
          await drainBoth();
          const b = await memberUserIds(dbB.sql);
          return !b.has(idA.userId) ? true : undefined;
        },
        { timeoutMs: 25_000, intervalMs: 250 },
      );
      expect(droppedOnB, "A's membership teardown never federated to B (the del op did not remove B's row)").toBe(true);

      // The del is scoped to A's key — peer B's OWN member row is untouched.
      expect((await memberUserIds(dbB.sql)).has(idB.userId)).toBe(true);
    },
    60_000,
  );
});
