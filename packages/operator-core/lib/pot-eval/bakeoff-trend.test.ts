import { describe, it, expect } from 'vitest';
import { summarizeBakeoffTrend, latestVerdictByFlag, type BakeoffTrendEntry } from './bakeoff-trend';
import type { BakeoffResult, BakeoffVerdict } from './framework-bake-off';

const result = (flagKey: string, verdict: BakeoffVerdict, dComp = 0, dGate = 0): BakeoffResult => ({
  flagKey,
  baseline: { arm: 'baseline', flagOn: false, scores: [], meanComposite: 0, gatePassRate: 0 },
  treatment: { arm: 'treatment', flagOn: true, scores: [], meanComposite: 0, gatePassRate: 0 },
  delta: { deltaMeanComposite: dComp, deltaGatePassRate: dGate, verdict },
});

describe('summarizeBakeoffTrend', () => {
  it('flattens to rows, newest first, carrying the deltas', () => {
    const entries: BakeoffTrendEntry[] = [
      { result: result('papercusp-a', 'improved', 0.1, 0.0), at: 100 },
      { result: result('papercusp-a', 'regressed', -0.2, -0.1), at: 300 },
      { result: result('papercusp-b', 'neutral', 0.0, 0.0), at: 200 },
    ];
    const rows = summarizeBakeoffTrend(entries);
    expect(rows.map((r) => r.at)).toEqual([300, 200, 100]);
    expect(rows[0]).toMatchObject({ flagKey: 'papercusp-a', verdict: 'regressed', deltaMeanComposite: -0.2 });
  });

  it('is empty for no entries', () => {
    expect(summarizeBakeoffTrend([])).toEqual([]);
  });
});

describe('latestVerdictByFlag', () => {
  it('picks the latest verdict per flag (newest-first input)', () => {
    const rows = summarizeBakeoffTrend([
      { result: result('papercusp-a', 'improved'), at: 100 },
      { result: result('papercusp-a', 'regressed'), at: 300 }, // newer → wins
      { result: result('papercusp-b', 'neutral'), at: 50 },
    ]);
    expect(latestVerdictByFlag(rows)).toEqual({ 'papercusp-a': 'regressed', 'papercusp-b': 'neutral' });
  });
});
