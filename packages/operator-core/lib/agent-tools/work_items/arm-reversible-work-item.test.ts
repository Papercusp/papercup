/**
 * arm-reversible-work-item.test.ts — the work_items wiring of the P-114 arm seam
 * (queen-autonomy-policy-2026-06-13 P-114). Pins, with injected IO (no PG / no
 * flags / no transport):
 *   - buildWorkItemRevertHandle for both reversible facets (state / priority);
 *   - the AUTONOMOUS-ONLY guard — a human/SU caller is never auto-watched;
 *   - gate-first: the disarmed path never reads prior state (cheap common case);
 *   - the auto path returns a plan carrying a FAITHFUL prior-state revert-handle;
 *   - the declared per-item risk is threaded so a sub-critical ceiling still arms
 *     (vs the fail-safe `critical`, which gates);
 *   - commitWorkItemArm delegates to the arm seam with that plan.
 */
import { describe, it, expect, vi } from 'vitest';
import type { Sql } from 'postgres';
import type { DeciderDeps } from '../../autonomy/decider';
import type { AutonomyCategoryPolicy } from '../../autonomy/policy';
import type { ArmReversibleDeps } from '../../autonomy/arm-reversible-action';
import type { WorkItem } from '../../work-items';
import {
  buildWorkItemRevertHandle,
  planWorkItemArm,
  commitWorkItemArm,
  type WorkItemArmIo,
  type ArmReversibleCtx,
} from './arm-reversible-work-item';

const SQL = {} as Sql;

function policy(ceiling: AutonomyCategoryPolicy['ceiling']): (c: string) => Promise<AutonomyCategoryPolicy> {
  return async (category) =>
    ({ category, ceiling, locked: false, graduatedLevel: ceiling, thresholdOverrides: {}, ownerOverride: null }) as AutonomyCategoryPolicy;
}
function armDeps(decider: DeciderDeps, over: Partial<ArmReversibleDeps> = {}): ArmReversibleDeps {
  return {
    decider,
    recordDisposition: vi.fn(async () => 99 as number | null),
    armTripwire: vi.fn(async () => ({ armed: true as const, id: 'tw-x' })),
    nowMs: () => 1,
    ...over,
  };
}
/** ARMED with a category ceiling of `ceiling` (unlocked) — `critical` admits any risk. */
const armedAt = (ceiling: AutonomyCategoryPolicy['ceiling'], over: Partial<ArmReversibleDeps> = {}) =>
  armDeps({ isArmed: async () => true, getPolicy: policy(ceiling) }, over);
const armedAuto = (over: Partial<ArmReversibleDeps> = {}) => armedAt('critical', over);
const disarmed = (over: Partial<ArmReversibleDeps> = {}) =>
  armDeps({ isArmed: async () => false, getPolicy: policy('never-auto') }, over);

function workItem(over: Partial<WorkItem> = {}): WorkItem {
  return { id: 'WI-1', harness: 'papercup', state: 'todo', priority: 5, ...over } as unknown as WorkItem;
}

// A fleet-spawn (autonomous) ctx vs a superuser (human) ctx — drives isAutonomousAgent.
const autonomousCtx = { uiClientId: 'opspawn-bee-1', sigVerifiedSpawn: true, workspaceId: 'default', harnessSlug: 'papercup' } as unknown as ArmReversibleCtx;
const humanCtx = { uiClientId: 'su-abc-session', isSuperuser: true, workspaceId: 'default' } as unknown as ArmReversibleCtx;

function io(over: Partial<WorkItemArmIo> = {}): WorkItemArmIo {
  return { resolveSql: () => SQL, readWorkItem: async () => workItem(), ...over };
}

describe('arm-reversible-work-item — P-114 work_items wiring', () => {
  describe('buildWorkItemRevertHandle', () => {
    it('builds a work-item-state handle from prior state', () => {
      expect(buildWorkItemRevertHandle('state', workItem({ state: 'in_progress' }), 'papercup')).toEqual({
        kind: 'work-item-state',
        id: 'WI-1',
        harness: 'papercup',
        priorState: 'in_progress',
      });
    });
    it('builds a work-item-priority handle from prior priority (no harness when omitted)', () => {
      expect(buildWorkItemRevertHandle('priority', workItem({ priority: 7 }))).toEqual({
        kind: 'work-item-priority',
        id: 'WI-1',
        priorPriority: 7,
      });
    });
  });

  describe('planWorkItemArm (autonomous-only, gate-first)', () => {
    it('returns null for a NON-autonomous (human/SU) caller — deliberate steering is never auto-watched', async () => {
      const readWorkItem = vi.fn(async () => workItem());
      expect(
        await planWorkItemArm(humanCtx, 'work_items:set_state', 'state', 'WI-1', 'papercup', undefined, io({ readWorkItem, arm: armedAuto() })),
      ).toBeNull();
      expect(readWorkItem).not.toHaveBeenCalled(); // short-circuits before any read
    });

    it('does NOT read prior state on the disarmed path (cheap common case)', async () => {
      const readWorkItem = vi.fn(async () => workItem());
      expect(
        await planWorkItemArm(autonomousCtx, 'work_items:set_state', 'state', 'WI-1', 'papercup', undefined, io({ readWorkItem, arm: disarmed() })),
      ).toBeNull();
      expect(readWorkItem).not.toHaveBeenCalled();
    });

    it('returns a plan with a faithful prior-state handle for an autonomous auto-decision', async () => {
      const readWorkItem = vi.fn(async () => workItem({ state: 'todo' }));
      const r = await planWorkItemArm(autonomousCtx, 'work_items:set_state', 'state', 'WI-1', 'papercup', undefined, io({ readWorkItem, arm: armedAuto() }));
      expect(r).not.toBeNull();
      expect(r!.decision.posture).toBe('auto');
      expect(r!.revertHandle).toEqual({ kind: 'work-item-state', id: 'WI-1', harness: 'papercup', priorState: 'todo' });
      expect(r!.itemRef).toBe('WI-1');
      expect(readWorkItem).toHaveBeenCalledWith('WI-1', 'papercup');
    });

    it('returns null when the prior state cannot be read (no faithful handle)', async () => {
      expect(
        await planWorkItemArm(autonomousCtx, 'work_items:set_state', 'state', 'WI-1', 'papercup', undefined, io({ readWorkItem: async () => null, arm: armedAuto() })),
      ).toBeNull();
    });

    it('threads the declared per-item risk so a sub-critical ceiling still arms (vs fail-safe `critical`, which gates)', async () => {
      // declared `low` risk @ a `low` ceiling → within ceiling → auto → a plan.
      const armed = await planWorkItemArm(autonomousCtx, 'work_items:set_state', 'state', 'WI-1', 'papercup', { riskTier: 'low' }, io({ arm: armedAt('low') }));
      expect(armed).not.toBeNull();
      expect(armed!.decision.posture).toBe('auto');
      expect(armed!.decision.riskTier).toBe('low');
      // NO declared risk → fail-safe `critical` @ the same `low` ceiling → above ceiling → gated → null.
      const gated = await planWorkItemArm(autonomousCtx, 'work_items:set_state', 'state', 'WI-1', 'papercup', undefined, io({ arm: armedAt('low') }));
      expect(gated).toBeNull();
    });
  });

  describe('commitWorkItemArm', () => {
    it('delegates to the arm seam — records `act` + arms with the faithful priority handle', async () => {
      const arm = armedAuto();
      const plan = await planWorkItemArm(autonomousCtx, 'work_items:set_priority', 'priority', 'WI-1', 'papercup', undefined, io({ readWorkItem: async () => workItem({ priority: 3 }), arm }));
      expect(plan).not.toBeNull();
      await commitWorkItemArm(plan!);
      expect(arm.recordDisposition).toHaveBeenCalledWith(expect.objectContaining({ disposition: 'act', links: { itemRef: 'WI-1' } }));
      expect(arm.armTripwire).toHaveBeenCalledWith(
        SQL,
        'default',
        expect.objectContaining({
          revertHandle: { kind: 'work-item-priority', id: 'WI-1', harness: 'papercup', priorPriority: 3 },
          decisionId: '99',
        }),
        1,
      );
    });
  });
});
