/**
 * The R-13 instrument's judging half (plan bm25-lexical-search-evoke-adoption-2026-10-10).
 * The case that matters most is the vacuous one: two arms that ran the same lexical engine
 * must read `invalid`, never `pass` — that is exactly what the first R-13 instrument
 * (memory/bench/ab-live-recall-cli.ts over memory_canonical) would have produced.
 */
import { describe, expect, it } from 'vitest';
import {
  LATENCY_P95_CEILING_MS,
  RECALL_K,
  armOrder,
  callAttribution,
  dumpOverlapOf,
  judgeLatency,
  summarizeAttribution,
  legDurations,
  overallLatencyVerdict,
  overallVerdict,
  pairedCounts,
  rankOf,
  redactPairsForArtifact,
  sampleFingerprint,
  splitDisjointSamples,
  statementDeltas,
  steadyPassProblems,
  summarizeArm,
  summarizeSource,
  warmQueryEmbeddings,
  type ArmObservation,
  type PairResult,
  type StatementStat,
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

/** n pairs found by both arms, every legacy call taking `legacyMs` and every BM25 call `bm25Ms`. */
function timed(n: number, legacyMs: number, bm25Ms: number): PairResult[] {
  return Array.from({ length: n }, (_, i) => ({
    ...pair(i, 1, 1),
    arms: { legacy: obs(1, 'legacy', legacyMs), bm25: obs(1, 'bm25', bm25Ms) },
  }));
}

describe('R-18 tail attribution: per-leg timing (WI-6554700010008520)', () => {
  // The shape runHybridSearch returns in `legs` (libs/generic/search/src/hybrid.ts sourceQuery).
  const legs = {
    lexical: { sourceCalls: [
      { source: 'work_item', ranker: 'lexical', status: 'ran', rows: 40, durationMs: 30 },
      { source: 'work_item', ranker: 'lexical', status: 'ran', rows: 10, durationMs: 12 },
    ] },
    semantic: { sourceCalls: [
      { source: 'work_item', ranker: 'embeddings', status: 'ran', rows: 40, durationMs: 95 },
      { source: 'work_item', ranker: 'chunks', status: 'timed-out', rows: null, durationMs: 400 },
      { source: 'work_item', ranker: 'embeddings', status: 'not-run', rows: null, durationMs: 0 },
    ] },
  };

  it('sums the durations of calls that RAN, keyed <leg>:<ranker>', () => {
    expect(legDurations(legs)).toEqual({ 'lexical:lexical': 42, 'semantic:embeddings': 95 });
  });

  it('never invents a leg: a timed-out or not-run call contributes nothing', () => {
    expect(legDurations(legs)).not.toHaveProperty('semantic:chunks');
  });

  it('returns {} for a missing or malformed instrument rather than zero-millisecond legs', () => {
    expect(legDurations(undefined)).toEqual({});
    expect(legDurations({ lexical: { sourceCalls: 'nope' } })).toEqual({});
  });

  it('reports each leg p95 over the observations that recorded it, independent of the call p95', () => {
    const pairs = Array.from({ length: 20 }, (_, i) => {
      const p = pair(i, 1, 1);
      // The lexical leg is flat at 20 ms; the semantic leg carries one 900 ms outlier.
      p.arms.bm25 = { ...obs(1, 'bm25', i === 19 ? 950 : 60), legMs: { 'lexical:lexical': 20, 'semantic:embeddings': i === 19 ? 900 : 40 } };
      return p;
    });
    const s = summarizeArm(pairs, 'bm25');
    expect(s.legP95Ms).toEqual({ 'lexical:lexical': 20, 'semantic:embeddings': 40 });
    expect(s.latencyP95Ms).toBe(60);
    const withTail = summarizeArm([...pairs, ...pairs.slice(19)], 'bm25');
    expect(withTail.legP95Ms['semantic:embeddings']).toBe(900);
    expect(withTail.legP95Ms['lexical:lexical']).toBe(20);
  });

  it('records no legs for observations written before legMs existed', () => {
    expect(summarizeArm([pair(0, 1, 1)], 'legacy').legP95Ms).toEqual({});
  });
});

describe('R-18 latency judgment (D-019)', () => {
  it('passes when the BM25 arm p95 is at or below the legacy arm p95', () => {
    expect(summarizeSource('work_item', timed(30, 600, 150)).latency.verdict).toBe('pass');
    expect(summarizeSource('work_item', timed(30, 200, 200)).latency.verdict).toBe('pass');
  });

  it('fails when the BM25 arm is slower, even when recall passes', () => {
    const s = summarizeSource('work_item', timed(30, 150, 151));
    expect(s.verdict).toBe('pass');
    expect(s.latency).toEqual({ verdict: 'fail', reason: 'BM25-arm p95 151 ms exceeds legacy p95 150 ms' });
  });

  it('judges p95, not the mean: one slow BM25 call in twenty does not flip it, two do', () => {
    const one = timed(20, 100, 50);
    one[0]!.arms.bm25 = obs(1, 'bm25', 5000);
    expect(summarizeSource('work_item', one).latency.verdict).toBe('pass');
    const two = timed(20, 100, 50);
    two[0]!.arms.bm25 = obs(1, 'bm25', 5000);
    two[1]!.arms.bm25 = obs(1, 'bm25', 5000);
    expect(summarizeSource('work_item', two).latency.verdict).toBe('fail');
  });

  it('is invalid when the recall comparison is invalid or an arm has no samples', () => {
    expect(summarizeSource('work_item', timed(3, 100, 50)).latency.verdict).toBe('invalid');
    const arms = { legacy: summarizeArm([], 'legacy'), bm25: summarizeArm(timed(30, 1, 1), 'bm25') };
    expect(judgeLatency(arms).verdict).toBe('invalid');
  });

  it('fails above the source ceiling even when legacy is slower (D-020)', () => {
    expect(LATENCY_P95_CEILING_MS).toEqual({ work_item: 200, session_turn: 400 });
    const s = summarizeSource('work_item', timed(30, 3000, 201));
    expect(s.verdict).toBe('pass');
    expect(s.latency).toEqual({ verdict: 'fail', reason: 'BM25-arm p95 201 ms <= legacy p95 3000 ms, but it exceeds the 200 ms ceiling' });
    const turns = timed(30, 3000, 401).map((p) => ({ ...p, source: 'session_turn' }));
    expect(summarizeSource('session_turn', turns).latency.verdict).toBe('fail');
    const turnsOk = timed(30, 3000, 400).map((p) => ({ ...p, source: 'session_turn' }));
    expect(summarizeSource('session_turn', turnsOk).latency).toEqual({
      verdict: 'pass',
      reason: 'BM25-arm p95 400 ms <= legacy p95 3000 ms and the 400 ms ceiling',
    });
  });

  it('names both failures when the BM25 arm breaks the legacy bound and the ceiling', () => {
    expect(summarizeSource('work_item', timed(30, 250, 300)).latency.reason).toBe(
      'BM25-arm p95 300 ms exceeds legacy p95 250 ms; it also exceeds the 200 ms ceiling',
    );
  });

  it('judges a source with no ceiling against legacy only, and says so', () => {
    const other = timed(30, 3000, 900).map((p) => ({ ...p, source: 'memory' }));
    expect(summarizeSource('memory', other).latency).toEqual({
      verdict: 'pass',
      reason: 'BM25-arm p95 900 ms <= legacy p95 3000 ms (no absolute ceiling for this source)',
    });
    const arms = { legacy: summarizeArm(timed(30, 100, 50), 'legacy'), bm25: summarizeArm(timed(30, 100, 50), 'bm25') };
    expect(judgeLatency(arms, 40).verdict).toBe('fail');
    expect(judgeLatency(arms).verdict).toBe('pass');
  });

  it('embeds every distinct query once, in sample order, before timing (D-021)', async () => {
    const calls: string[] = [];
    const embed = async (q: string) => {
      calls.push(q);
      return [0];
    };
    const n = await warmQueryEmbeddings([{ query: 'b' }, { query: 'a' }, { query: 'b' }, { query: 'c' }], embed);
    expect(n).toBe(3);
    expect(calls).toEqual(['b', 'a', 'c']);
    expect(await warmQueryEmbeddings([], embed)).toBe(0);
  });

  it('combines per-source judgments like the recall verdict', () => {
    const pass = summarizeSource('work_item', timed(30, 600, 150));
    const fail = summarizeSource('work_item', timed(30, 150, 600));
    const invalid = summarizeSource('work_item', timed(3, 600, 150));
    expect(overallLatencyVerdict([pass, pass])).toBe('pass');
    expect(overallLatencyVerdict([pass, fail])).toBe('fail');
    expect(overallLatencyVerdict([fail, invalid])).toBe('invalid');
    expect(overallLatencyVerdict([])).toBe('invalid');
  });
});

/** n BM25-only steady calls for `source`, every one taking `ms` and running `engine`. */
function steadyCalls(n: number, ms: number, source = 'session_turn', engine: 'bm25' | 'legacy' = 'bm25'): PairResult[] {
  return Array.from({ length: n }, (_, i) => ({
    source,
    targetId: `S-${i}`,
    style: 'fragment' as const,
    query: `steady ${i}`,
    arms: { bm25: obs(1, engine, ms) },
  }));
}

function turnsTimed(n: number, legacyMs: number, bm25Ms: number): PairResult[] {
  return timed(n, legacyMs, bm25Ms).map((p) => ({ ...p, source: 'session_turn' }));
}

/** Stamp every arm of `pairs` with a D-027 dump check; `at` limits it to one pair index. */
function dumped(pairs: PairResult[], flag: boolean | null, at?: number): PairResult[] {
  return pairs.map((p, i) => {
    if (at !== undefined && i !== at) {
      return { ...p, arms: { legacy: { ...p.arms.legacy!, dumpActive: false }, bm25: { ...p.arms.bm25!, dumpActive: false } } };
    }
    return { ...p, arms: { legacy: { ...p.arms.legacy!, dumpActive: flag }, bm25: { ...p.arms.bm25!, dumpActive: flag } } };
  });
}

describe('R-18 ceiling precondition: no full-database dump during the paired calls (D-027)', () => {
  it('dumpOverlapOf: true on any overlap, false only when every call was checked clean, null when some call is unchecked', () => {
    expect(dumpOverlapOf(turnsTimed(30, 4000, 100))).toBeUndefined();
    expect(dumpOverlapOf(dumped(turnsTimed(30, 4000, 100), false))).toBe(false);
    expect(dumpOverlapOf(dumped(turnsTimed(30, 4000, 100), true, 17))).toBe(true);
    expect(dumpOverlapOf(dumped(turnsTimed(30, 4000, 100), null, 3))).toBeNull();
    const oneUnstamped = dumped(turnsTimed(30, 4000, 100), false);
    oneUnstamped[5] = turnsTimed(30, 4000, 100)[5]!;
    expect(dumpOverlapOf(oneUnstamped)).toBeNull();
  });

  it('does not judge the ceiling when a dump overlapped, in either direction', () => {
    const over = summarizeSource('session_turn', dumped(turnsTimed(30, 4000, 500), true, 0));
    expect(over.dumpOverlap).toBe(true);
    expect(over.latency).toEqual({
      verdict: 'invalid',
      reason: 'BM25-arm p95 500 ms <= legacy p95 4000 ms; the 400 ms ceiling is not judged on this run: a full-database dump (pcbackup) was in progress during the paired calls (D-027)',
    });
    expect(summarizeSource('session_turn', dumped(turnsTimed(30, 4000, 100), true)).latency.verdict).toBe('invalid');
    const unchecked = summarizeSource('session_turn', dumped(turnsTimed(30, 4000, 100), null, 2));
    expect(unchecked.latency.verdict).toBe('invalid');
    expect(unchecked.latency.reason).toContain('could not be checked');
  });

  it('still fails the relative bound when a dump overlapped', () => {
    const s = summarizeSource('session_turn', dumped(turnsTimed(30, 400, 500), true));
    expect(s.latency).toEqual({ verdict: 'fail', reason: 'BM25-arm p95 500 ms exceeds legacy p95 400 ms; it also exceeds the 400 ms ceiling' });
  });

  it('judges the ceiling when every paired call was checked with no dump', () => {
    expect(summarizeSource('session_turn', dumped(turnsTimed(30, 4000, 401), false)).latency.verdict).toBe('fail');
    expect(summarizeSource('session_turn', dumped(turnsTimed(30, 4000, 400), false)).latency).toEqual({
      verdict: 'pass',
      reason: 'BM25-arm p95 400 ms <= legacy p95 4000 ms and the 400 ms ceiling',
    });
    expect(judgeLatency(summarizeSource('session_turn', turnsTimed(30, 4000, 401)).arms, 400, false).verdict).toBe('fail');
  });
});

describe('R-18 warm-repeat pass: the ceiling judges it; the cold paired p95 is reported (D-028)', () => {
  /** `steadyCalls` builds BM25-only calls; as a warm-repeat pass they are the timed repeats. */
  const warm = steadyCalls;
  const withReads = (pairs: PairResult[], readAt: number[]): PairResult[] =>
    pairs.map((p, i) => ({
      ...p,
      arms: { bm25: { ...p.arms.bm25!, attrib: { pgExecMs: 5, pgReadMs: 0, pgBlksRead: readAt.includes(i) ? 40 : 0, pgCalls: 2 } } },
    }));

  it('judges the ceiling on the warm-repeat p95, not the cold paired p95', () => {
    // Run 8's shape: cold paired p95 over the ceiling, legacy far slower, the warm repeat fast.
    const s = summarizeSource('session_turn', turnsTimed(30, 8000, 600), 20, null, warm(30, 250));
    expect(s.warmRepeat?.latencyP95Ms).toBe(250);
    expect(s.arms.bm25.latencyP95Ms).toBe(600);
    expect(s.latency).toEqual({
      verdict: 'pass',
      reason: 'BM25-arm p95 600 ms <= legacy p95 8000 ms; warm-repeat BM25 p95 250 ms <= the 400 ms ceiling; cold paired p95 600 ms reported, not judged (D-028)',
    });
  });

  it('fails when the warm-repeat p95 exceeds the source ceiling, even with a fast cold pass', () => {
    const s = summarizeSource('session_turn', turnsTimed(30, 4000, 100), 20, null, warm(30, 401));
    expect(s.latency).toEqual({
      verdict: 'fail',
      reason: 'BM25-arm p95 100 ms <= legacy p95 4000 ms, but the warm-repeat BM25 p95 401 ms exceeds the 400 ms ceiling; cold paired p95 100 ms reported, not judged (D-028)',
    });
    expect(summarizeSource('work_item', timed(30, 4000, 100), 20, null, warm(30, 201, 'work_item')).latency.verdict).toBe('fail');
    expect(summarizeSource('work_item', timed(30, 4000, 100), 20, null, warm(30, 200, 'work_item')).latency.verdict).toBe('pass');
  });

  it('keeps the D-019 relative bound on the cold paired pass, and names a warm ceiling breach beside it', () => {
    const fast = summarizeSource('work_item', timed(30, 150, 151), 20, null, warm(30, 50, 'work_item'));
    expect(fast.latency).toEqual({ verdict: 'fail', reason: 'BM25-arm p95 151 ms exceeds legacy p95 150 ms' });
    const slow = summarizeSource('work_item', timed(30, 150, 151), 20, null, warm(30, 300, 'work_item'));
    expect(slow.latency).toEqual({
      verdict: 'fail',
      reason: 'BM25-arm p95 151 ms exceeds legacy p95 150 ms; the warm-repeat p95 300 ms also exceeds the 200 ms ceiling',
    });
  });

  it('does not gate the ceiling on a dump overlap when a warm-repeat pass exists, and still reports the overlap', () => {
    const s = summarizeSource('session_turn', dumped(turnsTimed(30, 4000, 500), true), 20, null, warm(30, 100));
    expect(s.dumpOverlap).toBe(true);
    expect(s.latency.verdict).toBe('pass');
  });

  it('reads an unsound warm-repeat pass as invalid for the ceiling, never a pass', () => {
    const tooFew = summarizeSource('session_turn', turnsTimed(30, 4000, 100), 20, null, warm(5, 10));
    expect(tooFew.warmRepeatProblems).toEqual(['only 5 warm-repeat call(s); at least 20 are needed']);
    expect(tooFew.latency).toEqual({
      verdict: 'invalid',
      reason: 'BM25-arm p95 100 ms <= legacy p95 4000 ms; the 400 ms ceiling is not judged: the warm-repeat pass is unsound: only 5 warm-repeat call(s); at least 20 are needed (D-028)',
    });
    const legacyEngine = summarizeSource('session_turn', turnsTimed(30, 4000, 100), 20, null, warm(30, 10, 'session_turn', 'legacy'));
    expect(legacyEngine.latency.verdict).toBe('invalid');
    expect(legacyEngine.latency.reason).toContain('warm-repeat calls ran engine(s) [legacy], expected [bm25]');
    const empty = summarizeSource('session_turn', turnsTimed(30, 4000, 100), 20, null, []);
    expect(empty.latency.verdict).toBe('invalid');
    expect(empty.warmRepeatProblems).toEqual(['only 0 warm-repeat call(s); at least 20 are needed']);
  });

  it('uses only its own source warm repeats', () => {
    const both = [...warm(30, 900, 'work_item'), ...warm(30, 120, 'session_turn')];
    expect(summarizeSource('session_turn', turnsTimed(30, 4000, 100), 20, null, both).warmRepeat?.latencyP95Ms).toBe(120);
    expect(summarizeSource('work_item', timed(30, 4000, 100), 20, null, both).latency.verdict).toBe('fail');
  });

  it('counts repeats whose statements read blocks as an upper bound, reported only; null when unrecorded', () => {
    expect(summarizeSource('session_turn', turnsTimed(30, 4000, 100), 20, null, warm(30, 100)).warmRepeatReadCalls).toBeNull();
    const read = summarizeSource('session_turn', turnsTimed(30, 4000, 100), 20, null, withReads(warm(30, 100), [2, 9]));
    expect(read.warmRepeatReadCalls).toBe(2);
    expect(read.latency.verdict).toBe('pass');
  });

  it('judges a run with no warm-repeat pass as before D-028: the ceiling on the paired p95', () => {
    const s = summarizeSource('session_turn', dumped(turnsTimed(30, 4000, 401), false));
    expect(s.warmRepeat).toBeNull();
    expect(s.warmRepeatProblems).toEqual([]);
    expect(s.warmRepeatReadCalls).toBeNull();
    expect(s.latency.verdict).toBe('fail');
  });

  it('judgeLatency reads the warm-repeat pass it is given', () => {
    const arms = summarizeSource('session_turn', turnsTimed(30, 4000, 900)).arms;
    expect(judgeLatency(arms, 400, true, { summary: summarizeArm(warm(30, 401), 'bm25'), problems: [] }).verdict).toBe('fail');
    expect(judgeLatency(arms, 400, true, { summary: summarizeArm(warm(30, 399), 'bm25'), problems: [] }).verdict).toBe('pass');
    expect(judgeLatency(arms, null, true, { summary: summarizeArm(warm(30, 999), 'bm25'), problems: [] }).verdict).toBe('pass');
  });
});

describe('R-18 steady pass: reported data only, it judges nothing (D-026, D-027)', () => {
  it('judges the ceiling on the cold paired p95; the steady p95 is only reported', () => {
    // Cold paired BM25 p95 1100 ms is under legacy 4000 ms but over 400; a fast steady pass does not rescue it.
    const s = summarizeSource('session_turn', turnsTimed(30, 4000, 1100), 20, steadyCalls(30, 250));
    expect(s.steady?.latencyP95Ms).toBe(250);
    expect(s.arms.bm25.latencyP95Ms).toBe(1100);
    expect(s.latency).toEqual({
      verdict: 'fail',
      reason: 'BM25-arm p95 1100 ms <= legacy p95 4000 ms, but it exceeds the 400 ms ceiling',
    });
  });

  it('a slow steady pass does not fail a fast paired pass', () => {
    const s = summarizeSource('session_turn', turnsTimed(30, 4000, 100), 20, steadyCalls(30, 401));
    expect(s.latency).toEqual({ verdict: 'pass', reason: 'BM25-arm p95 100 ms <= legacy p95 4000 ms and the 400 ms ceiling' });
  });

  it('keeps the D-019 relative bound on the paired pass when a steady pass exists', () => {
    const s = summarizeSource('work_item', timed(30, 150, 151), 20, steadyCalls(30, 50, 'work_item'));
    expect(s.latency).toEqual({ verdict: 'fail', reason: 'BM25-arm p95 151 ms exceeds legacy p95 150 ms' });
  });

  it('reports a steady pass that is too small, incomplete or ran another engine without changing the verdict', () => {
    const tooFew = summarizeSource('session_turn', turnsTimed(30, 4000, 100), 20, steadyCalls(5, 10));
    expect(tooFew.latency.verdict).toBe('pass');
    expect(tooFew.steadyProblems).toEqual(['only 5 steady call(s); at least 20 are needed']);
    const legacyEngine = summarizeSource('session_turn', turnsTimed(30, 4000, 100), 20, steadyCalls(30, 10, 'session_turn', 'legacy'));
    expect(legacyEngine.latency.verdict).toBe('pass');
    expect(legacyEngine.steadyProblems.join()).toContain('steady calls ran engine(s) [legacy], expected [bm25]');
    expect(summarizeSource('session_turn', turnsTimed(30, 4000, 100)).steadyProblems).toEqual([]);
    const incomplete = steadyCalls(30, 10);
    incomplete[3] = { ...incomplete[3]!, arms: {} };
    expect(steadyPassProblems(incomplete, 20)).toEqual(['1 steady call(s) recorded no BM25 observation']);
    expect(steadyPassProblems(steadyCalls(20, 10), 20)).toEqual([]);
  });

  it('uses only its own source steady calls', () => {
    const steady = [...steadyCalls(30, 900, 'work_item'), ...steadyCalls(30, 120, 'session_turn')];
    const s = summarizeSource('session_turn', turnsTimed(30, 4000, 100), 20, steady);
    expect(s.steady?.scored).toBe(30);
    expect(s.steady?.latencyP95Ms).toBe(120);
    expect(s.latency.verdict).toBe('pass');
    const w = summarizeSource('work_item', timed(30, 4000, 100), 20, steady);
    expect(w.steady?.latencyP95Ms).toBe(900);
    expect(w.latency.verdict).toBe('pass');
  });

  it('judges an artifact with no steady pass exactly as before D-024', () => {
    const s = summarizeSource('session_turn', turnsTimed(30, 3000, 400));
    expect(s.steady).toBeNull();
    expect(s.latency).toEqual({ verdict: 'pass', reason: 'BM25-arm p95 400 ms <= legacy p95 3000 ms and the 400 ms ceiling' });
  });

  it('reports an empty steady pass as a problem without judging it', () => {
    const s = summarizeSource('session_turn', turnsTimed(30, 3000, 100), 20, []);
    expect(s.steady?.latencyP95Ms).toBeNull();
    expect(s.steadyProblems).toEqual(['only 0 steady call(s); at least 20 are needed']);
    expect(s.latency.verdict).toBe('pass');
  });

  it('splits candidates into disjoint paired / warm-up / steady samples, paired first in seeded order', () => {
    const c = (id: string, query: string) => ({ targetId: id, query });
    const candidates = [
      c('a', 'q1'), c('b', 'q2'), c('a', 'q9'), c('c', 'q3'), c('d', 'q2'), c('e', 'q4'), c('f', 'q5'), c('g', 'q6'), c('h', 'q7'),
    ];
    const split = splitDisjointSamples(candidates, 2);
    expect(split.paired.map((x) => x.targetId)).toEqual(['a', 'b']);
    // 'a' (repeat id) and 'd' (repeat query) are skipped.
    expect(split.warmup.map((x) => x.targetId)).toEqual(['c', 'e']);
    expect(split.steady.map((x) => x.targetId)).toEqual(['f', 'g']);
    const all = [...split.paired, ...split.warmup, ...split.steady];
    expect(new Set(all.map((x) => x.targetId)).size).toBe(all.length);
    expect(new Set(all.map((x) => x.query)).size).toBe(all.length);
    // Too few candidates leave the later samples short rather than overlapping.
    expect(splitDisjointSamples(candidates.slice(0, 4), 2)).toEqual({
      paired: [c('a', 'q1'), c('b', 'q2')],
      warmup: [c('c', 'q3')],
      steady: [],
    });
  });

  it('the paired sample is the same prefix whatever the steady sample size', () => {
    const candidates = Array.from({ length: 30 }, (_, i) => ({ targetId: `t${i}`, query: `q${i}` }));
    expect(splitDisjointSamples(candidates, 5).paired).toEqual(candidates.slice(0, 5));
  });
});

describe('statementDeltas (pg_stat_statements read-time attribution, D-024)', () => {
  const stat = (queryid: string, calls: number, totalExecMs: number, read: number, readMs: number): StatementStat => ({
    queryid, calls, totalExecMs, sharedBlksHit: calls * 100, sharedBlksRead: read, sharedBlkReadMs: readMs, query: `q${queryid}`,
  });

  it('subtracts the before snapshot, keeps statements with calls in the window, slowest first', () => {
    const before = [stat('1', 10, 1000, 50, 100), stat('2', 5, 500, 0, 0), stat('3', 7, 70, 0, 0)];
    const after = [stat('1', 70, 16_000, 16_423, 7_600), stat('2', 65, 3_500, 100, 300), stat('3', 7, 70, 0, 0)];
    const d = statementDeltas(before, after);
    expect(d.map((x) => x.queryid)).toEqual(['1', '2']);
    expect(d[0]).toMatchObject({ calls: 60, totalExecMs: 15_000, sharedBlksRead: 16_373, sharedBlkReadMs: 7_500, meanExecMs: 250, readTimeShare: 0.5 });
    expect(d[1]).toMatchObject({ calls: 60, totalExecMs: 3_000, meanExecMs: 50, readTimeShare: 0.1 });
  });

  it('counts a new or reset statement from zero instead of reporting negative deltas', () => {
    const d = statementDeltas([stat('1', 100, 9_000, 10, 10)], [stat('1', 4, 400, 2, 1), stat('4', 3, 30, 0, 0)]);
    expect(d.map((x) => [x.queryid, x.calls, x.totalExecMs])).toEqual([['1', 4, 400], ['4', 3, 30]]);
  });

  it('reports no read share for a zero-time statement', () => {
    expect(statementDeltas([], [stat('9', 2, 0, 0, 0)])[0]!.readTimeShare).toBeNull();
  });
});

describe('per-call attribution (D-026)', () => {
  const stat = (queryid: string, calls: number, totalExecMs: number, read: number, readMs: number): StatementStat => ({
    queryid, calls, totalExecMs, sharedBlksHit: 0, sharedBlksRead: read, sharedBlkReadMs: readMs, query: '',
  });

  it('sums the lexical statements that ran during one call', () => {
    const before = [stat('1', 10, 1000, 5, 10), stat('2', 4, 100, 0, 0), stat('3', 1, 5, 0, 0)];
    const after = [stat('1', 11, 1150.5, 105, 60), stat('2', 5, 130, 2, 1), stat('3', 1, 5, 0, 0)];
    expect(callAttribution(before, after)).toEqual({ pgExecMs: 180.5, pgReadMs: 51, pgBlksRead: 102, pgCalls: 2 });
    expect(callAttribution(after, after)).toEqual({ pgExecMs: 0, pgReadMs: 0, pgBlksRead: 0, pgCalls: 0 });
  });

  it('reports the lexical leg time spent outside statement execution', () => {
    const o = (lex: number, exec: number): ArmObservation => ({
      ...obs(1, 'bm25', lex + 20),
      legMs: { 'lexical:lexical': lex },
      attrib: { pgExecMs: exec, pgReadMs: exec / 2, pgBlksRead: 1, pgCalls: 3 },
    });
    expect(summarizeAttribution([o(400, 100), o(600, 400), obs(1, 'bm25', 9000)])).toEqual({
      calls: 2, wallMs: 1040, lexicalMs: 1000, pgExecMs: 500, pgReadMs: 250, outsideExecShare: 0.5,
    });
    expect(summarizeAttribution([]).outsideExecShare).toBeNull();
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
