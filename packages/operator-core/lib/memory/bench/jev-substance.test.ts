import { describe, expect, it } from 'vitest';

import {
  MAX_REAL_REFUSAL_RATE,
  pairedShift,
  rateAt,
  refusedAt,
  renderSubstanceMarkdown,
  seededSample,
  selectThreshold,
  splitHalves,
  substanceVerdict,
  wilson,
  type SubstanceReport,
  type SubstanceRow,
} from './jev-substance';

function row(id: string, p: number | null, population: SubstanceRow['population'] = 'real'): SubstanceRow {
  return { id, population, pool: population === 'real' ? 'harness:papercusp' : null, text: `text ${id}`, pConcrete: p, latencyMs: 100, failure: p === null ? 'timeout' : null };
}

describe('seededSample', () => {
  const rows = Array.from({ length: 50 }, (_, i) => ({ id: `m${i}` }));

  it('draws the same sample for the same seed and a different one for another seed', () => {
    expect(seededSample(rows, 10, 's').map((r) => r.id)).toEqual(seededSample(rows, 10, 's').map((r) => r.id));
    expect(seededSample(rows, 10, 's').map((r) => r.id)).not.toEqual(seededSample(rows, 10, 't').map((r) => r.id));
  });

  it('does not depend on input order', () => {
    expect(seededSample([...rows].reverse(), 10, 's').map((r) => r.id)).toEqual(seededSample(rows, 10, 's').map((r) => r.id));
  });
});

describe('refusal counting', () => {
  it('never counts a failed call as refused (the write fails open)', () => {
    const rows = [row('a', 0.01), row('b', null), row('c', 0.9)];
    expect(refusedAt(rows, 0.1).map((r) => r.id)).toEqual(['a']);
    expect(rateAt(rows, 0.1)).toMatchObject({ k: 1, n: 2 });
  });

  it('wilson interval brackets the rate and reports n=0 as fully uncertain', () => {
    const r = wilson(3, 300);
    expect(r.lo).toBeLessThan(0.01);
    expect(r.hi).toBeGreaterThan(0.01);
    expect(wilson(0, 0)).toMatchObject({ lo: 0, hi: 1 });
  });
});

describe('selectThreshold', () => {
  it('takes the LARGEST threshold whose selection-half refusal rate stays within budget', () => {
    // 400 rows: one at 0.03, one at 0.12, one at 0.22, the rest confident.
    const sel = [row('x', 0.03), row('y', 0.12), row('z', 0.22), ...Array.from({ length: 397 }, (_, i) => row(`r${i}`, 0.95))];
    // budget 0.5% of 400 = 2 refusals: 0.2 refuses x and y (2) — allowed; 0.25 refuses 3 — not.
    expect(selectThreshold(sel, [0.05, 0.1, 0.2, 0.25])).toBe(0.2);
  });

  it('returns null when even the smallest threshold refuses too much', () => {
    const sel = Array.from({ length: 10 }, (_, i) => row(`r${i}`, 0.01));
    expect(selectThreshold(sel, [0.05, 0.1])).toBeNull();
  });
});

describe('splitHalves', () => {
  it('alternates, so neither half is a contiguous block of the sample', () => {
    expect(splitHalves([1, 2, 3, 4, 5])).toEqual({ selection: [1, 3, 5], confirmation: [2, 4] });
  });
});

describe('substanceVerdict — R-3', () => {
  const ok = wilson(2, 300);
  it('passes within 1% on the confirmation half and the whole sample with a big enough sample', () => {
    expect(substanceVerdict({ threshold: 0.1, confirmation: ok, whole: wilson(4, 600), sampleSize: 600, minSample: 500 }).pass).toBe(true);
  });

  it('fails when the confirmation half refuses more than 1%, even though selection passed', () => {
    const v = substanceVerdict({ threshold: 0.1, confirmation: wilson(4, 300), whole: wilson(5, 600), sampleSize: 600, minSample: 500 });
    expect(4 / 300).toBeGreaterThan(MAX_REAL_REFUSAL_RATE);
    expect(v.pass).toBe(false);
    expect(v.reasons.join(' ')).toMatch(/confirmation half/);
  });

  it('fails on a sample below the minimum and when no threshold was chosen', () => {
    expect(substanceVerdict({ threshold: 0.1, confirmation: ok, whole: ok, sampleSize: 300, minSample: 500 }).pass).toBe(false);
    expect(substanceVerdict({ threshold: null, confirmation: ok, whole: ok, sampleSize: 600, minSample: 500 }).pass).toBe(false);
  });
});

describe('pairedShift', () => {
  it('counts decision flips at t and ignores pairs with a failed side', () => {
    const s = pairedShift(
      [
        { alone: 0.05, withNeighbours: 0.2 },
        { alone: 0.9, withNeighbours: 0.85 },
        { alone: null, withNeighbours: 0.1 },
      ],
      0.1,
    );
    expect(s).toMatchObject({ n: 2, flips: 1 });
    expect(s.maxAbsDelta).toBeCloseTo(0.15);
  });
});

describe('renderSubstanceMarkdown', () => {
  it('lists every refused real memory so a reviewer can judge each one', () => {
    const rows = [row('keep', 0.9), row('refuse-me', 0.02), row('promo', 0.01, 'self-promoter'), row('promo-missed', 0.5, 'self-promoter')];
    const report: SubstanceReport = {
      generatedAt: '2026-09-30T00:00:00.000Z',
      params: { realSample: 2 },
      rows,
      selectionIds: ['keep'],
      confirmationIds: ['refuse-me'],
      threshold: 0.1,
      verdict: { threshold: 0.1, pass: false, reasons: ['example'] },
      paired: null,
      latency: { p50: 100, p95: 120, failures: 0 },
    };
    const md = renderSubstanceMarkdown(report);
    expect(md).toContain('## Verdict: FAIL (threshold 0.1)');
    expect(md).toContain('`refuse-me`');
    expect(md).not.toContain('`keep`');
    expect(md).toContain('Self-promoters NOT caught at t=0.1 (1)');
  });
});
