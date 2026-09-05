import { describe, expect, it } from 'vitest';
import {
  BATTERY_COHORTS,
  planReproducibleBattery,
  toRunExperimentInput,
  validateReproducibleBattery,
  type ReproducibleBattery,
} from './battery';

const battery = (over: Partial<ReproducibleBattery> = {}): ReproducibleBattery => ({
  batteryId: 'blender-p009',
  pins: {
    taskHash: 'task-hash',
    modelHash: 'model-hash',
    promptHash: 'prompt-hash',
    rubricHash: 'rubric-hash',
    codeHash: 'code-hash',
    evaluatorHash: 'evaluator-hash',
    baselineArmId: 'baseline',
    exposure: { population: 'pot:test', percentage: 20 },
    randomization: { strategy: 'fixed-seed', seed: 'seed-42' },
    repeats: 2,
  },
  arms: [
    { id: 'baseline', knobs: {} },
    { id: 'challenger', knobs: { 'overlay.systemOverlay': 'candidate' } },
  ],
  cohorts: {
    development: [{ caseId: 'dev-1', context: 'dev context', intent: 'dev intent' }],
    'sealed-acceptance': [{ caseId: 'holdout-1', context: 'holdout context', intent: 'holdout intent', sealed: true }],
    'fresh-monitoring': [{ caseId: 'fresh-1', context: 'fresh context', intent: 'fresh intent', fresh: true }],
  },
  ...over,
});

describe('P-009 reproducible baseline/challenger battery', () => {
  it('requires every pinned identity and isolates the three cohorts', () => {
    expect(validateReproducibleBattery(battery())).toEqual({ ok: true, errors: [] });
    const duplicate = battery({
      cohorts: {
        development: [{ caseId: 'same', context: 'x', intent: 'x' }],
        'sealed-acceptance': [{ caseId: 'same', context: 'x', intent: 'x', sealed: true }],
        'fresh-monitoring': [{ caseId: 'fresh', context: 'x', intent: 'x', fresh: true }],
      },
    });
    const result = validateReproducibleBattery(duplicate);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('caseId is reused across cohorts: same');
  });

  it('rejects unsealed holdouts, stale monitoring cases, invalid exposure and non-fixed randomness', () => {
    const result = validateReproducibleBattery(
      battery({
        pins: { ...battery().pins, exposure: { population: '', percentage: 0 }, randomization: { strategy: 'fixed-seed', seed: '' } },
        cohorts: {
          development: [{ caseId: 'dev', context: 'x', intent: 'x', sealed: true }],
          'sealed-acceptance': [{ caseId: 'holdout', context: 'x', intent: 'x' }],
          'fresh-monitoring': [{ caseId: 'fresh', context: 'x', intent: 'x' }],
        },
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      'pins.exposure.population must be non-empty',
      'pins.exposure.percentage must be in (0, 100]',
      'pins.randomization.seed must be non-empty',
      'sealed-acceptance case holdout must be sealed',
      'fresh-monitoring case fresh must be marked fresh',
      'only sealed-acceptance cases may set sealed=true (dev)',
    ]));
  });

  it('expands deterministic arm × case × repeat cells for all cohorts', () => {
    const first = planReproducibleBattery(battery());
    const second = planReproducibleBattery(battery());
    expect(first).toEqual(second);
    expect(first.ok).toBe(true);
    expect(first.cohortCaseCounts).toEqual({ development: 1, 'sealed-acceptance': 1, 'fresh-monitoring': 1 });
    expect(first.totalCells).toBe(12); // 3 cohorts × 1 case × 2 arms × 2 repeats
    expect(first.cells[0]).toEqual({ cohort: 'development', armId: 'baseline', caseId: 'dev-1', repeat: 0 });
    expect(first.cells.at(-1)).toEqual({ cohort: 'fresh-monitoring', armId: 'challenger', caseId: 'fresh-1', repeat: 1 });
    expect(BATTERY_COHORTS).toHaveLength(3);
  });

  it('maps each cohort into the existing dry-run experiment request', () => {
    const request = toRunExperimentInput(battery(), 'sealed-acceptance');
    expect(request).toMatchObject({
      testId: 'replay',
      batteryId: 'blender-p009:sealed-acceptance',
      repeats: 2,
      dryRun: true,
    });
    expect(request?.cases).toEqual([{ caseId: 'holdout-1', context: 'holdout context', intent: 'holdout intent' }]);
    expect(request?.arms.map((arm) => arm.id)).toEqual(['baseline', 'challenger']);
  });

  it('validates and accounts for governor-style cost receipts without treating missing receipts as free', () => {
    const spec = battery({
      costReceipts: [{
        receiptId: 'r-1',
        cohort: 'development',
        armId: 'baseline',
        caseId: 'dev-1',
        repeat: 0,
        requestedUsd: 1,
        reservedUsd: 0.8,
        usedUsd: 0.5,
        unsettledUsd: 0.3,
      }],
    });
    expect(validateReproducibleBattery(spec).ok).toBe(true);
    expect(planReproducibleBattery(spec).totalCells).toBe(12);
    expect(spec.costReceipts).toHaveLength(1);
  });
});

