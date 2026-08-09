import { describe, it, expect } from 'vitest';
import {
  segmentBursts,
  minePatterns,
  minePatternsFromEvents,
  containsRun,
  strengthOf,
  type SequenceEvent,
  type Burst,
} from './index';

const ev = (cohort: string, symbol: string, at: number): SequenceEvent => ({ cohort, symbol, at });

/** Build a burst directly (bypassing segmentation) for mining-only tests. */
const burst = (cohort: string, symbols: string[]): Burst => ({
  cohort,
  symbols,
  startedAt: 0,
  endedAt: symbols.length,
});

describe('segmentBursts', () => {
  it('cuts a stream wherever consecutive events exceed the idle gap', () => {
    const events = [
      ev('a', 'x', 0),
      ev('a', 'y', 100),
      ev('a', 'z', 200),
      // 10s gap — a new burst
      ev('a', 'p', 10_200),
      ev('a', 'q', 10_300),
    ];
    const bursts = segmentBursts(events, { gapMs: 1_000 });
    expect(bursts.map((b) => b.symbols)).toEqual([
      ['x', 'y', 'z'],
      ['p', 'q'],
    ]);
  });

  it('never joins two cohorts into one burst even when interleaved in time', () => {
    // Interleaved timestamps: a naive global sort with no cohort partition would
    // produce the sequence a→b→a→b, which no actor ever performed.
    const events = [
      ev('agent-1', 'x', 0),
      ev('agent-2', 'p', 10),
      ev('agent-1', 'y', 20),
      ev('agent-2', 'q', 30),
    ];
    const bursts = segmentBursts(events, { gapMs: 1_000 });
    expect(bursts).toHaveLength(2);
    for (const b of bursts) {
      expect(new Set(b.symbols.map(() => b.cohort)).size).toBe(1);
    }
    expect(bursts.find((b) => b.cohort === 'agent-1')!.symbols).toEqual(['x', 'y']);
    expect(bursts.find((b) => b.cohort === 'agent-2')!.symbols).toEqual(['p', 'q']);
  });

  it('sorts unsorted input rather than requiring the caller to pre-sort', () => {
    const events = [ev('a', 'z', 300), ev('a', 'x', 100), ev('a', 'y', 200)];
    expect(segmentBursts(events, { gapMs: 1_000 })[0]!.symbols).toEqual(['x', 'y', 'z']);
  });

  it('drops bursts below minBurstLength', () => {
    const events = [ev('a', 'x', 0), ev('a', 'y', 50), ev('a', 'lonely', 100_000)];
    const bursts = segmentBursts(events, { gapMs: 1_000, minBurstLength: 2 });
    expect(bursts).toHaveLength(1);
    expect(bursts[0]!.symbols).toEqual(['x', 'y']);
  });

  it('returns nothing for an empty stream (and says so in stats, not by throwing)', () => {
    expect(segmentBursts([], { gapMs: 1_000 })).toEqual([]);
    const res = minePatterns([]);
    expect(res.patterns).toEqual([]);
    expect(res.stats.events).toBe(0);
  });
});

describe('minePatterns — cohort breadth is a gate, not a preference', () => {
  it('rejects a pattern one cohort repeats endlessly (a personal habit)', () => {
    // 40 repetitions by ONE cohort: unbeatable on frequency, worthless as a
    // shared pattern. This is the case a pure frequency miner gets wrong.
    const bursts = [burst('solo', Array.from({ length: 40 }, () => ['a', 'b']).flat())];
    const res = minePatterns(bursts, { minCohorts: 2, minOccurrences: 3, minLift: 0 });
    expect(res.patterns).toEqual([]);
    expect(res.stats.rejected.cohorts).toBeGreaterThan(0);
  });

  it('accepts the same pattern once a second cohort performs it', () => {
    const bursts = [
      burst('one', ['a', 'b', 'c']),
      burst('two', ['a', 'b', 'c']),
      burst('three', ['a', 'b', 'c']),
    ];
    const res = minePatterns(bursts, { minCohorts: 2, minOccurrences: 3, minLift: 0 });
    const abc = res.patterns.find((p) => p.symbols.join(' ') === 'a b c');
    expect(abc).toBeDefined();
    expect(abc!.cohorts).toBe(3);
    expect(abc!.cohortSample).toEqual(['one', 'three', 'two']);
  });
});

describe('minePatterns — lift demotes ambient sequences', () => {
  /**
   * The corpus this whole design exists for: an ambient pair (`beat`,`poll`)
   * emitted constantly by every cohort, and a genuine 3-step dance performed by
   * several cohorts a handful of times. The ambient pair WINS on raw frequency
   * by a wide margin.
   */
  const ambientCorpus = (): Burst[] => {
    const bursts: Burst[] = [];
    // Ambient emitters interleave in ARBITRARY order, not a fixed cycle. That
    // distinction is load-bearing: a perfectly alternating `beat,poll,beat,poll`
    // is genuinely twice as predictable as independence and legitimately scores
    // lift ~2, so a periodic fixture would manufacture the very signal this
    // module uses to reject ambient traffic — and the test would then pass for
    // the wrong reason. A deterministic LCG (no Math.random, so the suite stays
    // reproducible) reproduces the shape measured on real telemetry: lift ~1.
    const AMBIENT = ['beat', 'poll', 'probe'];
    let seed = 12345;
    const nextAmbient = (): string => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return AMBIENT[seed % AMBIENT.length]!;
    };
    for (const cohort of ['c1', 'c2', 'c3', 'c4', 'c5']) {
      bursts.push(burst(cohort, Array.from({ length: 60 }, nextAmbient)));
    }
    for (const cohort of ['c1', 'c2', 'c3', 'c4']) {
      bursts.push(burst(cohort, ['survey', 'capacity', 'assign']));
    }
    return bursts;
  };

  /**
   * CONTROL — a deliberately naive miner that ranks by raw occurrences, the
   * implementation this module exists to be better than. It is kept here
   * permanently: if it ever agrees with the real ranking on this corpus, the
   * lift leg has stopped doing work and the real test below is passing
   * vacuously.
   */
  function rankByFrequency(bursts: readonly Burst[], len: number): string[] {
    const counts = new Map<string, number>();
    for (const b of bursts) {
      for (let i = 0; i + len <= b.symbols.length; i++) {
        const k = b.symbols.slice(i, i + len).join(' ');
        counts.set(k, (counts.get(k) ?? 0) + 1);
      }
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
  }

  it('CONTROL: a frequency ranker puts the ambient sequence first (the failure mode)', () => {
    const top = rankByFrequency(ambientCorpus(), 2)[0]!;
    expect(['beat poll', 'poll beat']).toContain(top);
  });

  it('the real miner ranks the genuine dance above the ambient sequence', () => {
    const res = minePatterns(ambientCorpus(), {
      minLength: 2,
      maxLength: 3,
      minOccurrences: 3,
      minCohorts: 2,
      minLift: 2,
    });
    const keys = res.patterns.map((p) => p.symbols.join(' '));
    expect(keys[0]).toBe('survey capacity assign');
    // The ambient pair is not merely ranked lower — it is excluded outright.
    expect(keys).not.toContain('beat poll');
    expect(keys).not.toContain('poll beat');
    expect(res.stats.rejected.lift).toBeGreaterThan(0);
  });

  it('an ambient sequence scores lift ~1 — the property the threshold rests on', () => {
    const res = minePatterns(ambientCorpus(), {
      minLength: 2,
      maxLength: 2,
      minOccurrences: 3,
      minCohorts: 2,
      minLift: 0, // let everything through so the SCORE itself can be asserted
    });
    const ambient = res.patterns.find((p) => p.symbols.join(' ') === 'beat poll')!;
    expect(ambient).toBeDefined();
    // The whole design rests on this number sitting at ~1 — assert a tight band,
    // not merely "below the threshold", so a drift in the null model is caught.
    expect(ambient.lift).toBeGreaterThan(0.6);
    expect(ambient.lift).toBeLessThan(1.6);

    const genuine = res.patterns.find((p) => p.symbols.join(' ') === 'survey capacity')!;
    expect(genuine.lift).toBeGreaterThan(ambient.lift * 10);
  });

  it('CALIBRATION: with the lift floor removed the ambient sequence comes back', () => {
    // Guards the control above: proves the exclusion is caused by minLift and
    // not by some unrelated floor that would exclude it anyway.
    const res = minePatterns(ambientCorpus(), {
      minLength: 2,
      maxLength: 2,
      minOccurrences: 3,
      minCohorts: 2,
      minLift: 0,
    });
    expect(res.patterns.map((p) => p.symbols.join(' '))).toContain('beat poll');
  });
});

describe('minePatterns — support and cohort floors are applied BEFORE lift ranking', () => {
  it('a single run of rare symbols does not top the list on unbounded lift', () => {
    // Rare symbols give astronomical lift; only the floors keep this out. If the
    // ordering were lift-first-then-filter, this one-off would rank first.
    const bursts: Burst[] = [
      burst('c1', ['rare1', 'rare2', 'rare3']), // once, one cohort
    ];
    for (const cohort of ['c1', 'c2', 'c3']) {
      bursts.push(burst(cohort, ['a', 'b', 'c']));
      bursts.push(burst(cohort, ['a', 'b', 'c']));
    }
    const res = minePatterns(bursts, { minOccurrences: 3, minCohorts: 2, minLift: 2 });
    const keys = res.patterns.map((p) => p.symbols.join(' '));
    expect(keys).not.toContain('rare1 rare2 rare3');
    expect(keys[0]).toBe('a b c');
  });
});

describe('minePatterns — strength makes lengths comparable', () => {
  /**
   * Found by running the miner on live data: raw lift multiplies one marginal
   * per symbol, so it compounds with length and a 5-symbol pattern scored 4.7e11
   * against 2.4e5 for a 3-symbol pattern that was the better finding. Sorting on
   * raw lift therefore returns the LONGEST patterns wearing the disguise of the
   * most interesting ones.
   */
  const mixedLengthCorpus = (): Burst[] => {
    const bursts: Burst[] = [];
    // A tight, highly-surprising 2-step dance performed by many cohorts.
    for (const c of ['c1', 'c2', 'c3', 'c4', 'c5', 'c6']) bursts.push(burst(c, ['tight', 'pair']));
    // A long but LOOSE run built from symbols that are everywhere anyway.
    for (const c of ['c1', 'c2', 'c3']) {
      bursts.push(burst(c, ['w', 'x', 'y', 'z', 'w', 'x', 'y', 'z', 'w', 'x', 'y', 'z']));
    }
    return bursts;
  };

  it('CONTROL: ranking by RAW lift puts the long loose run first', () => {
    const res = minePatterns(mixedLengthCorpus(), {
      minLength: 2,
      maxLength: 5,
      minOccurrences: 3,
      minCohorts: 2,
      minLift: 0,
      maximalOnly: false,
    });
    const byRawLift = [...res.patterns].sort((a, b) => b.lift - a.lift);
    expect(byRawLift[0]!.symbols.length).toBeGreaterThan(2);
  });

  it('the real ranking puts the tight pair first', () => {
    const res = minePatterns(mixedLengthCorpus(), {
      minLength: 2,
      maxLength: 5,
      minOccurrences: 3,
      minCohorts: 2,
      minLift: 0,
      maximalOnly: false,
    });
    expect(res.patterns[0]!.symbols.join(' ')).toBe('tight pair');
  });

  it('strength is the mean per-transition log10 lift, and 0 below length 2', () => {
    expect(strengthOf(100, 3)).toBeCloseTo(1, 6); // log10(100)=2, over 2 transitions
    expect(strengthOf(1000, 4)).toBeCloseTo(1, 6); // log10(1000)=3, over 3 transitions
    expect(strengthOf(1, 2)).toBe(0); // lift 1 ⇒ no surprise at all
    expect(strengthOf(1e9, 1)).toBe(0); // asserts no adjacency
    expect(strengthOf(Infinity, 3)).toBe(0); // degenerate, never ranks first
  });

  it('a longer pattern still wins when it is genuinely more surprising per step', () => {
    // Guards against over-correcting: normalization must not simply invert the
    // bias and always prefer short patterns.
    const bursts: Burst[] = [];
    for (const c of ['c1', 'c2', 'c3', 'c4']) bursts.push(burst(c, ['a', 'b', 'c', 'd']));
    for (const c of ['c1', 'c2', 'c3', 'c4']) bursts.push(burst(c, ['a', 'q']));
    for (const c of ['c1', 'c2', 'c3', 'c4']) bursts.push(burst(c, ['a', 'r']));
    const res = minePatterns(bursts, {
      minLength: 2,
      maxLength: 4,
      minOccurrences: 3,
      minCohorts: 2,
      minLift: 0,
      maximalOnly: false,
    });
    const strengthOfKey = (k: string) =>
      res.patterns.find((p) => p.symbols.join(' ') === k)!.strength;
    // The LONGER `a b c d` outranks the shorter `a b` it contains, because its
    // extra transitions are reliable — normalization must not simply invert the
    // old bias into a preference for short patterns.
    expect(strengthOfKey('a b c d')).toBeGreaterThan(strengthOfKey('a b'));

    // But `b c d` outranks `a b c d`, and that is CORRECT rather than a defect:
    // `a` heads three different continuations here, so the a→b step is weakly
    // predictive and drags the mean down. Ranking the tail above the whole is
    // exactly what "how surprising is each step" should say — and it is the
    // behaviour a raw-lift ranking (which scores `a b c d` highest at 1365)
    // cannot express.
    expect(strengthOfKey('b c d')).toBeGreaterThan(strengthOfKey('a b c d'));
  });
});

describe('minePatterns — maximality', () => {
  it('reports the long pattern, not its four overlapping prefixes', () => {
    const bursts = ['c1', 'c2', 'c3'].map((c) => burst(c, ['a', 'b', 'c', 'd']));
    const res = minePatterns(bursts, {
      minLength: 2,
      maxLength: 4,
      minOccurrences: 3,
      minCohorts: 2,
      minLift: 0,
      maximalOnly: true,
    });
    expect(res.patterns.map((p) => p.symbols.join(' '))).toEqual(['a b c d']);
    expect(res.stats.rejected.subsumed).toBeGreaterThan(0);
  });

  it('KEEPS a shorter pattern that occurs meaningfully more often than its extension', () => {
    // `a b` occurs in every burst; `a b c` only in some. The short one carries
    // evidence the long one does not, so suppressing it would lose a finding.
    const bursts: Burst[] = [];
    for (const c of ['c1', 'c2', 'c3']) bursts.push(burst(c, ['a', 'b', 'c']));
    for (const c of ['c1', 'c2', 'c3', 'c4']) bursts.push(burst(c, ['a', 'b', 'z']));
    for (const c of ['c1', 'c2', 'c3', 'c4']) bursts.push(burst(c, ['a', 'b', 'q']));
    const res = minePatterns(bursts, {
      minLength: 2,
      maxLength: 3,
      minOccurrences: 3,
      minCohorts: 2,
      minLift: 0,
      maximalOnly: true,
    });
    const keys = res.patterns.map((p) => p.symbols.join(' '));
    expect(keys).toContain('a b');
  });

  it('maximalOnly:false keeps every sub-pattern (the knob is real)', () => {
    const bursts = ['c1', 'c2', 'c3'].map((c) => burst(c, ['a', 'b', 'c', 'd']));
    const res = minePatterns(bursts, {
      minLength: 2,
      maxLength: 4,
      minOccurrences: 3,
      minCohorts: 2,
      minLift: 0,
      maximalOnly: false,
    });
    const keys = res.patterns.map((p) => p.symbols.join(' '));
    expect(keys).toContain('a b');
    expect(keys).toContain('a b c');
    expect(keys).toContain('a b c d');
  });
});

describe('minePatterns — repeated symbols', () => {
  it('preserves a repeated call by default (it is a finding, not noise)', () => {
    // `capture capture capture` says the operation wants to accept a batch.
    const bursts = ['c1', 'c2', 'c3'].map((c) => burst(c, ['capture', 'capture', 'capture', 'wake']));
    const res = minePatterns(bursts, {
      minLength: 2,
      maxLength: 4,
      minOccurrences: 3,
      minCohorts: 2,
      minLift: 0,
    });
    const keys = res.patterns.map((p) => p.symbols.join(' '));
    expect(keys.some((k) => k.includes('capture capture'))).toBe(true);
  });

  it('collapseRuns:true erases it (opt-in, and the reason it is not the default)', () => {
    const bursts = ['c1', 'c2', 'c3'].map((c) => burst(c, ['capture', 'capture', 'capture', 'wake']));
    const res = minePatterns(bursts, {
      minLength: 2,
      maxLength: 4,
      minOccurrences: 3,
      minCohorts: 2,
      minLift: 0,
      collapseRuns: true,
    });
    const keys = res.patterns.map((p) => p.symbols.join(' '));
    expect(keys.some((k) => k.includes('capture capture'))).toBe(false);
    expect(keys).toContain('capture wake');
  });
});

describe('minePatterns — determinism and reporting', () => {
  it('is order-independent in its output for shuffled input bursts', () => {
    const mk = (): Burst[] => [
      burst('c1', ['a', 'b', 'c']),
      burst('c2', ['a', 'b', 'c']),
      burst('c3', ['x', 'y', 'z']),
      burst('c4', ['x', 'y', 'z']),
    ];
    const a = minePatterns(mk(), { minOccurrences: 2, minCohorts: 2, minLift: 0 });
    const b = minePatterns([...mk()].reverse(), { minOccurrences: 2, minCohorts: 2, minLift: 0 });
    expect(a.patterns.map((p) => p.symbols.join(' '))).toEqual(b.patterns.map((p) => p.symbols.join(' ')));
  });

  it('reports a rejection census so a mis-tuned floor is visible, not silent', () => {
    const bursts = [burst('solo', ['a', 'b', 'a', 'b', 'a', 'b'])];
    const res = minePatterns(bursts, { minCohorts: 5, minOccurrences: 1, minLift: 0 });
    expect(res.patterns).toEqual([]);
    expect(res.stats.candidatesConsidered).toBeGreaterThan(0);
    expect(res.stats.rejected.cohorts).toBeGreaterThan(0);
    expect(res.stats.bursts).toBe(1);
    expect(res.stats.cohorts).toBe(1);
  });

  it('distinguishes "no data" from "no patterns" via stats', () => {
    const empty = minePatterns([]);
    expect(empty.stats.candidatesConsidered).toBe(0);
    const noPatterns = minePatterns([burst('c1', ['a', 'b'])], { minCohorts: 9 });
    expect(noPatterns.stats.candidatesConsidered).toBeGreaterThan(0);
  });
});

describe('containsRun', () => {
  it('matches only CONTIGUOUS runs', () => {
    expect(containsRun(['a', 'b', 'c', 'd'], ['b', 'c'])).toBe(true);
    expect(containsRun(['a', 'b', 'c', 'd'], ['a', 'c'])).toBe(false);
    expect(containsRun(['a', 'b'], ['a', 'b', 'c'])).toBe(false);
    expect(containsRun(['a', 'b', 'a', 'b'], ['b', 'a'])).toBe(true);
  });
});

describe('minePatternsFromEvents', () => {
  it('segments then mines, and the gap genuinely changes the result', () => {
    const events: SequenceEvent[] = [];
    for (const c of ['c1', 'c2', 'c3']) {
      events.push(ev(c, 'a', 0), ev(c, 'b', 100));
      // A long idle gap: `b → a` across it is not a real adjacency.
      events.push(ev(c, 'a', 3_600_000), ev(c, 'b', 3_600_100));
    }
    const tight = minePatternsFromEvents(events, { gapMs: 1_000 }, {
      minOccurrences: 3,
      minCohorts: 2,
      minLift: 0,
      maxLength: 2,
    });
    expect(tight.patterns.map((p) => p.symbols.join(' '))).not.toContain('b a');

    const loose = minePatternsFromEvents(events, { gapMs: 7_200_000 }, {
      minOccurrences: 3,
      minCohorts: 2,
      minLift: 0,
      maxLength: 2,
    });
    expect(loose.patterns.map((p) => p.symbols.join(' '))).toContain('b a');
  });
});
