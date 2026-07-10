/**
 * composition-happy-path.integration.test.ts — P-001 of
 * `shared-hive-loop-e2e-testing-2026-06-10`: the COMPOSITION happy path.
 *
 * The full autonomous cycle, every layer real except the LLM and the DBOS
 * runtime (per D-001/D-006 — see composition-rig.ts for the exact real/fake
 * boundary):
 *
 *   1. backlog seeded on swarm A federates to swarm B (CDC chain);
 *   2. a scripted Mug turn on A REPRIORITIZES (real setWorkItemPriority →
 *      feature_order) and the steering FEDERATES to B;
 *   3. BOTH swarms claim_next CONCURRENTLY (the real priority-ordered
 *      SKIP-LOCKED claim + the per-Hive authority lease over real HTTP RPC —
 *      flags-ON shape, D-003): both pick the steered head, the authority
 *      grants exactly ONE, the loser releases and work-steals the next item;
 *   4. fake pipelines execute DISJOINT items, completions federate back;
 *   5. the oracles hold: exactly-once dispatch, fixpoint convergence,
 *      liveness, and STEERING MONOTONICITY — A's next Mug turn sees B's
 *      completed work.
 *
 * Steering federation (step 2 → B) rides the dispatch columns
 * (item_kind/feature_order/swarm_affinity/redundancy) in the features wire
 * shape + projection — the gap found during this plan's verify-first pass and
 * fixed in the audit's P-068 projection pass (brief 01). If THAT regresses,
 * this test's step-2 assertion is the tripwire.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bootCompositionRig, type CompositionRig } from './composition-rig';
import { evaluateCompositionOracles } from './composition-oracles';

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

const BACKLOG = ['F-001', 'F-002', 'F-003', 'F-004'];

describe('P-001 — hermetic 2-swarm composition happy path (steer → claim → execute → converge)', () => {
  it(
    'Mug steering on A drives concurrent cross-swarm dispatch; exactly-once + fixpoint + steering monotonicity hold',
    async () => {
      rig = await bootCompositionRig();
      const { a, b } = rig.cells;

      // ── 1. Backlog seeded on A federates to B. ──
      await rig.seedBacklog(a, BACKLOG.map((id) => ({ id })));
      const conv1 = await rig.converge();
      expect(conv1.fixedPoint, 'backlog federation never reached a fixed point').toBe(true);
      const bSeed = await rig.readBacklog(b);
      expect(bSeed.map((r) => r.feature_id)).toEqual(BACKLOG);
      expect(bSeed.every((r) => r.origin === 'remote')).toBe(true);
      // The federated rows stay CLAIMABLE: item_kind survives the wire.
      expect(bSeed.every((r) => r.item_kind === 'feature')).toBe(true);

      // ── 2. Scripted Mug turn on A: make F-004 the most urgent. ──
      const turn1 = await rig.mugTurn(a, () => [
        { id: 'F-004', priority: 0 },
        { id: 'F-001', priority: 10 },
        { id: 'F-002', priority: 20 },
        { id: 'F-003', priority: 30 },
      ]);
      expect(turn1.view).toHaveLength(BACKLOG.length);
      const conv2 = await rig.converge();
      expect(conv2.fixedPoint).toBe(true);
      const bSteered = await rig.readBacklog(b);
      const bOrder = new Map(bSteered.map((r) => [r.feature_id, r.feature_order]));
      // THE STEERING-FEDERATION TRIPWIRE (audit P-068): the Mug's
      // feature_order must reach the OTHER swarm's PG, or cross-swarm dispatch
      // ignores her priorities.
      expect(bOrder.get('F-004'), 'Mug steering (feature_order) did not federate to swarm B').toBe(0);
      expect(bOrder.get('F-003')).toBe(30);

      // ── 3. ROUND 1 — pure CONTENTION on the steered head: both swarms pick
      //    F-004 off their own PGs (steering drove BOTH dispatch decisions)
      //    and the Hive authority grants exactly ONE. ──
      const executedBy: Record<'a' | 'b', string[]> = { a: [], b: [] };
      const [ca, cb] = await Promise.all([rig.claimNext(a), rig.claimNext(b)]);
      expect(ca?.item.id).toBe('F-004');
      expect(cb?.item.id).toBe('F-004');
      expect([ca!.leased, cb!.leased].filter(Boolean)).toHaveLength(1);
      // The remote-authority leg was genuinely exercised: cell b routes its
      // lease through A's HTTP endpoint (cell a grants locally).
      expect(cb!.via).toBe('remote-authority');
      const winner = ca!.leased ? a : b;
      await rig.runFakePipeline(winner, 'F-004');
      executedBy[winner.name].push('F-004');
      expect((await rig.converge()).fixedPoint).toBe(true);

      // ── 4. The Mug PINS the remainder (swarm_affinity — the real
      //    co-location lever) and the swarms self-select DISJOINT work
      //    concurrently. Without affinity this is a pure race the authority
      //    cell systematically wins (its lease leg skips the HTTP hop) —
      //    affinity is the production mechanism that distributes it. ──
      await rig.mugPinAffinity(a, [
        { id: 'F-001', swarmPubkey: a.electionPubkey },
        { id: 'F-002', swarmPubkey: b.electionPubkey },
        { id: 'F-003', swarmPubkey: b.electionPubkey },
      ]);
      expect((await rig.converge()).fixedPoint).toBe(true);
      // Dispatch-columns tripwire #3: the pins must reach swarm B's PG.
      const bPins = new Map(
        (
          await b.sql<Array<{ feature_id: string; swarm_affinity: string | null }>>`
            SELECT feature_id, swarm_affinity FROM harness_shared.harness_features_consolidated
             WHERE harness_slug = ${rig.harnessSlug}`
        ).map((r) => [r.feature_id, r.swarm_affinity]),
      );
      expect(bPins.get('F-002'), 'swarm_affinity did not federate to swarm B').toBe(b.electionPubkey);

      for (let round = 0; round < BACKLOG.length; round++) {
        const [pa, pb] = await Promise.all([rig.claimNext(a), rig.claimNext(b)]);
        if (!pa && !pb) break;
        await Promise.all([
          pa?.leased ? rig.runFakePipeline(a, pa.item.id).then(() => executedBy.a.push(pa.item.id)) : null,
          pb?.leased ? rig.runFakePipeline(b, pb.item.id).then(() => executedBy.b.push(pb.item.id)) : null,
        ]);
        // Convergence between rounds — the loop's own cadence (completions and
        // claims federate before the next wave of claims).
        const c = await rig.converge();
        expect(c.fixedPoint, `round ${round}: merge+drain never settled`).toBe(true);
      }

      // Affinity made the distribution deterministic AND disjoint: each swarm
      // executed exactly its pinned work (B in the Mug's priority order).
      expect(executedBy.a.filter((id) => id !== 'F-004')).toEqual(['F-001']);
      expect(executedBy.b.filter((id) => id !== 'F-004')).toEqual(['F-002', 'F-003']);
      expect([...executedBy.a, ...executedBy.b].sort()).toEqual(BACKLOG);

      // ── 5. Final convergence + the Mug's NEXT turn on A. ──
      const convFinal = await rig.converge();
      const turn2 = await rig.mugTurn(a);

      const verdict = evaluateCompositionOracles({
        backlogIds: BACKLOG,
        terminalStatus: 'passed',
        featuresByCell: {
          a: await rig.readBacklog(a),
          b: await rig.readBacklog(b),
        },
        sideEffectsByCell: {
          a: await rig.sideEffects(a),
          b: await rig.sideEffects(b),
        },
        fixedPoint: convFinal.fixedPoint,
        steering: {
          nextTurnView: turn2.view,
          remoteCompletedIds: executedBy.b, // B's work — A's next wake must see it
        },
      });
      expect(verdict.failures, verdict.failures.join('\n')).toEqual([]);
      expect(verdict.pass).toBe(true);

      // Hygiene: nothing left undrained on either side (no echo residue).
      expect(await rig.outboxDepth(a)).toBe(0);
      expect(await rig.outboxDepth(b)).toBe(0);
    },
    180_000,
  );
});
