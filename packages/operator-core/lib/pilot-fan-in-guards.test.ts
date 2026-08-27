import { describe, expect, it } from 'vitest';
import { flattenLeaves, validateSpec } from './events/await/compose-spec';
import {
  buildPilotFanInPlan,
  validatePilotComposedFanInReceipts,
  validatePilotExactCompletionReceipts,
  type PilotComposedAwaitReceipt,
} from './pilot-fan-in-guards';

const IDS = Array.from({ length: 21 }, (_, index) => `WI-${index + 1}`);

describe('pilot 20+1 fan-in planning', () => {
  it('builds exact completion keys plus event-cap-safe completion and subject-filtered grading roots', () => {
    const plan = buildPilotFanInPlan({ itemIds: IDS, rubricRef: 'pilot-quality' });
    expect(plan.completionExactLeaves).toHaveLength(21);
    expect(plan.completionExactLeaves[0]).toEqual({ itemId: 'WI-1', event: 'work-item:done:WI-1' });
    expect(plan.completionRoots.map((root) => root.itemIds.length)).toEqual([20, 1]);
    expect(plan.gradingRoots.map((root) => root.itemIds.length)).toEqual([20, 1]);

    for (const root of [...plan.completionRoots, ...plan.gradingRoots]) {
      expect(() => validateSpec(root.spec)).not.toThrow();
    }
    const gradeLeaves = plan.gradingRoots.flatMap((root) => flattenLeaves(root.spec));
    expect(new Set(gradeLeaves.map((leaf) => leaf.event))).toEqual(new Set(['scorecard:emitted:pilot-quality']));
    expect(gradeLeaves.map((leaf) => leaf.when)).toEqual(IDS.map((itemId) => ({ subjectRef: itemId })));
    expect(plan.evidencePolicy).toEqual({
      completion: 'work-item-terminal-ledger',
      grading: 'scorecard-ledger-card-id',
      scorecardEvent: 'wake-hint-only',
    });
  });

  it('rejects fewer, more, duplicate, empty, or rubric-less cohorts before registration', () => {
    expect(() => buildPilotFanInPlan({ itemIds: IDS.slice(0, 20), rubricRef: 'pilot-quality' })).toThrow(/exactly 21/);
    expect(() => buildPilotFanInPlan({ itemIds: [...IDS.slice(0, 20), 'WI-1'], rubricRef: 'pilot-quality' })).toThrow(/exactly 21/);
    expect(() => buildPilotFanInPlan({ itemIds: IDS, rubricRef: '' })).toThrow(/rubricRef/);
  });
});

describe('pilot fan-in registration receipt sets', () => {
  it('requires one exact completion registration receipt for every frozen item', () => {
    const plan = buildPilotFanInPlan({ itemIds: IDS, rubricRef: 'pilot-quality' });
    const receipts = plan.completionExactLeaves.map((leaf, index) => ({
      ...leaf,
      awaitId: index + 1,
      registeredAtMs: 1_000 + index,
    }));
    expect(validatePilotExactCompletionReceipts(plan, receipts)).toEqual({ ok: true, gaps: [] });

    const missing = validatePilotExactCompletionReceipts(plan, receipts.slice(1));
    expect(missing.gaps).toContainEqual(expect.objectContaining({ itemId: 'WI-1', code: 'missing-registration-receipt' }));

    const wrong = validatePilotExactCompletionReceipts(plan, [{ ...receipts[0]!, event: 'work-item:done:WI-X' }, ...receipts.slice(1)]);
    expect(wrong.gaps).toContainEqual(expect.objectContaining({ itemId: 'WI-1', code: 'registration-receipt-mismatch' }));
  });

  it('binds each composed registration receipt to the exact root fingerprint and returned ids', () => {
    const plan = buildPilotFanInPlan({ itemIds: IDS, rubricRef: 'pilot-quality' });
    const receipts: PilotComposedAwaitReceipt[] = plan.gradingRoots.map((root, index) => ({
      kind: root.kind,
      batchIndex: root.batchIndex,
      rootFingerprint: root.rootFingerprint,
      rootId: index + 10,
      anchorAwaitId: index + 20,
      leafCount: root.itemIds.length,
      registeredAtMs: 2_000 + index,
    }));
    expect(validatePilotComposedFanInReceipts(plan.gradingRoots, receipts)).toEqual({ ok: true, gaps: [] });

    const tampered = validatePilotComposedFanInReceipts(plan.gradingRoots, [
      { ...receipts[0]!, rootFingerprint: '0'.repeat(64) },
      receipts[1]!,
    ]);
    expect(tampered.gaps).toContainEqual(expect.objectContaining({ batchIndex: 0, code: 'registration-receipt-mismatch' }));

    const duplicate = validatePilotComposedFanInReceipts(plan.gradingRoots, [receipts[0]!, receipts[0]!, receipts[1]!]);
    expect(duplicate.gaps).toContainEqual(expect.objectContaining({ batchIndex: 0, code: 'duplicate-registration-receipt' }));
  });
});
