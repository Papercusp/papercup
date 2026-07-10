/**
 * lease-steal.integration.test.ts — P-004 of
 * `shared-hive-loop-e2e-testing-2026-06-10`: lease-steal MID-PIPELINE, the
 * plan's sharpest untested edge, on the hermetic 2-swarm composition rig.
 *
 * Swarm A's pipeline goes quiet mid-feature (no heartbeats); its lease lapses
 * (clock-compressed); swarm B legitimately STEALS the item through the live
 * authority and re-runs the whole pipeline; then A's ZOMBIE run wakes up and
 * finishes anyway. DBOS idempotency is per-swarm, so nothing in the existing
 * machinery deduplicates the cross-swarm re-run — the side effects DO
 * duplicate. The assertions pin the D-007 semantics defined for exactly this
 * (lease-steal-semantics.ts):
 *
 *   - the duplicate is DETECTED (both executors' ledgers show the item);
 *   - adoption is LEASE-CURRENT-FIRST: the stealer's completion is adopted,
 *     the zombie's is superseded — even though the zombie's acquire was
 *     EARLIER (the raw reconcile order would wrongly crown the zombie; the
 *     test asserts the divergence explicitly);
 *   - the zombie's own heartbeat reports `renewed: false` after the steal —
 *     the defined self-abort signal a production pipeline should check
 *     between side-effecting steps;
 *   - convergence still reaches a fixed point and the uncontested item stays
 *     exactly-once.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bootCompositionRig, type CompositionRig } from './composition-rig';
import { evaluateCompositionOracles, executionsByItem } from './composition-oracles';
import { adoptAll, type CompletionRecord } from './lease-steal-semantics';
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

const record = (item: string, executor: 'a' | 'b', claim: WorkItemClaim, at: number): CompletionRecord => ({
  workItemId: item,
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

describe('P-004 — lease-steal mid-pipeline (zombie holder vs legitimate stealer)', () => {
  it(
    'a lapsed lease is stolen mid-run; duplicates are detected and the LEASE-CURRENT completion is adopted over the earlier zombie acquire',
    async () => {
      rig = await bootCompositionRig({ harnessSlug: 'shl-steal', claimTtlSec: 60 });
      const { a, b } = rig.cells;
      await rig.seedBacklog(a, [{ id: 'F-201' }, { id: 'F-202' }]);
      expect((await rig.converge()).fixedPoint).toBe(true);

      // ── A claims F-201 (60s lease) and goes quiet mid-pipeline. ──
      const cA = await rig.claimNext(a);
      expect(cA).toMatchObject({ item: { id: 'F-201' }, leased: true, via: 'local-authority' });

      let stealClaim: WorkItemClaim | null = null;
      // A's pipeline: the midRun hook is the "gone quiet" window — the lease
      // lapses, B steals THROUGH THE LIVE AUTHORITY and re-runs to completion,
      // and only then does A's zombie resume and finish its own run.
      await rig.runFakePipeline(a, 'F-201', {
        midRun: async () => {
          rig!.advanceClock(61_000); // the lease lapses — no heartbeat for a full TTL
          const steal = await rig!.acquirePotLease(b, 'F-201', { intent: 'work-steal: holder lease lapsed' });
          expect(steal.via).toBe('remote-authority'); // through the LIVE authority — a real steal, not fail-open
          expect(steal.value.ok, 'the lapsed lease was not stealable').toBe(true);
          if (steal.value.ok) stealClaim = steal.value.claim;
          // The stealer re-runs the WHOLE pipeline (per-swarm idempotency
          // cannot dedupe a cross-swarm re-run — the P-004 edge).
          await rig!.runFakePipeline(b, 'F-201');
        },
      });

      // ── The zombie's heartbeat now reports the abort signal (D-007 rule 5). ──
      const zombieHb = await a.store.heartbeat({
        workspaceId: rig.workspaceId,
        harnessSlug: 'shl-steal',
        workItemId: 'F-201',
        claimId: cA!.claim!.claimId,
        owner: a.owner,
      });
      expect(zombieHb.renewed).toBe(false);
      expect(zombieHb.reason).toMatch(/another owner|new claim_id/);

      // ── B also takes the uncontested item (exactly-once elsewhere intact). ──
      const cB2 = await rig.claimNext(b);
      expect(cB2).toMatchObject({ item: { id: 'F-202' }, leased: true });
      await rig.runFakePipeline(b, 'F-202');

      const settle = await rig.converge({ maxPasses: 16 });
      expect(settle.fixedPoint).toBe(true);

      // ── Duplicates DETECTED: both executors ran F-201. ──
      const sideEffects = { a: await rig.sideEffects(a), b: await rig.sideEffects(b) };
      expect([...(executionsByItem(sideEffects).get('F-201') ?? [])].sort()).toEqual(['a', 'b']);

      // ── D-007 adoption: lease-current (the stealer) wins; zombie superseded. ──
      expect(stealClaim).not.toBeNull();
      const records = [
        record('F-201', 'a', cA!.claim!, 1),
        record('F-201', 'b', stealClaim!, 2),
        record('F-202', 'b', cB2!.claim!, 3),
      ];
      // The authority view: cell a's store is the live authority store.
      const verdicts = adoptAll(records, (item) => a.store.getClaim(rig!.workspaceId, 'shl-steal', item)?.claimId ?? null);
      const f201 = verdicts.find((v) => v.workItemId === 'F-201')!;
      expect(f201.rule).toBe('lease-current');
      expect(f201.adopted.executor).toBe('b');
      expect(f201.superseded.map((r) => r.executor)).toEqual(['a']);
      // And the raw total order would have crowned the zombie — the defined
      // semantics deliberately diverge from naive reconcile here.
      const naive = adoptAll(records, () => null).find((v) => v.workItemId === 'F-201')!;
      expect(naive.adopted.executor).toBe('a');

      // ── Whole-cycle oracles: F-201 is a declared reconciled duplicate with
      //    the stealer adopted; F-202 exactly-once; fixpoint; liveness. ──
      const verdict = evaluateCompositionOracles({
        backlogIds: ['F-201', 'F-202'],
        terminalStatus: 'passed',
        featuresByCell: { a: await rig.readBacklog(a), b: await rig.readBacklog(b) },
        sideEffectsByCell: sideEffects,
        fixedPoint: settle.fixedPoint,
        reconciledDuplicates: [{ workItemId: 'F-201', winnerCell: 'b' }],
      });
      expect(verdict.failures, verdict.failures.join('\n')).toEqual([]);
    },
    180_000,
  );
});
