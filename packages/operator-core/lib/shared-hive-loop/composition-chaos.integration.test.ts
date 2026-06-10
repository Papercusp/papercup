/**
 * composition-chaos.integration.test.ts — P-002 + P-003 of
 * `shared-hive-loop-e2e-testing-2026-06-10`: the partition and kill-authority
 * scenarios run against the SAME hermetic 2-swarm composition rig as the
 * P-001 happy path — full cycle, never an isolated layer (D-001).
 *
 * P-002 — partition mid-feature: the authority RPC becomes unreachable while
 * both sides keep working. The minority side's claims FAIL OPEN to local
 * advisory leases (D-007 hybrid) — a deliberate double-execution forms on the
 * contested item — then the partition heals, CDC convergence resumes (no echo
 * loops), and the deterministic reconcile (`work-item-claim-reconcile`)
 * resolves every contested item to exactly ONE winner, order-independently.
 *
 * P-003 — kill-authority mid-cycle (the Hetzner scenario, hermetic): the
 * authority swarm dies BETWEEN claim and completion. The survivor first fails
 * open (the dead authority is still within the presence staleness window),
 * then — once the compressed `staleMs` window passes — RE-ELECTS itself and
 * grants locally. The dead swarm's lease lapses and is stolen at the lease
 * layer; the item completes exactly once (zero double-completions: the dead
 * swarm never reached its side effect).
 *
 * Stream-pause model: merge/drain are rig-driven (mergePollMs 0), so "pausing
 * the swarm streams" during the partition = not calling converge() — the
 * hypercore replication underneath stays connected, but nothing applies to
 * either PG until heal. The authority-RPC leg of the partition is real
 * (connection refused → fail-open).
 *
 * KNOWN GAP asserted below (P-003, work-stealing at the claim_next layer):
 * a dead swarm's `taken_by` federates but never lapses, so `claim_next` alone
 * can never steal its in-flight item — the steal works at the LEASE layer
 * (acquire steals an expired lease), but the PG row stays "taken". The
 * orphaned-lease sweep that clears such rows is this plan's P-013 monitor;
 * until it lands, the assertion documents the starvation gap honestly.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bootCompositionRig, type CompositionRig } from './composition-rig';
import { evaluateCompositionOracles } from './composition-oracles';
import { contestedResolutions, reconcileAll, type AdvisoryClaim } from '../work-item-claim-reconcile';
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

/** A completion's advisory claim (the reconcile input — completions only,
 *  exactly like run-claim-dispatch's verdict computation). */
const advisory = (claim: WorkItemClaim): AdvisoryClaim => ({
  workItemId: claim.workItemId,
  holderPubkey: claim.holderPubkey ?? 'missing-pubkey',
  owner: claim.owner,
  claimId: claim.claimId,
  acquiredTs: claim.acquiredTs,
});

describe('P-002 — partition mid-feature: fail-open claims, heal, reconcile to one winner', () => {
  it(
    'minority claims fail open; on heal convergence resumes with no echo loops and reconcile yields one winner per item',
    async () => {
      rig = await bootCompositionRig({ harnessSlug: 'shl-part' });
      const { a, b } = rig.cells;
      const BACKLOG = ['F-001', 'F-002', 'F-003', 'F-004'];
      await rig.seedBacklog(a, BACKLOG.map((id) => ({ id })));
      expect((await rig.converge()).fixedPoint).toBe(true);

      // ── Healthy round: A takes F-001 (local authority), B takes F-002 (RPC). ──
      const cA1 = await rig.claimNext(a);
      expect(cA1).toMatchObject({ item: { id: 'F-001' }, leased: true, via: 'local-authority' });
      expect((await rig.converge()).fixedPoint).toBe(true); // B sees F-001 taken
      const cB1 = await rig.claimNext(b);
      expect(cB1).toMatchObject({ item: { id: 'F-002' }, leased: true, via: 'remote-authority' });
      await rig.runFakePipeline(a, 'F-001');
      await rig.runFakePipeline(b, 'F-002');
      expect((await rig.converge()).fixedPoint).toBe(true);

      // ── PARTITION. Both sides keep working; nothing converges. ──
      rig.setPartitioned(true);
      // A (the authority itself) is unaffected: local grants keep flowing.
      const pA = await rig.claimNext(a);
      expect(pA).toMatchObject({ item: { id: 'F-003' }, leased: true, via: 'local-authority' });
      // B cannot reach the authority → FAIL-OPEN local advisory lease — and its
      // stale view still shows F-003 unclaimed, so the double-claim forms.
      const pB = await rig.claimNext(b);
      expect(pB).toMatchObject({ item: { id: 'F-003' }, leased: true, via: 'fail-open' });
      await rig.runFakePipeline(a, 'F-003');
      await rig.runFakePipeline(b, 'F-003'); // the tolerated duplicate execution
      const pB2 = await rig.claimNext(b);
      expect(pB2).toMatchObject({ item: { id: 'F-004' }, leased: true, via: 'fail-open' });
      await rig.runFakePipeline(b, 'F-004');

      // ── HEAL → convergence resumes, reaches and HOLDS a fixed point. ──
      rig.setPartitioned(false);
      const heal = await rig.converge({ maxPasses: 16 });
      expect(heal.fixedPoint, 'post-heal merge+drain never settled (echo loop?)').toBe(true);

      // ── Deterministic reconcile over the COMPLETIONS' claims. ──
      const completions = [cA1, cB1, pA, pB, pB2].map((c) => advisory(c!.claim!));
      const contested = contestedResolutions(completions);
      expect(contested.map((r) => r.workItemId)).toEqual(['F-003']);
      expect(contested[0].losers).toHaveLength(1);
      // Order-independence: the reversed input picks the SAME winner.
      const reversed = reconcileAll([...completions].reverse()).find((r) => r.workItemId === 'F-003')!;
      expect(reversed.winner.claimId).toBe(contested[0].winner.claimId);

      const winnerCell = contested[0].winner.holderPubkey === a.electionPubkey ? 'a' : 'b';
      const verdict = evaluateCompositionOracles({
        backlogIds: BACKLOG,
        terminalStatus: 'passed',
        featuresByCell: { a: await rig.readBacklog(a), b: await rig.readBacklog(b) },
        sideEffectsByCell: { a: await rig.sideEffects(a), b: await rig.sideEffects(b) },
        fixedPoint: heal.fixedPoint,
        reconciledDuplicates: [{ workItemId: 'F-003', winnerCell }],
      });
      expect(verdict.failures, verdict.failures.join('\n')).toEqual([]);

      // No echo residue on either side.
      expect(await rig.outboxDepth(a)).toBe(0);
      expect(await rig.outboxDepth(b)).toBe(0);
    },
    180_000,
  );
});

describe('P-003 — kill-authority mid-cycle: fail-open → re-election → steal → zero double-completions', () => {
  it(
    'authority dies between claim and completion; survivor fails open, re-elects after the compressed staleness window, steals the lapsed lease, completes everything exactly once',
    async () => {
      // Compressed windows (the plan's "compress the 90s staleness window via
      // config"): presence staleness 4s, lease TTL 120s — both crossed via the
      // injected clock, no wall-clock sleeps.
      rig = await bootCompositionRig({ harnessSlug: 'shl-kill', staleMs: 4_000, claimTtlSec: 120 });
      const { a, b } = rig.cells;
      const BACKLOG = ['F-101', 'F-102', 'F-103'];
      await rig.seedBacklog(a, BACKLOG.map((id) => ({ id })));
      expect((await rig.converge()).fixedPoint).toBe(true);

      // ── A (the authority) claims F-101 and dies MID-PIPELINE: after the
      //    in-progress stamp, BEFORE the side effect (between claim and completion).
      const cA = await rig.claimNext(a);
      expect(cA).toMatchObject({ item: { id: 'F-101' }, leased: true, via: 'local-authority' });
      await expect(
        rig.runFakePipeline(a, 'F-101', {
          midRun: async () => {
            throw new Error('swarm A died mid-pipeline');
          },
        }),
      ).rejects.toThrow('died mid-pipeline');
      // Pre-kill replication: B sees the claim + in-progress.
      expect((await rig.converge()).fixedPoint).toBe(true);
      await rig.killAuthority();

      // ── Phase 1: within the staleness window B still elects the dead A → RPC
      //    refused → FAIL-OPEN. Work continues. ──
      const cB1 = await rig.claimNext(b);
      expect(cB1).toMatchObject({ item: { id: 'F-102' }, leased: true, via: 'fail-open' });
      await rig.runFakePipeline(b, 'F-102');

      // ── Phase 2: past the staleness window B RE-ELECTS itself → local grants. ──
      rig.advanceClock(5_000);
      const cB2 = await rig.claimNext(b);
      expect(cB2).toMatchObject({ item: { id: 'F-103' }, leased: true, via: 'local-authority' });
      await rig.runFakePipeline(b, 'F-103');

      // ── The dead swarm's in-flight item. ──
      // KNOWN GAP (documented, P-013's sweep is the fix): claim_next can NEVER
      // steal it — the dead swarm's taken_by federated and the feature row has
      // no TTL, so the PG layer reports nothing claimable.
      expect(await rig.claimNext(b)).toBeNull();
      // The steal happens at the LEASE layer (the defined semantics): once the
      // lease lapses, acquire steals it — here the re-elected survivor grants
      // itself the lapsed item locally and re-runs the pipeline.
      rig.advanceClock(121_000);
      const steal = await rig.acquireHiveLease(b, 'F-101', { intent: 'work-steal of dead swarm lease' });
      expect(steal.via).toBe('local-authority');
      expect(steal.value.ok).toBe(true);
      await rig.runFakePipeline(b, 'F-101');

      // ── Settle the SURVIVOR (the dead cell is never driven again). ──
      const settle = await rig.converge({ cells: ['b'] });
      expect(settle.fixedPoint).toBe(true);

      // Zero double-completions: A died before its side effect, so every item
      // executed exactly once (all on B) and no completion contest exists.
      const completions = [cB1!.claim!, cB2!.claim!, steal.value.ok ? steal.value.claim : null]
        .filter((c): c is WorkItemClaim => !!c)
        .map(advisory);
      expect(contestedResolutions(completions)).toEqual([]);

      const verdict = evaluateCompositionOracles({
        backlogIds: BACKLOG,
        terminalStatus: 'passed',
        featuresByCell: { b: await rig.readBacklog(b) }, // the dead cell's PG is out of scope
        sideEffectsByCell: { a: await rig.sideEffects(a), b: await rig.sideEffects(b) },
        fixedPoint: settle.fixedPoint,
      });
      expect(verdict.failures, verdict.failures.join('\n')).toEqual([]);
      expect(await rig.outboxDepth(b)).toBe(0);
    },
    180_000,
  );
});
