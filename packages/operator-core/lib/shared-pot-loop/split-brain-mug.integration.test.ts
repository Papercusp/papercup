/**
 * split-brain-mug.integration.test.ts — P-005 of
 * `shared-hive-loop-e2e-testing-2026-06-10`: the split-brain Mug PROBE on
 * the hermetic 2-swarm composition rig, plus the D-008 guard + detector.
 *
 * ## What the probe DOCUMENTS (the at-HEAD behavior, previously unspecified)
 * Both swarms wake a Mug and steer the shared backlog with OPPOSITE
 * priorities. Nothing prevents it, nothing detects it, nothing crashes:
 * the steers interleave through the CDC chain and per-item LWW silently
 * crowns the LAST writer — the first Mug's entire prioritization is
 * dropped on the floor. The system CONVERGES (both PGs agree), so this is
 * THRASH, not divergence: dispatch follows whichever Mug happened to write
 * last, and the losing Mug is never told.
 *
 * ## What closes the gap (mug-guard.ts, D-008)
 *  - `evaluateQueenTurnGate` — the home-swarm assertion: with a recorded
 *    mug home, the non-home swarm's Mug turn is REFUSED before it can
 *    steer (unset home fails open — convention-only Hives keep working).
 *  - `detectDoubleSteering` — the detection invariant: two distinct steerers
 *    in one window = an incident with contested-item forensics (the P-013
 *    monitor family consumes this).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bootCompositionRig, type CompositionRig } from './composition-rig';
import { detectDoubleSteering, evaluateQueenTurnGate, type SteeringEvent } from './mug-guard';

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

const BACKLOG = ['F-301', 'F-302', 'F-303', 'F-304'];
/** Mug A's order: F-301 first. */
const STEER_A = [
  { id: 'F-301', priority: 0 },
  { id: 'F-302', priority: 10 },
  { id: 'F-303', priority: 20 },
  { id: 'F-304', priority: 30 },
];
/** Mug B's order: the exact OPPOSITE — F-304 first. */
const STEER_B = [
  { id: 'F-304', priority: 0 },
  { id: 'F-303', priority: 10 },
  { id: 'F-302', priority: 20 },
  { id: 'F-301', priority: 30 },
];

describe('P-005 — split-brain Mug: probe the unguarded behavior, then the D-008 gate + detector', () => {
  it(
    'PROBE: both swarms steer opposite orders — converged but THRASHED (last writer silently wins); the detector fires; the gate refuses the non-home Mug',
    async () => {
      rig = await bootCompositionRig({ harnessSlug: 'shl-sbq' });
      const { a, b } = rig.cells;
      await rig.seedBacklog(a, BACKLOG.map((id) => ({ id })));
      expect((await rig.converge()).fixedPoint).toBe(true);

      // ── Split-brain: A steers, then B steers the OPPOSITE before any
      //    convergence — two live Mugs, neither aware of the other. ──
      const tA = rig.now();
      await rig.mugTurn(a, () => STEER_A);
      const tB = rig.now();
      await rig.mugTurn(b, () => STEER_B);

      // ── Document the outcome: the system CONVERGES (no split), but to the
      //    LAST writer's order — Mug A's steering is silently dropped. ──
      const settle = await rig.converge({ maxPasses: 16 });
      expect(settle.fixedPoint, 'split-brain steering broke convergence (echo loop?)').toBe(true);
      const orderOf = async (cell: typeof a) =>
        new Map((await rig!.readBacklog(cell)).map((r) => [r.feature_id, r.feature_order]));
      const onA = await orderOf(a);
      const onB = await orderOf(b);
      for (const s of STEER_B) {
        expect(onA.get(s.id), `cell a: ${s.id} should carry the LAST steer (B's)`).toBe(s.priority);
        expect(onB.get(s.id), `cell b: ${s.id} should carry the LAST steer (B's)`).toBe(s.priority);
      }
      // Dispatch now follows the LATER Mug: the steered head is B's F-304,
      // even on swarm A — A's own Mug decision does not drive A's dispatch.
      const next = await rig.claimNext(a);
      expect(next?.item.id).toBe('F-304');

      // ── The detection invariant fires with full forensics. ──
      const events: SteeringEvent[] = [
        ...STEER_A.map((s) => ({ workItemId: s.id, steererPubkey: a.electionPubkey, tsMs: tA })),
        ...STEER_B.map((s) => ({ workItemId: s.id, steererPubkey: b.electionPubkey, tsMs: tB })),
      ];
      const incidents = detectDoubleSteering(events, 60_000);
      expect(incidents).toHaveLength(1);
      expect(incidents[0].steerers.sort()).toEqual([a.electionPubkey, b.electionPubkey].sort());
      expect(incidents[0].contestedItems).toEqual(BACKLOG);

      // ── The gate closes the hole: with a recorded mug home (= swarm A),
      //    the non-home Mug turn is refused BEFORE it can steer. ──
      const home = a.electionPubkey;
      const gateA = evaluateQueenTurnGate({ selfPubkey: a.electionPubkey, queenHomePubkey: home });
      const gateB = evaluateQueenTurnGate({ selfPubkey: b.electionPubkey, queenHomePubkey: home });
      expect(gateA).toEqual({ ok: true, reason: 'home-swarm' });
      expect(gateB).toEqual({ ok: false, reason: 'not-home-swarm', queenHomePubkey: home });
      // A guarded re-steer: only the home Mug's turn executes …
      await rig.mugTurn(a, () => STEER_A);
      if (gateB.ok) await rig.mugTurn(b, () => STEER_B); // refused → never runs
      expect((await rig.converge({ maxPasses: 16 })).fixedPoint).toBe(true);
      // … so BOTH swarms now follow the home Mug's order, stably.
      const onAG = await orderOf(a);
      const onBG = await orderOf(b);
      for (const s of STEER_A) {
        if (s.id === 'F-304') continue; // claimed above — its order no longer drives dispatch
        expect(onAG.get(s.id)).toBe(s.priority);
        expect(onBG.get(s.id)).toBe(s.priority);
      }
      // Unset home fails open (convention-only Hives keep working).
      expect(evaluateQueenTurnGate({ selfPubkey: b.electionPubkey, queenHomePubkey: null }).ok).toBe(true);
    },
    180_000,
  );
});
