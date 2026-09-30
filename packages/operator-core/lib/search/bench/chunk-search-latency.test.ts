import { describe, expect, it } from 'vitest';
import {
  CHUNK_SEARCH_LATENCY_QUERIES,
  D024_BASELINE_P95_MS,
  D024_QUERY_SET_HASH,
  percentile,
  querySetHash,
  r33Verdicts,
  summariseSite,
  type LatencySample,
} from './chunk-search-latency';

describe('chunk-search latency bench (R-33, D-024)', () => {
  it('replays the exact 30-query set D-024 recorded its baseline with', () => {
    expect(CHUNK_SEARCH_LATENCY_QUERIES).toHaveLength(30);
    expect(new Set(CHUNK_SEARCH_LATENCY_QUERIES).size).toBe(30);
    expect(querySetHash()).toBe(D024_QUERY_SET_HASH);
  });

  it('control: changing one query or the order moves the hash', () => {
    const edited = [...CHUNK_SEARCH_LATENCY_QUERIES];
    edited[0] = `${edited[0]} `;
    expect(querySetHash(edited)).not.toBe(D024_QUERY_SET_HASH);
    const swapped = [...CHUNK_SEARCH_LATENCY_QUERIES];
    [swapped[0], swapped[1]] = [swapped[1], swapped[0]];
    expect(querySetHash(swapped)).not.toBe(D024_QUERY_SET_HASH);
  });

  it('percentile is nearest-rank and empty input has no percentile', () => {
    const xs = Array.from({ length: 20 }, (_, i) => i + 1); // 1..20
    expect(percentile(xs, 95)).toBe(19);
    expect(percentile(xs, 50)).toBe(10);
    expect(percentile([7], 95)).toBe(7);
    expect(percentile([], 95)).toBeNull();
  });

  it('failed calls count as errors and stay out of the percentiles', () => {
    const samples: LatencySample[] = [
      ...Array.from({ length: 10 }, (_, i) => ({ round: 0, q: i, ms: 100, ok: true, degraded: false })),
      ...Array.from({ length: 10 }, (_, i) => ({ round: 1, q: i, ms: 200, ok: true, degraded: i === 0 })),
      { round: 1, q: 10, ms: 99_999, ok: false, degraded: false, retries: 2, error: 'ECONNRESET' },
    ];
    const s = summariseSite(samples, 2);
    expect(s).toMatchObject({ n: 21, ok: 20, errors: 1, degraded: 1, transportRetries: 2, max: 200 });
    expect(s.p95).toBe(200);
    expect(s.perRoundP95).toEqual([100, 200]);
    expect(s.firstErrors).toEqual(['ECONNRESET']);
  });

  it('R-33 verdict: at the bound passes, over it fails, no sample is not a pass', () => {
    const at = (p95: number | null) => ({ ...summariseSite([], 1), p95 });
    const v = r33Verdicts({
      plans: at(D024_BASELINE_P95_MS.plans * 1.25),
      turns: at(D024_BASELINE_P95_MS.turns * 1.25 + 1),
      work_item: at(null),
    });
    const bySite = Object.fromEntries(v.map((x) => [x.site, x]));
    expect(bySite.plans.withinBound).toBe(true);
    expect(bySite.turns.withinBound).toBe(false);
    expect(bySite.work_item.withinBound).toBeNull();
    expect(bySite.consult.withinBound).toBeNull();
    expect(bySite.work_items_search.bound).toBe(500);
    expect(bySite.consult.bound).toBe(17.5);
  });
});
