/**
 * arm-reversible-action.test.ts — the P-114 arm-call-site seam
 * (queen-autonomy-policy-2026-06-13 P-114; D-006 / D-025 / D-030). Unit-pins the
 * two-phase contract with injected fakes (no PG / no flags):
 *   - the DISARMED / never-auto path is a no-op (behavior-neutral, D-007 — today's
 *     whole population, since every ceiling ships never-auto);
 *   - the `auto` path returns the decision;
 *   - commit records the `act` disposition FIRST, then arms the tripwire threaded
 *     with that disposition row's id as the shared `decisionId` — the exact B-13 ↔
 *     B-16 join key the read surface LEFT-JOINs on (autonomy_tripwires.decision_id =
 *     decision_ledger.id, mig 269).
 */
import { describe, it, expect, vi } from 'vitest';
import type { Sql } from 'postgres';
import type { DeciderDeps } from './decider';
import type { AutonomyCategoryPolicy } from './policy';
import type { RevertHandle } from './tripwire/core';
import { planReversibleArm, commitReversibleArm, type ArmReversibleDeps } from './arm-reversible-action';

const SQL = {} as Sql; // never touched — all IO is injected
const WS = 'default';

/** A policy at a given ceiling (unlocked) — `critical` admits every risk tier. */
function policy(ceiling: AutonomyCategoryPolicy['ceiling']): (c: string) => Promise<AutonomyCategoryPolicy> {
  return async (category) =>
    ({ category, ceiling, locked: false, graduatedLevel: ceiling, thresholdOverrides: {}, ownerOverride: null }) as AutonomyCategoryPolicy;
}
/** ARMED + permissive: the gate rules `auto` for any non-protected mapped action. */
const armedAuto: DeciderDeps = { isArmed: async () => true, isFullAutonomy: async () => false, getPolicy: policy('critical') };
/** The shipped default — disarmed; the gate gates EVERYTHING. */
const disarmed: DeciderDeps = { isArmed: async () => false, isFullAutonomy: async () => false, getPolicy: policy('never-auto') };

function makeDeps(decider: DeciderDeps, over: Partial<ArmReversibleDeps> = {}): ArmReversibleDeps {
  return {
    decider,
    recordDisposition: vi.fn(async () => 4242 as number | null),
    armTripwire: vi.fn(async () => ({ armed: true as const, id: 'tw-7' })),
    nowMs: () => 1_000,
    ...over,
  };
}

const handle: RevertHandle = { kind: 'work-item-state', id: 'WI-1', priorState: 'todo' };

describe('arm-reversible-action — P-114 two-phase seam', () => {
  describe('planReversibleArm (phase 1, gate-first)', () => {
    it('returns null on the DISARMED path (behavior-neutral — the whole population today)', async () => {
      expect(await planReversibleArm(SQL, WS, { action: 'work_items:set_state' }, makeDeps(disarmed))).toBeNull();
    });

    it('returns the decision when the policy AUTO-decides (armed + permissive ceiling)', async () => {
      const r = await planReversibleArm(SQL, WS, { action: 'work_items:set_state', riskTier: 'low' }, makeDeps(armedAuto));
      expect(r).not.toBeNull();
      expect(r!.posture).toBe('auto');
      expect(r!.category).toBe('work-prioritization');
    });

    it('returns null for an empty workspace', async () => {
      expect(await planReversibleArm(SQL, '', { action: 'work_items:set_state' }, makeDeps(armedAuto))).toBeNull();
    });
  });

  describe('commitReversibleArm (phase 2, disposition-first + threaded decisionId)', () => {
    it('records an `act` disposition then arms the tripwire threaded with that row id', async () => {
      const d = makeDeps(armedAuto);
      const decision = (await planReversibleArm(SQL, WS, { action: 'work_items:set_state', riskTier: 'low' }, d))!;
      const res = await commitReversibleArm(SQL, WS, decision, { revertHandle: handle, itemRef: 'WI-1' }, d);

      expect(res).toEqual({ armed: true, tripwireId: 'tw-7', decisionId: '4242' });
      expect(d.recordDisposition).toHaveBeenCalledWith(
        expect.objectContaining({ workspaceId: WS, disposition: 'act', links: { itemRef: 'WI-1' } }),
      );
      // The shared decisionId threaded onto the tripwire IS the disposition row id.
      expect(d.armTripwire).toHaveBeenCalledWith(
        SQL,
        WS,
        expect.objectContaining({ revertHandle: handle, decisionId: '4242' }),
        1_000,
      );
    });

    it('surfaces armed:false when the tripwire store refuses (subsystem dark / refused)', async () => {
      const d = makeDeps(armedAuto, { armTripwire: vi.fn(async () => ({ armed: false as const, reason: 'subsystem dark' })) });
      const decision = (await planReversibleArm(SQL, WS, { action: 'work_items:set_state', riskTier: 'low' }, d))!;
      expect(await commitReversibleArm(SQL, WS, decision, { revertHandle: handle }, d)).toEqual({
        armed: false,
        reason: 'subsystem dark',
      });
    });

    it('threads a null decisionId (and omits it on the wire) when the disposition write returns null', async () => {
      const d = makeDeps(armedAuto, { recordDisposition: vi.fn(async () => null) });
      const decision = (await planReversibleArm(SQL, WS, { action: 'work_items:set_state', riskTier: 'low' }, d))!;
      expect(await commitReversibleArm(SQL, WS, decision, { revertHandle: handle }, d)).toEqual({
        armed: true,
        tripwireId: 'tw-7',
        decisionId: null,
      });
      const armInput = (d.armTripwire as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]![2] as {
        decisionId?: string;
      };
      expect(armInput.decisionId).toBeUndefined();
    });
  });
});
