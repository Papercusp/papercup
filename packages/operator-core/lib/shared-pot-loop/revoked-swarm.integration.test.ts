/**
 * revoked-swarm.integration.test.ts — P-011 of
 * `shared-hive-loop-e2e-testing-2026-06-10`: revoked-swarm-mid-run, the
 * HERMETIC rung (the item unblocked when shared-hive-federation P-006 shipped
 * the per-Hive revoke; the real-metal replay rides the owner-gated Hetzner
 * runbook with P-008/P-009).
 *
 * Swarm B holds a lease mid-feature when the Hive revokes it
 * (`handle.revoke(devicePubkey)` — blocklist + drop B's log from the admitted
 * set + immediate re-merge). What the rung proves:
 *
 *  1. NO ZOMBIE FEDERATION — B's post-revocation writes (its zombie pipeline
 *     completing the item) NEVER reach A's PG; the views diverge BY DESIGN
 *     (B's sovereignty over its own DB is not A's problem).
 *  2. FEDERATION ASYMMETRY at the log layer (P-007, shared-hive-rekey-2026-06-19):
 *     revocation is one-sided here — A's writes still reach B (B never revoked A).
 *     This rig models federation at the PG/CDC layer with NO epoch crypto, so it
 *     faithfully witnesses only that log-layer asymmetry. The RE-KEY content
 *     read-cut (C-001 read-plane revocation: member-remove advances the hive epoch
 *     and A's post-boundary content is encrypted to the REMAINING members only, so
 *     the revoked peer reads ciphertext it cannot decrypt) runs the REAL crypto
 *     op-path and is witnessed by its DEDICATED tests — hive-epoch-read-cut-witness
 *     (K-CUT) + hive-late-join-epoch-decrypt-federation — NOT this rig. (EI-6788: a
 *     prior flag-gated `rekeyOn` branch tried to witness the crypto cut-off here; it
 *     was a false witness and broke when `papercusp-hive-rekey` graduated default-on,
 *     since the flag was on but the read-cut it gates lives in the hyperbee layer.)
 *  3. AUTHORITY MEMBERSHIP ENFORCEMENT (EI-284 — was the probed gap, now
 *     fixed): the claim-op layer gates acquire/heartbeat on the CALLER's hive
 *     standing (`registerWorkItemClaimAuthorityOps` isCallerRevoked seam; the
 *     rig bridges the election→announce pubkey domains). A revoked swarm's
 *     lease RPC is REFUSED (`refused:'caller_revoked'`) — it can neither
 *     steal the lease nor block the live swarm. Residual on EI-284's thread:
 *     the envelope is unauthenticated, so the holder pubkey is self-reported
 *     (defense-in-depth, not anti-spoofing).
 *  4. IN-FLIGHT SEMANTICS — the revoked holder's lease lapses (injected
 *     clock), the orphan sweep (P-013) returns the federated `taken_by`, the
 *     surviving swarm re-runs the item, and D-007 adoption picks the
 *     lease-current survivor over the revoked zombie's completion.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bootCompositionRig, type CompositionRig } from './composition-rig';
import { sweepOrphanedTakenBy } from './fleet-monitors';
import { adoptCompletion, type CompletionRecord } from './lease-steal-semantics';
import type { WorkItemClaim } from '../work-item-claims';

vi.mock('@papercusp/db-org', async () => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  const { currentCellSql } = await import('./cell-scope');
  return {
    ...actual,
    getOrgPg: () => {
      const sql = currentCellSql();
      if (!sql) throw new Error('getOrgPg outside cell scope — wrap the call in rig.runAsCell()');
      return { sql };
    },
  };
});

let rig: CompositionRig | undefined;

afterEach(async () => {
  await rig?.close();
  rig = undefined;
});

const HARNESS = 'shl-rev';

const record = (executor: string, claim: WorkItemClaim, at: number): CompletionRecord => ({
  workItemId: claim.workItemId,
  executor,
  claim: {
    workItemId: claim.workItemId,
    holderPubkey: claim.holderPubkey ?? 'missing',
    owner: claim.owner,
    claimId: claim.claimId,
    acquiredTs: claim.acquiredTs,
  },
  completedAtMs: at,
});

describe('P-011 — revoked-swarm-mid-run (hermetic rung)', () => {
  it(
    'revocation stops the zombie federating; the authority refuses the revoked caller (EI-284); the in-flight item recovers via sweep + D-007 adoption',
    async () => {
      rig = await bootCompositionRig({ harnessSlug: HARNESS, claimTtlSec: 60 });
      const { a, b } = rig.cells;
      await rig.seedBacklog(a, [{ id: 'F-601' }, { id: 'F-602' }, { id: 'F-603' }]);
      expect((await rig.converge()).fixedPoint).toBe(true);

      // ── B claims F-601 through the live authority and goes mid-feature. ──
      const cB = await rig.claimNext(b);
      expect(cB).toMatchObject({ item: { id: 'F-601' }, leased: true, via: 'remote-authority' });
      expect((await rig.converge()).fixedPoint).toBe(true); // A sees taken_by=b

      // ── THE REVOCATION (per-Hive revoke, federation P-006's machinery). ──
      await a.handle.revoke(b.announcePubkey);

      // ── 1. No zombie federation: B's zombie pipeline completes LOCALLY only. ──
      await rig.runFakePipeline(b, 'F-601');
      expect((await rig.converge()).fixedPoint).toBe(true); // drains settle; A just no longer reads B
      const aView = new Map((await rig.readBacklog(a)).map((r) => [r.feature_id, r.status]));
      const bView = new Map((await rig.readBacklog(b)).map((r) => [r.feature_id, r.status]));
      expect(bView.get('F-601')).toBe('passed'); // B's own DB — its sovereignty
      expect(aView.get('F-601'), "the revoked swarm's completion must NOT reach the Hive").not.toBe('passed');

      // ── 2. FEDERATION ASYMMETRY at the log layer (this hermetic rig's faithful,
      //    crypto-free behavior). Revocation is ONE-SIDED here: A stopped reading B
      //    (step 1), but B never revoked A, so A's post-revocation writes STILL
      //    federate to B. This rig models federation at the PG/CDC layer with NO
      //    epoch crypto, so it cannot — and must not — witness the RE-KEY content
      //    read-cut (P-007: A encrypting post-boundary content to the REMAINING
      //    members only, so the revoked peer reads ciphertext it cannot decrypt).
      //    That end-to-end read-cut runs the REAL XChaCha20-Poly1305 op-path and is
      //    witnessed by its dedicated tests — hive-epoch-read-cut-witness.test.ts
      //    (K-CUT) and hive-late-join-epoch-decrypt-federation.integration.test.ts —
      //    NOT here. (EI-6788: a prior flag-gated `rekeyOn` branch asserted the crypto
      //    cut-off in this rig; it was a false witness — the rig has no crypto op-path
      //    to activate — and broke the moment `papercusp-hive-rekey` graduated to
      //    default-on, since the flag was on but the read-cut it gates lives in the
      //    hyperbee layer, not this federation model.) ──
      const cA = await rig.claimNext(a);
      expect(cA).toMatchObject({ item: { id: 'F-602' }, leased: true, via: 'local-authority' });
      await rig.runFakePipeline(a, 'F-602');
      expect((await rig.converge()).fixedPoint).toBe(true);
      const bF602 = new Map((await rig.readBacklog(b)).map((r) => [r.feature_id, r.status])).get(
        'F-602',
      );
      expect(
        bF602,
        "log-layer asymmetry: the revoking side's writes still federate to the revoked peer (the crypto read-cut is witnessed by the real-crypto epoch tests, not this rig)",
      ).toBe('passed');

      // ── 3. Authority MEMBERSHIP ENFORCEMENT (EI-284, flipped from the filed
      //    gap): the revoked swarm's lease RPC is REFUSED on caller standing —
      //    it can no longer steal the lease or block the live swarm at all. ──
      const stolen = await rig.acquirePotLease(b, 'F-603', { intent: 'revoked swarm still claiming' });
      expect(stolen.via).toBe('remote-authority');
      expect(
        stolen.value.ok,
        'the authority op layer now checks caller standing (EI-284) — a revoked swarm must be refused',
      ).toBe(false);
      expect((stolen.value as { refused?: string }).refused).toBe('caller_revoked');
      // The live swarm claims F-603 IMMEDIATELY — no zombie grant to lapse.
      const unblocked = await rig.claimNext(a);
      expect(unblocked).toMatchObject({ item: { id: 'F-603' }, leased: true });
      await rig.runFakePipeline(a, 'F-603');
      // (Step 4 still needs B's ORIGINAL F-601 lease lapsed before the sweep
      // reclaim — the advance that previously also aged the zombie grant.)
      rig.advanceClock(61_000);

      // ── 4. The in-flight item: lease lapsed above; the sweep returns the
      //    federated taken_by and the survivor re-runs F-601. ──
      const swept = await sweepOrphanedTakenBy(a.sql, {
        workspaceId: rig.workspaceId,
        harness: HARNESS,
        nowMs: Date.now() + 6 * 60_000,
      });
      expect(swept.cleared.map((c) => c.workItemId)).toEqual(['F-601']);
      const reclaim = await rig.claimNext(a);
      expect(reclaim).toMatchObject({ item: { id: 'F-601' }, leased: true });
      await rig.runFakePipeline(a, 'F-601');

      // D-007 adoption composes: the survivor's lease-current completion is
      // adopted; the revoked zombie's (earlier acquire!) is superseded.
      const verdict = adoptCompletion(
        [record('b-zombie', cB!.claim!, 1), record('a-survivor', reclaim!.claim!, 2)],
        a.store.getClaim(rig.workspaceId, HARNESS, 'F-601')?.claimId ?? null,
      )!;
      expect(verdict.rule).toBe('lease-current');
      expect(verdict.adopted.executor).toBe('a-survivor');

      // The Hive's authoritative view ends fully settled; the revoked swarm's
      // zombie state stays its own.
      expect((await rig.converge()).fixedPoint).toBe(true);
      const finalA = new Map((await rig.readBacklog(a)).map((r) => [r.feature_id, r.status]));
      expect(finalA.get('F-601')).toBe('passed');
      expect(finalA.get('F-602')).toBe('passed');
      expect(finalA.get('F-603')).toBe('passed');
      expect(await rig.outboxDepth(a)).toBe(0);
    },
    180_000,
  );
});
