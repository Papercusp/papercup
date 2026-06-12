/**
 * Calibration feature semantics (P-041 / FB-13), PG-free: dark → zero
 * contributions before any IO; bounced fixes boost hardest; open bets weigh
 * by bettor trust (unknown bettor = neutral); a signal-read failure degrades
 * to 0 instead of killing the rank pass.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ScoredItem } from '../harness/improvements/digest';
import type { CalibrationScore, PredictionRow } from '../calibration/types';
import { NEUTRAL_WEIGHT } from '../calibration/scoring';
import type { HumanQueueRankContext } from './blocking-impact-feature';
import {
  BOUNCED_FIX_VALUE,
  makeCalibrationFeature,
  type CalibrationQueueSignals,
} from './calibration-feature';

const ctx = {} as HumanQueueRankContext;

function item(id: string): ScoredItem {
  return {
    id,
    kind: 'bug',
    title: `item ${id}`,
    scope: 'operator',
    tier: 'human',
    score: 10,
    ageDays: 1,
    tierReason: 'test',
  } as ScoredItem;
}

function bet(over: Partial<PredictionRow>): PredictionRow {
  return {
    id: 'b1',
    workspaceId: 'ws',
    predictor: 'su-sharp',
    domain: 'fix-survival',
    subjectKind: 'improvement',
    subjectId: 'EI-1',
    claim: 'c',
    probability: 0.8,
    stated: true,
    origin: 'organic',
    watchdogKey: null,
    horizonTs: 0,
    createdAt: 0,
    resolvedAt: null,
    outcome: null,
    resolutionNote: null,
    ...over,
  };
}

const score = (predictor: string, domain: string, weight: number): CalibrationScore => ({
  predictor,
  domain,
  n: 20,
  brier: 0.05,
  baseRate: 0.7,
  weight,
});

function feature(signals: CalibrationQueueSignals, enabled = true) {
  const loadSignals = vi.fn(async () => signals);
  return {
    loadSignals,
    feature: makeCalibrationFeature({ isEnabled: async () => enabled, loadSignals }),
  };
}

const NO_SIGNALS: CalibrationQueueSignals = { openBets: [], bouncedBySubject: new Map(), scores: [] };

describe('calibration feature', () => {
  it('flag OFF → empty map and NO signal IO (dark = behavior-identical)', async () => {
    const f = feature(NO_SIGNALS, false);
    const out = await f.feature.score([item('EI-1')], ctx);
    expect(out.size).toBe(0);
    expect(f.loadSignals).not.toHaveBeenCalled();
  });

  it('no bets → zero contributions (stable shape, nothing attached)', async () => {
    const f = feature(NO_SIGNALS);
    const out = await f.feature.score([item('EI-1')], ctx);
    expect(out.size).toBe(0);
  });

  it('a bounced fix boosts hardest and says so', async () => {
    const f = feature({ ...NO_SIGNALS, bouncedBySubject: new Map([['EI-1', 2]]) });
    const out = await f.feature.score([item('EI-1'), item('EI-2')], ctx);
    const v = out.get('EI-1');
    expect(v?.value).toBe(2 * BOUNCED_FIX_VALUE);
    expect(v?.reasons?.[0]).toContain('bounced 2×');
    expect(out.get('EI-2')).toBeUndefined();
  });

  it('an open bet weighs by the bettor’s trust; an unknown bettor reads neutral', async () => {
    const f = feature({
      openBets: [
        bet({ subjectId: 'EI-1', predictor: 'su-sharp', probability: 0.3 }),
        bet({ id: 'b2', subjectId: 'EI-2', predictor: 'su-nobody', probability: 0.3 }),
      ],
      bouncedBySubject: new Map(),
      scores: [score('su-sharp', 'fix-survival', 0.9)],
    });
    const out = await f.feature.score([item('EI-1'), item('EI-2')], ctx);
    // bad-outcome expectation = 1 − 0.3 = 0.7; trusted bettor × 0.9, unknown × 0.5.
    expect(out.get('EI-1')?.value).toBeCloseTo(0.7 * 0.9, 10);
    expect(out.get('EI-2')?.value).toBeCloseTo(0.7 * NEUTRAL_WEIGHT, 10);
    expect(out.get('EI-1')?.reasons?.[0]).toContain('su-sharp bets p=0.30');
  });

  it('flake-recurrence bets read p straight (the claim IS the bad outcome)', async () => {
    const f = feature({
      openBets: [bet({ subjectId: 'EI-1', domain: 'flake-recurrence', probability: 0.9 })],
      bouncedBySubject: new Map(),
      scores: [],
    });
    const out = await f.feature.score([item('EI-1')], ctx);
    expect(out.get('EI-1')?.value).toBeCloseTo(0.9 * NEUTRAL_WEIGHT, 10);
  });

  it('attaches a namespaced calibration struct for consumers', async () => {
    const f = feature({
      openBets: [bet({ subjectId: 'EI-1' })],
      bouncedBySubject: new Map([['EI-1', 1]]),
      scores: [],
    });
    const out = await f.feature.score([item('EI-1')], ctx);
    expect(out.get('EI-1')?.attach).toEqual({ calibration: { bounced: 1, openBets: 1 } });
  });

  it('a signal-read failure degrades to zero contributions, never throws', async () => {
    const loadSignals = vi.fn(async (): Promise<CalibrationQueueSignals> => {
      throw new Error('pg down');
    });
    const f = makeCalibrationFeature({ isEnabled: async () => true, loadSignals });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const out = await f.score([item('EI-1')], ctx);
      expect(out.size).toBe(0);
    } finally {
      warn.mockRestore();
    }
  });
});
