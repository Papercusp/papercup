/**
 * The R-13 instrument's judging half (plan bm25-lexical-search-evoke-adoption-2026-10-10).
 * The case that matters most is the vacuous one: two arms that ran the same lexical engine
 * must read `invalid`, never `pass` — that is exactly what the first R-13 instrument
 * (memory/bench/ab-live-recall-cli.ts over memory_canonical) would have produced.
 */
import { describe, expect, it } from 'vitest';
import {
  RECALL_K,
  armOrder,
  overallVerdict,
  pairedCounts,
  rankOf,
  redactPairsForArtifact,
  sampleFingerprint,
  summarizeArm,
  summarizeSource,
  type ArmObservation,
  type PairResult,
} from './bm25-hybrid-recall';

function obs(rank: number | null, engine: 'bm25' | 'legacy', latencyMs = 10, hits = 10): ArmObservation {
  return { rank, engine, latencyMs, hits };
}

function pair(i: number, legacyRank: number | null, bm25Rank: number | null, source = 'work_item'): PairResult {
  return {
    source,
    targetId: `T-${i}`,
    style: i % 2 ? 'keyword' : 'fragment',
    query: `query ${i}`,
    arms: { legacy: obs(legacyRank, 'legacy'), bm25: obs(bm25Rank, 'bm25') },
  };
}

/** n pairs; the first `legacyHits` found by legacy, the first `bm25Hits` found by BM25. */
function sample(n: number, legacyHits: number, bm25Hits: number, source = 'work_item'): PairResult[] {
  return Array.from({ length: n }, (_, i) => pair(i, i < legacyHits ? 1 : null, i < bm25Hits ? 2 : null, source));
}

describe('summarizeArm', () => {
  it('counts recall@K, MRR and zero-hits over the observed pairs', () => {
    const pairs = [pair(0, 1, 3), pair(1, null, 1), pair(2, RECALL_K + 1, null)];
    pairs[2]!.arms.bm25 = obs(null, 'bm25', 10, 0);
    const legacy = summarizeArm(pairs, 'legacy');
    expect(legacy).toMatchObject({ scored: 3, hitsAtK: 1, zeroHit: 0, engines: ['legacy'] });
    expect(legacy.mrrAtK).toBeCloseTo(1 / 3, 10);
    const bm25 = summarizeArm(pairs, 'bm25');
    expect(bm25).toMatchObject({ scored: 3, hitsAtK: 2, zeroHit: 1 });
    expect(bm25.mrrAtK).toBeCloseTo((1 / 3 + 1) / 3, 10);
  });

  it('a rank beyond K is a miss, not a hit', () => {
    expect(summarizeArm([pair(0, RECALL_K + 1, RECALL_K)], 'legacy').hitsAtK).toBe(0);
    expect(summarizeArm([pair(0, RECALL_K + 1, RECALL_K)], 'bm25').hitsAtK).toBe(1);
  });
});

describe('pairedCounts', () => {
  it('splits pairs into both / bm25-only / legacy-only / neither', () => {
    expect(pairedCounts([pair(0, 1, 1), pair(1, null, 2), pair(2, 4, null), pair(3, null, null)])).toEqual({
      both: 1,
      bm25Only: 1,
      legacyOnly: 1,
      neither: 1,
    });
  });
});

describe('summarizeSource verdict', () => {
  it('passes when BM25 recall is at least legacy recall', () => {
    expect(summarizeSource('work_item', sample(30, 20, 20)).verdict).toBe('pass');
    expect(summarizeSource('work_item', sample(30, 20, 25)).verdict).toBe('pass');
  });

  it('fails when BM25 recall is below legacy recall', () => {
    const s = summarizeSource('work_item', sample(30, 21, 20));
    expect(s.verdict).toBe('fail');
    expect(s.reasons.join(' ')).toMatch(/below legacy/);
  });

  it('is invalid, not pass, when both arms ran the legacy engine (the flag never reached the seam)', () => {
    const pairs = sample(30, 20, 20).map((p) => ({ ...p, arms: { ...p.arms, bm25: { ...p.arms.bm25!, engine: 'legacy' as const } } }));
    const s = summarizeSource('work_item', pairs);
    expect(s.verdict).toBe('invalid');
    expect(s.reasons.join(' ')).toMatch(/did not reach the lexical seam/);
  });

  it('is invalid when the legacy arm ran BM25', () => {
    const pairs = sample(30, 20, 20).map((p) => ({ ...p, arms: { ...p.arms, legacy: { ...p.arms.legacy!, engine: 'bm25' as const } } }));
    expect(summarizeSource('work_item', pairs).verdict).toBe('invalid');
  });

  it('is invalid when a pair is missing an arm', () => {
    const pairs = sample(30, 20, 20);
    delete pairs[3]!.arms.bm25;
    expect(summarizeSource('work_item', pairs).verdict).toBe('invalid');
  });

  it('is invalid when the sample is too small to read', () => {
    expect(summarizeSource('work_item', sample(5, 5, 5)).verdict).toBe('invalid');
    expect(summarizeSource('work_item', sample(5, 5, 5), 5).verdict).toBe('pass');
  });

  it('judges only its own source', () => {
    const pairs = [...sample(30, 20, 20, 'work_item'), ...sample(30, 25, 10, 'session_turn')];
    expect(summarizeSource('work_item', pairs).verdict).toBe('pass');
    expect(summarizeSource('session_turn', pairs).verdict).toBe('fail');
  });
});

describe('overallVerdict', () => {
  const pass = summarizeSource('work_item', sample(30, 20, 20));
  const fail = summarizeSource('work_item', sample(30, 21, 20));
  const invalid = summarizeSource('work_item', sample(3, 3, 3));
  it('invalid outranks fail, which outranks pass', () => {
    expect(overallVerdict([pass, pass])).toBe('pass');
    expect(overallVerdict([pass, fail])).toBe('fail');
    expect(overallVerdict([fail, invalid])).toBe('invalid');
  });
  it('an empty run is invalid', () => {
    expect(overallVerdict([])).toBe('invalid');
  });
});

describe('helpers', () => {
  it('sampleFingerprint ignores order and changes with content', () => {
    const a = sample(4, 2, 2);
    expect(sampleFingerprint(a)).toBe(sampleFingerprint([...a].reverse()));
    expect(sampleFingerprint(a)).not.toBe(sampleFingerprint([...a.slice(1), { ...a[0]!, query: 'other' }]));
  });

  it('redactPairsForArtifact scrubs box identity from sampled queries before they are written', () => {
    // Built at runtime: tracked source may not spell a home path or a real identity literal.
    const home = ['', 'home', 'qzsynthuser', 'repo', 'notes.md'].join('/');
    const literals: [string, string][] = [['gitEmail', 'qz.synth@example.invalid']];
    const pairs = [
      { source: 'session_turn', targetId: 'A', query: `diagnostic extraction ${home} papercusp` },
      { source: 'work_item', targetId: 'B', query: 'mail qz.synth@example.invalid about the gate' },
      { source: 'work_item', targetId: 'C', query: 'plain known-item fragment' },
    ];
    const { pairs: written, redactedQueries } = redactPairsForArtifact(pairs, literals);
    expect(redactedQueries).toBe(2);
    expect(written[0]!.query).not.toContain('qzsynthuser');
    expect(written[0]!.query).toContain('diagnostic extraction');
    expect(written[1]!.query).not.toContain('qz.synth@example.invalid');
    expect(written[2]).toBe(pairs[2]);
    // The fingerprint is taken on the raw sample, so redaction must not touch the input.
    expect(pairs[0]!.query).toContain('qzsynthuser');
  });

  it('armOrder alternates which arm runs first', () => {
    expect(armOrder(0)).toEqual(['legacy', 'bm25']);
    expect(armOrder(1)).toEqual(['bm25', 'legacy']);
  });

  it('rankOf matches source and id together', () => {
    const hits = [
      { source: 'session_turn', source_id: 'X' },
      { source: 'work_item', source_id: 'X' },
    ];
    expect(rankOf(hits, 'work_item', 'X')).toBe(2);
    expect(rankOf(hits, 'work_item', 'Y')).toBeNull();
  });
});
