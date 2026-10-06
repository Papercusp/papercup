import { describe, expect, it } from 'vitest';
import { ROUTES, scoreRoute, type Route, type RouteRow } from './complete-hybrid-bench';
import { ALL_ANSWERABLE } from './paired-leg-report';
import { assertComparableArms, pairCompleteArms, type CompleteArmReport } from './complete-hybrid-paired';

const CLASSES = ['exact-identifier', 'lexical-gap', 'session-start-intent'] as const;
interface Q { id: string; class: string; group: string; expected: string[] }

// Six source targets per answerable class, plus one extra query per class that
// shares source 0 — it must collapse into that source target, not count as a 7th.
const QUERIES: Q[] = [
  ...CLASSES.flatMap((c) => [
    ...Array.from({ length: 6 }, (_, i) => ({ id: `${c}-${i}`, class: c, group: `src-${c}-${i}`, expected: [`doc:${c}-${i}`] })),
    { id: `${c}-0b`, class: c, group: `src-${c}-0`, expected: [`doc:${c}-0`] },
  ]),
  // Six hard negatives over three negative sources (two each).
  ...Array.from({ length: 6 }, (_, i) => ({ id: `neg-${i}`, class: 'hard-negative', group: `neg-src-${i % 3}`, expected: [] })),
];
const ENTRIES = [
  ...QUERIES.flatMap((q) => q.expected.map((key) => ({ key, metadata: { cluster: q.group } }))),
  { key: 'doc:noise', metadata: { cluster: 'noise' } },
];

function report(model: string, rank: (q: Q) => string[]): CompleteArmReport {
  return {
    runner: 'complete-hybrid-bench', model, corpus: 'memory',
    binding: { schema: `bench_memory_${model}`, syntheticEmbedder: false },
    inputs: { snapshotSha256: 'snap', goldSha256: 'gold', agesSha256: 'ages' },
    guards: { scopeIsolation: { leakScope: 'bench-leak', decoys: 3, positiveControlHits: 2, leakedHits: 0 } },
    rows: QUERIES.map((q) => ({
      ...q,
      routes: Object.fromEntries(ROUTES.map((r) => [r, scoreRoute(q.expected, rank(q))])) as Record<Route, RouteRow>,
    })),
  };
}

// Baseline: the answer at rank 2 behind noise; admits every hard negative.
const baseline = () => report('gemma', (q) => (q.expected.length ? ['doc:noise', ...q.expected] : ['doc:noise']));
// Candidate: the answer at rank 1, except one EMPTY result; rejects even-numbered negatives.
const candidate = () => report('mdenseon', (q) => {
  if (q.id === 'lexical-gap-1') return [];
  if (!q.expected.length) return Number(q.id.slice(4)) % 2 === 0 ? [] : ['doc:noise'];
  return [...q.expected];
});

describe('assertComparableArms', () => {
  it('accepts comparable arms and returns the isolation facts it verified', () => {
    const facts = assertComparableArms([baseline(), candidate()]);
    expect(facts.queries).toBe(QUERIES.length);
    expect(facts.arms.map((a) => a.schema)).toEqual(['bench_memory_gemma', 'bench_memory_mdenseon']);
    expect(facts.arms.every((a) => a.scopeIsolation.leakedHits === 0 && a.scopeIsolation.positiveControlHits > 0)).toBe(true);
  });

  const refusals: Array<[string, (b: CompleteArmReport, c: CompleteArmReport) => void, RegExp]> = [
    ['a different gold set', (_, c) => { c.inputs.goldSha256 = 'other'; }, /goldSha256 differs/],
    ['a different ages freeze', (_, c) => { delete c.inputs.agesSha256; }, /agesSha256 differs/],
    ['two arms in one schema', (b, c) => { c.binding.schema = b.binding.schema; }, /share a benchmark schema/],
    ['a production schema', (b) => { b.binding.schema = 'harness_shared'; }, /production schema/],
    ['a synthetic embedder', (_, c) => { c.binding.syntheticEmbedder = true; }, /synthetic embedder/],
    ['a scope leak', (_, c) => { c.guards.scopeIsolation.leakedHits = 1; }, /scope-isolation leak/],
    ['a guard with no positive control', (_, c) => { c.guards.scopeIsolation.positiveControlHits = 0; }, /no positive-control/],
    ['a query identity mismatch', (_, c) => { c.rows[0]!.group = 'elsewhere'; }, /query identity mismatch/],
    ['a leaked key on one route', (_, c) => { c.rows[0]!.routes.push = scoreRoute(c.rows[0]!.expected, ['leak:x']); }, /leaked leak:x/],
    ['a different corpus', (_, c) => { c.corpus = 'prose'; }, /corpus prose differs/],
  ];
  for (const [what, mutate, error] of refusals) {
    it(`refuses ${what}`, () => {
      const b = baseline(), c = candidate();
      mutate(b, c);
      expect(() => assertComparableArms([b, c])).toThrow(error);
    });
  }

  it('refuses a single arm', () => {
    expect(() => assertComparableArms([baseline()])).toThrow(/at least two arms/);
  });
});

describe('pairCompleteArms', () => {
  const result = pairCompleteArms(baseline(), candidate(), ENTRIES, { iterations: 4000 });

  it('pairs every route', () => {
    expect(Object.keys(result.routes).sort()).toEqual([...ROUTES].sort());
    expect(result).toMatchObject({ baseline: 'gemma', candidate: 'mdenseon', corpus: 'memory' });
  });

  it('resamples source-target components, not queries, for reciprocal rank', () => {
    const all = result.routes.push.mrr[ALL_ANSWERABLE]!;
    expect(all.sourceTargets).toBe(18); // 3 classes x 6 sources; each extra query joins source 0
    expect(all.queryCount).toBe(21);
    // 17 components improve 0.5 -> 1, the empty one drops 0.5 -> 0.
    expect(all.comparison.delta.point).toBeCloseTo((17 * 0.5 - 0.5) / 18, 6);
    expect(all.comparison.delta.lower).toBeGreaterThan(0);
    expect(all.marginDecision).toBe('improvement-above-margin');
  });

  it('compares precision only where both arms returned something, and reports the exclusion', () => {
    const p = result.routes.pull.positives[ALL_ANSWERABLE]!;
    expect(p.precision.excludedQueries).toBe(1);
    expect(p.precision.queries).toBe(20);
    expect(p.precision.comparison!.delta.point).toBeCloseTo(0.5, 6);
    expect(p.nonEmpty).toMatchObject({ onlyA: 1, onlyB: 0 });
    const lexical = result.routes.pull.positives['lexical-gap']!;
    expect(lexical.precision.sourceGroups).toBe(5); // source 1 contributed only the empty query
  });

  it('scores recall@10 over the same components (the empty result is a miss)', () => {
    const r = result.routes.raw.positives[ALL_ANSWERABLE]!.recallAt10;
    expect(r.sourceGroups).toBe(18);
    expect(r.comparison!.delta.point).toBeCloseTo(-1 / 18, 6);
  });

  it('compares hard-negative admission over the negatives’ own sources', () => {
    const n = result.routes['push-calibrated'].negatives;
    expect(n.admission).toMatchObject({ sourceGroups: 3, queries: 6, excludedQueries: 0 });
    expect(n.admission.comparison!.meanA).toBeCloseTo(1, 6);
    expect(n.admission.comparison!.delta.point).toBeCloseTo(-0.5, 6);
    expect(n.rejected).toMatchObject({ onlyA: 0, onlyB: 3 });
  });

  it('is deterministic for a fixed seed', () => {
    const again = pairCompleteArms(baseline(), candidate(), ENTRIES, { iterations: 4000 });
    expect(again).toEqual(result);
  });

  it('refuses arms that do not cover the same queries', () => {
    const c = candidate();
    c.rows = c.rows.slice(1);
    expect(() => pairCompleteArms(baseline(), c, ENTRIES)).toThrow(/same queries/);
  });
});
