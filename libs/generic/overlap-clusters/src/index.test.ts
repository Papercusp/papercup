import { describe, expect, it } from 'vitest';
import {
  bruteForceNeighbours,
  clusterPairs,
  configureOverlapScan,
  cosineSimilarity,
  describeOverlapReport,
  scanOverlap,
  type NeighbourProvider,
  type OverlapUnit,
} from './index';

/** A unit vector pointing at `angle` radians — lets a test state an exact cosine. */
function at(angle: number): number[] {
  return [Math.cos(angle), Math.sin(angle)];
}

function unit(id: string, group: string, vector: number[]): OverlapUnit {
  return { id, group, vector };
}

const scan = (units: OverlapUnit[], over: Partial<Parameters<typeof configureOverlapScan>[0]> = {}) =>
  scanOverlap(
    units,
    configureOverlapScan({
      threshold: 0.9,
      neighbours: bruteForceNeighbours(units),
      neighbourLimit: 10,
      ...over,
    } as Parameters<typeof configureOverlapScan>[0]),
  );

describe('cosineSimilarity', () => {
  it('is 1 for parallel and 0 for orthogonal vectors', () => {
    expect(cosineSimilarity([1, 2, 3], [2, 4, 6])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
  });

  it('returns 0 — not NaN — for a zero-norm or empty vector', () => {
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
    expect(cosineSimilarity([], [])).toBe(0);
  });

  it('returns NULL for mismatched dimensions rather than laundering a corpus fault as "dissimilar"', () => {
    // The whole point: 0 would be indistinguishable from a genuinely unrelated
    // pair, so a half-finished embedding backfill would read as a clean corpus.
    expect(cosineSimilarity([1, 0], [1])).toBeNull();
  });
});

describe('configureOverlapScan', () => {
  const neighbours: NeighbourProvider = () => [];

  it('refuses a missing threshold — there is no defensible default', () => {
    expect(() => configureOverlapScan({ neighbours } as never)).toThrow(/threshold/);
  });

  it('refuses a missing neighbour provider', () => {
    expect(() => configureOverlapScan({ threshold: 0.9 } as never)).toThrow(/neighbours/);
  });

  it('rejects a nonsense neighbourLimit or maxPairs instead of silently coercing', () => {
    expect(() => configureOverlapScan({ threshold: 0.9, neighbours, neighbourLimit: 0 })).toThrow(/neighbourLimit/);
    expect(() => configureOverlapScan({ threshold: 0.9, neighbours, maxPairs: -1 })).toThrow(/maxPairs/);
  });

  it('defaults crossGroupOnly on — same-source repetition is expected, not a finding', () => {
    expect(configureOverlapScan({ threshold: 0.9, neighbours }).crossGroupOnly).toBe(true);
  });
});

describe('scanOverlap — finding real overlap', () => {
  it('reports a near-identical pair from two different sources', async () => {
    const units = [
      unit('a', 'fileA.md', at(0)),
      unit('b', 'fileB.md', at(0.05)), // cos ≈ 0.9988
      unit('c', 'fileC.md', at(Math.PI / 2)), // orthogonal to both
    ];
    const report = await scan(units);

    expect(report.pairs).toHaveLength(1);
    expect(report.pairs[0]).toMatchObject({ a: 'a', b: 'b', groupA: 'fileA.md', groupB: 'fileB.md' });
    expect(report.pairs[0]!.similarity).toBeGreaterThan(0.99);
    expect(report.inconclusive).toBeNull();
  });

  it('EXCLUDES a near-identical pair that lives in the same source', async () => {
    const units = [
      unit('a', 'same.md', at(0)),
      unit('b', 'same.md', at(0.05)),
      unit('c', 'other.md', at(Math.PI / 2)),
    ];
    const report = await scan(units);
    expect(report.pairs).toHaveLength(0);
    // And this IS a conclusive clean result: 'c' gave both units a real
    // cross-source comparison, so the threshold was genuinely exercised.
    expect(report.census.pairsCrossGroup).toBeGreaterThan(0);
    expect(report.inconclusive).toBeNull();
  });

  it('includes same-source pairs when crossGroupOnly is off', async () => {
    const units = [unit('a', 'same.md', at(0)), unit('b', 'same.md', at(0.05))];
    const report = await scan(units, { crossGroupOnly: false });
    expect(report.pairs).toHaveLength(1);
    expect(report.inconclusive).toBeNull();
  });

  it('canonicalises pair order and keeps the highest similarity for an asymmetric provider', async () => {
    const units = [unit('z', 'g1', at(0)), unit('a', 'g2', at(0))];
    // Deliberately asymmetric + disagreeing: one direction under-reports.
    const provider: NeighbourProvider = (u) =>
      u.id === 'z' ? [{ id: 'a', similarity: 0.91 }] : [{ id: 'z', similarity: 0.99 }];
    const report = await scanOverlap(units, configureOverlapScan({ threshold: 0.9, neighbours: provider }));

    expect(report.pairs).toHaveLength(1);
    expect(report.pairs[0]!.a).toBe('a'); // canonical a < b
    expect(report.pairs[0]!.b).toBe('z');
    expect(report.pairs[0]!.similarity).toBe(0.99);
    expect(report.census.candidatePairs).toBe(1);
  });

  it('is deterministic across runs', async () => {
    const units = [
      unit('a', 'g1', at(0)),
      unit('b', 'g2', at(0.05)),
      unit('c', 'g3', at(0.08)),
      unit('d', 'g4', at(0.1)),
    ];
    const first = await scan(units);
    const second = await scan(units);
    expect(JSON.stringify(second.pairs)).toBe(JSON.stringify(first.pairs));
    expect(JSON.stringify(second.clusters)).toBe(JSON.stringify(first.clusters));
  });
});

describe('clusterPairs', () => {
  it('merges transitively overlapping pairs into one cluster spanning every source', async () => {
    const units = [
      unit('a', 'g1', at(0)),
      unit('b', 'g2', at(0.04)),
      unit('c', 'g3', at(0.08)),
      unit('far', 'g4', at(Math.PI / 2)),
    ];
    const report = await scan(units);
    expect(report.clusters).toHaveLength(1);
    expect(report.clusters[0]!.ids).toEqual(['a', 'b', 'c']);
    expect(report.clusters[0]!.groups).toEqual(['g1', 'g2', 'g3']);
    expect(report.clusters[0]!.size).toBe(3);
    expect(report.clusters[0]!.minSimilarity).toBeLessThanOrEqual(report.clusters[0]!.maxSimilarity);
  });

  it('returns no cluster when there are no pairs', () => {
    expect(clusterPairs([])).toEqual([]);
  });
});

/**
 * The blindness suite. Each case is a way a scan returns ZERO while having
 * measured nothing — the failure mode that reads exactly like a clean corpus.
 *
 * ⚠ These cases alone are NOT sufficient: an implementation that hardcoded
 * `inconclusive` to a non-null string would pass every one of them. The
 * calibration case in the block below is the control that forbids it, and the
 * two blocks must be read as one test.
 */
describe('scanOverlap — an empty result is not evidence', () => {
  it('flags a corpus too small to contain a pair', async () => {
    const report = await scan([unit('only', 'g1', at(0))]);
    expect(report.pairs).toHaveLength(0);
    expect(report.inconclusive).toMatch(/could not have found anything/);
    expect(report.census.unitsComparable).toBe(1);
  });

  it('flags a single-source corpus under the cross-group rule', async () => {
    const report = await scan([unit('a', 'one.md', at(0)), unit('b', 'one.md', at(1))]);
    expect(report.inconclusive).toMatch(/single group/);
  });

  it('flags a multi-source corpus whose every candidate pair was same-source', async () => {
    // Two sources, each holding a near-identical twin. With neighbourLimit 1
    // every unit's single nearest neighbour is its OWN twin, so the cross-group
    // rule discards all of them and the threshold is never exercised — a zero
    // that says nothing about whether the sources overlap.
    const units = [
      unit('a1', 'g1', at(0)),
      unit('a2', 'g1', at(0.001)),
      unit('b1', 'g2', at(1)),
      unit('b2', 'g2', at(1.001)),
    ];
    const report = await scan(units, { neighbourLimit: 1 });

    expect(report.census.groupsSeen).toBe(2);
    expect(report.census.candidatePairs).toBeGreaterThan(0);
    expect(report.census.pairsCrossGroup).toBe(0);
    expect(report.inconclusive).toMatch(/within a single source/);
  });

  it('flags a neighbour provider that returns nothing at all', async () => {
    const units = [unit('a', 'g1', at(0)), unit('b', 'g2', at(0))];
    const report = await scanOverlap(units, configureOverlapScan({ threshold: 0.9, neighbours: () => [] }));
    expect(report.pairs).toHaveLength(0);
    expect(report.inconclusive).toMatch(/no candidates at all/);
  });

  it('flags a provider returning ids outside the scanned set', async () => {
    const units = [unit('a', 'g1', at(0)), unit('b', 'g2', at(0))];
    const report = await scanOverlap(
      units,
      configureOverlapScan({ threshold: 0.9, neighbours: () => [{ id: 'ghost', similarity: 0.99 }] }),
    );
    expect(report.census.candidateHitsSeen).toBeGreaterThan(0);
    expect(report.inconclusive).toMatch(/not in the scanned set/);
  });

  it('flags an unembedded corpus — vectors never populated', async () => {
    const units: OverlapUnit[] = [
      { id: 'a', group: 'g1' },
      { id: 'b', group: 'g2' },
    ];
    const report = await scanOverlap(
      units,
      configureOverlapScan({ threshold: 0.9, neighbours: bruteForceNeighbours(units) }),
    );
    expect(report.pairs).toHaveLength(0);
    expect(report.inconclusive).toMatch(/no candidates at all/);
  });

  it('flags inconsistent embedding dimensions rather than reporting a clean corpus', async () => {
    let mismatches = 0;
    const units = [unit('a', 'g1', [1, 0]), unit('b', 'g2', [1, 0, 0])];
    const provider = bruteForceNeighbours(units, () => {
      mismatches++;
    });
    const report = await scanOverlap(units, configureOverlapScan({ threshold: 0.9, neighbours: provider }));
    expect(mismatches).toBeGreaterThan(0);
    expect(report.pairs).toHaveLength(0);
    expect(report.inconclusive).not.toBeNull();
  });

  it('says so when the maxPairs cap made the report partial', async () => {
    const units = [
      unit('a', 'g1', at(0)),
      unit('b', 'g2', at(0.01)),
      unit('c', 'g3', at(0.02)),
    ];
    const report = await scan(units, { maxPairs: 1 });
    expect(report.pairs).toHaveLength(1);
    expect(report.census.pairsDropped).toBeGreaterThan(0);
    expect(describeOverlapReport(report)).toMatch(/this report is partial/);
  });
});

/**
 * CALIBRATION CONTROL — the case that makes the blindness suite above mean
 * something. A corpus that is genuinely clean AND genuinely measurable must
 * return `inconclusive: null` with zero pairs. An implementation that always
 * reported "inconclusive" (and so passed every blindness case) fails here.
 */
describe('scanOverlap — calibration control', () => {
  it('a measurable, genuinely non-overlapping corpus is CONCLUSIVELY clean', async () => {
    const units = [
      unit('a', 'g1', at(0)),
      unit('b', 'g2', at(Math.PI / 2)), // orthogonal — real candidates, real comparisons
      unit('c', 'g3', at(Math.PI)),
    ];
    const report = await scan(units);

    expect(report.pairs).toHaveLength(0);
    expect(report.inconclusive).toBeNull(); // the control
    expect(report.census.candidatePairs).toBeGreaterThan(0);
    expect(report.census.pairsCrossGroup).toBeGreaterThan(0);
    expect(describeOverlapReport(report)).toMatch(/^No overlap found\./);
  });

  it('the same corpus with the threshold dropped DOES find pairs — the threshold is live, not inert', async () => {
    // Falsifier for "the scan finds nothing because it never compares anything":
    // identical inputs, lower threshold, non-empty result.
    const units = [
      unit('a', 'g1', at(0)),
      unit('b', 'g2', at(Math.PI / 2)),
      unit('c', 'g3', at(Math.PI)),
    ];
    const clean = await scan(units, { threshold: 0.9 });
    const loose = await scan(units, { threshold: -1 });

    expect(clean.pairs).toHaveLength(0);
    expect(loose.pairs.length).toBeGreaterThan(0);
    expect(loose.inconclusive).toBeNull();
  });
});

describe('describeOverlapReport', () => {
  it('always states the denominator, so a result cannot be quoted without it', async () => {
    const units = [unit('a', 'g1', at(0)), unit('b', 'g2', at(0.02))];
    const report = await scan(units);
    const line = describeOverlapReport(report);
    expect(line).toMatch(/Measured: 2 comparable unit\(s\) across 2 source\(s\)/);
    expect(line).toMatch(/threshold 0\.9/);
  });

  it('leads with INCONCLUSIVE when the run measured nothing', async () => {
    expect(describeOverlapReport(await scan([unit('only', 'g1', at(0))]))).toMatch(/^INCONCLUSIVE — /);
  });
});
