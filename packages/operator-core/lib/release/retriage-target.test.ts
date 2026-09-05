/**
 * P-024 (frozen-candidate-stays-frozen-through-all-fixes-2026-09-03): while a repair queue row
 * exists ANYWHERE (the run's snapshot or the persisted row), re-triage targets the frozen
 * lineage head and never consults the integration tip. Written as a falsifier: the pre-P-024
 * gate answered every one of the queue-present rows below with the integration tip.
 */
import { describe, expect, it, vi } from 'vitest';
import type { FrozenCandidateRepairPhase, FrozenCandidateRepairQueue } from './frozen-candidate-repair-queue';
import { describeRetriageTarget, resolveRetriageTarget } from './retriage-target';

const C = '1111111111111111111111111111111111111111';
const R = '2222222222222222222222222222222222222222';
const R2 = '4444444444444444444444444444444444444444';
const TIP = '3333333333333333333333333333333333333333';
const T0 = 1_800_000_000_000;

const PHASES: FrozenCandidateRepairPhase[] = ['ready-to-test', 'awaiting-fixer', 'ready-to-verify', 'ready-to-promote', 'blocked'];

function row(phase: FrozenCandidateRepairPhase, overrides: Partial<FrozenCandidateRepairQueue> = {}): FrozenCandidateRepairQueue {
  return {
    schemaVersion: 4,
    phase,
    candidate: C,
    base: null,
    repairHead: phase === 'ready-to-test' ? C : R,
    attempts: phase === 'ready-to-test' ? 0 : 1,
    openedAtMs: T0,
    updatedAtMs: T0,
    fixerSpawnId: null,
    failingTests: ['lib/a.test.ts'],
    signature: [],
    ...(phase === 'blocked' ? { blockedReason: 'attempts-exhausted' as const } : {}),
    ...overrides,
  };
}

describe('resolveRetriageTarget (P-024): a queue row in any phase pins re-triage to the lineage head', () => {
  for (const phase of PHASES) {
    it(`${phase}: targets repairHead and NEVER reads the integration tip`, async () => {
      const resolveIntegrationTip = vi.fn(async () => TIP);
      const target = await resolveRetriageTarget({
        repairQueue: row(phase),
        resolveIntegrationTip,
        isLineageDescendant: async () => true,
      });
      expect(target.kind).toBe('lineage-head');
      expect(target.ref).toBe(row(phase).repairHead);
      expect(target.ref).not.toBe(TIP);
      expect(resolveIntegrationTip).not.toHaveBeenCalled();
    });
  }

  it('prefers the PERSISTED row over the pre-suite snapshot (an admission moved repairHead mid-run)', async () => {
    const resolveIntegrationTip = vi.fn(async () => TIP);
    const target = await resolveRetriageTarget({
      repairQueue: row('ready-to-verify', { repairHead: R }),
      readFreshQueue: async () => row('ready-to-verify', { repairHead: R2 }),
      resolveIntegrationTip,
      isLineageDescendant: async () => true,
    });
    expect(target).toMatchObject({ kind: 'lineage-head', ref: R2, queueSource: 'fresh' });
    expect(resolveIntegrationTip).not.toHaveBeenCalled();
  });

  it('a row FROZEN AFTER the run started (null snapshot, persisted row) still pins to the lineage', async () => {
    const resolveIntegrationTip = vi.fn(async () => TIP);
    const target = await resolveRetriageTarget({
      repairQueue: null,
      readFreshQueue: async () => row('ready-to-test'),
      resolveIntegrationTip,
      isLineageDescendant: async () => true,
    });
    expect(target).toMatchObject({ kind: 'lineage-head', ref: C, queueSource: 'fresh' });
    expect(resolveIntegrationTip).not.toHaveBeenCalled();
  });

  it('fails CLOSED: a read fault or a null re-read keeps the snapshot row (unreadable is not absent)', async () => {
    const resolveIntegrationTip = vi.fn(async () => TIP);
    for (const readFreshQueue of [async () => null, async () => { throw new Error('pg down'); }]) {
      const target = await resolveRetriageTarget({
        repairQueue: row('ready-to-verify'),
        readFreshQueue,
        resolveIntegrationTip,
        isLineageDescendant: async () => true,
      });
      expect(target).toMatchObject({ kind: 'lineage-head', ref: R, queueSource: 'snapshot' });
    }
    expect(resolveIntegrationTip).not.toHaveBeenCalled();
  });

  it('refuses a head that does not descend from the frozen candidate — and never widens to the tip', async () => {
    const resolveIntegrationTip = vi.fn(async () => TIP);
    const target = await resolveRetriageTarget({
      repairQueue: row('ready-to-verify'),
      resolveIntegrationTip,
      isLineageDescendant: async () => false,
    });
    expect(target).toMatchObject({ kind: 'declined', ref: null, reason: 'not-a-lineage-descendant' });
    expect(resolveIntegrationTip).not.toHaveBeenCalled();
    expect(describeRetriageTarget(target)).toMatch(/does not descend/);
  });

  it('a failing descendant check declines (fail closed) rather than judging an unproven sha', async () => {
    const target = await resolveRetriageTarget({
      repairQueue: row('ready-to-verify'),
      resolveIntegrationTip: async () => TIP,
      isLineageDescendant: async () => { throw new Error('git exploded'); },
    });
    expect(target).toMatchObject({ kind: 'declined', ref: null, reason: 'descendant-check-failed' });
    expect(describeRetriageTarget(target)).toMatch(/git exploded/);
  });

  it('POSITIVE CONTROL: with no row anywhere the integration tip IS consulted (today\'s un-frozen behaviour)', async () => {
    const resolveIntegrationTip = vi.fn(async () => TIP);
    const target = await resolveRetriageTarget({
      repairQueue: null,
      readFreshQueue: async () => null,
      resolveIntegrationTip,
      isLineageDescendant: async () => { throw new Error('must not be asked without a row'); },
    });
    expect(target).toEqual({ kind: 'integration-tip', ref: TIP, queueSource: 'none' });
    expect(resolveIntegrationTip).toHaveBeenCalledTimes(1);
    expect(describeRetriageTarget(target)).toMatch(/integration tip 33333333/);
  });

  it('no row and an unreadable tip is a null target, not a throw', async () => {
    const target = await resolveRetriageTarget({
      repairQueue: null,
      resolveIntegrationTip: async () => { throw new Error('no git'); },
    });
    expect(target).toEqual({ kind: 'integration-tip', ref: null, queueSource: 'none' });
  });
});
