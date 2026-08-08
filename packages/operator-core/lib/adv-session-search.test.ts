/**
 * adv-session-search — pure grouping/classification for the agents-pill
 * transcript search (agents-pill-inactive-search-2026-07-09 P-002/P-006).
 */
import { describe, expect, it } from 'vitest';
import {
  buildActiveEntryMatchFilter,
  classifySessionGroups,
  DEFAULT_FRESH_WINDOW_H,
  DEFAULT_HALF_LIFE_H,
  DEFAULT_WEIGHT,
  groupHitsBySession,
  matchActiveEntry,
  matchSessionRow,
  parseRecencyParams,
  type TranscriptTurnHit,
} from './adv-session-search';
import type { RosterEntry } from './adv-roster';
import type { AdvSessionRow } from './adv-sessions';

function hit(over: Partial<TranscriptTurnHit> = {}): TranscriptTurnHit {
  return {
    sourceKind: 'claude',
    sessionId: 'sid-1',
    turnIdx: 0,
    excerpt: 'ex',
    highlight: 'ex',
    score: 1,
    ...over,
  };
}

const roster = (over: Record<string, unknown>) => over as unknown as RosterEntry;
const advRow = (over: Record<string, unknown>) => over as unknown as AdvSessionRow;

describe('groupHitsBySession', () => {
  it('groups per (sourceKind, sessionId), preserving the caller order', () => {
    const groups = groupHitsBySession([
      hit({ sessionId: 'a', score: 1 }),
      hit({ sessionId: 'b', score: 9 }),
      hit({ sessionId: 'a', score: 5 }),
      hit({ sourceKind: 'omp', sessionId: 'a', score: 3 }), // distinct kind ⇒ own group
    ]);
    // Order of FIRST APPEARANCE, not of score — claude:a leads despite scoring
    // below claude:b, because the caller ranked it first.
    expect(groups.map((g) => `${g.sourceKind}:${g.sessionId}`)).toEqual(['claude:a', 'claude:b', 'omp:a']);
    // topScore still measures the group's best RETRIEVAL score (all hits, incl.
    // any the per-session cap dropped) — it just no longer implies a position.
    expect(groups[0].topScore).toBe(5);
  });

  it('keeps the caller order within a group and caps at maxHitsPerSession', () => {
    const groups = groupHitsBySession(
      [1, 4, 2, 5, 3].map((score, i) => hit({ score, turnIdx: i })),
      3,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].hits.map((h) => h.score)).toEqual([1, 4, 2]);
    // The dropped hits still count toward topScore.
    expect(groups[0].topScore).toBe(5);
  });

  /**
   * P-010 CALIBRATION — the order-preservation above is a REFACTOR, not a
   * behaviour change, for every input the engine actually produces.
   *
   * `runHybridSearch` returns its page score-desc, so the score sort this
   * replaced could only ever reproduce the order it was handed. This asserts
   * that equivalence directly: for score-desc input, preserving order and
   * sorting by score agree. Without it the two tests above look like a silent
   * ranking regression rather than the no-op they are.
   */
  it('is IDENTICAL to a score sort for score-desc input (the engine contract)', () => {
    const scoreDesc = [
      hit({ sessionId: 'b', score: 9 }),
      hit({ sessionId: 'a', score: 5 }),
      hit({ sourceKind: 'omp', sessionId: 'a', score: 3 }),
      hit({ sessionId: 'a', score: 1 }),
    ];
    const groups = groupHitsBySession(scoreDesc);
    expect(groups.map((g) => `${g.sourceKind}:${g.sessionId}`)).toEqual(['claude:b', 'claude:a', 'omp:a']);
    expect(groups.map((g) => g.topScore)).toEqual([9, 5, 3]);
    // Groups come out topScore-desc for free — derived, not sorted for.
    expect(groups.map((g) => g.topScore)).toEqual([...groups.map((g) => g.topScore)].sort((x, y) => y - x));
    expect(groups[1].hits.map((h) => h.score)).toEqual([5, 1]);
  });

  /**
   * The defect this whole change exists to prevent: a Stage-B rerank returns
   * hits in cross-encoder order while carrying the RETRIEVAL score through
   * untouched. Re-sorting on that score would un-do the rerank completely and
   * leave no symptom — the reranker runs, costs its latency, and the response
   * is byte-identical to not having reranked.
   */
  it('does NOT re-sort a reranked page back into retrieval order', () => {
    // Reranker promoted the score-0.1 turn to the top of the page.
    const reranked = [
      hit({ sessionId: 'promoted', score: 0.1 }),
      hit({ sessionId: 'demoted', score: 0.9 }),
    ];
    expect(groupHitsBySession(reranked).map((g) => g.sessionId)).toEqual(['promoted', 'demoted']);
  });
});

describe('matchActiveEntry', () => {
  const active = [
    roster({ ownerId: 'su-aaa', sessionId: 'claude-sid', ompThreadId: null }),
    roster({ ownerId: 'su-bbb', sessionId: null, ompThreadId: 'omp-tid' }),
  ];

  it('matches a claude group by session uuid', () => {
    const g = { sourceKind: 'claude', sessionId: 'claude-sid', hits: [hit()] };
    expect(matchActiveEntry(g, active)).toBe(active[0]);
  });

  it('matches an omp group by thread id', () => {
    const g = { sourceKind: 'omp', sessionId: 'omp-tid', hits: [hit({ sourceKind: 'omp' })] };
    expect(matchActiveEntry(g, active)).toBe(active[1]);
  });

  it('falls back to the hit owner ↔ roster ownerId', () => {
    const g = { sourceKind: 'claude', sessionId: 'other-sid', hits: [hit({ owner: 'su-bbb' })] };
    expect(matchActiveEntry(g, active)).toBe(active[1]);
  });

  it('returns null when nothing matches', () => {
    const g = { sourceKind: 'codex', sessionId: 'nope', hits: [hit({ sourceKind: 'codex' })] };
    expect(matchActiveEntry(g, active)).toBeNull();
  });
});

describe('buildActiveEntryMatchFilter (WI-3924)', () => {
  // Equivalence check: for EVERY entry in `active` and EVERY group, the
  // filter must accept an entry iff matchActiveEntry would select it for
  // SOME group in the set — this is the property the mergeRosterWithAssignments
  // thinkingFor gate relies on for correctness (a filtered-out entry must be
  // one no group could ever match).
  const active = [
    roster({ ownerId: 'su-aaa', sessionId: 'claude-sid', ompThreadId: null }),
    roster({ ownerId: 'su-bbb', sessionId: null, ompThreadId: 'omp-tid' }),
    roster({ ownerId: 'su-ccc', sessionId: 'other-sid', ompThreadId: null }),
    roster({ ownerId: 'su-ddd', sessionId: null, ompThreadId: null }),
  ];

  function assertEquivalent(groups: Array<{ sourceKind: string; sessionId: string; hits: TranscriptTurnHit[] }>) {
    const filter = buildActiveEntryMatchFilter(groups);
    for (const entry of active) {
      const matchedBySomeGroup = groups.some((g) => matchActiveEntry(g, [entry]) !== null);
      expect(filter(entry)).toBe(matchedBySomeGroup);
    }
  }

  it('matches by claude session uuid, same as matchActiveEntry', () => {
    assertEquivalent([{ sourceKind: 'claude', sessionId: 'claude-sid', hits: [hit()] }]);
  });

  it('matches by omp thread id, same as matchActiveEntry', () => {
    assertEquivalent([{ sourceKind: 'omp', sessionId: 'omp-tid', hits: [hit({ sourceKind: 'omp' })] }]);
  });

  it('matches via the owner fallback, same as matchActiveEntry (any sourceKind)', () => {
    assertEquivalent([{ sourceKind: 'claude', sessionId: 'unrelated-sid', hits: [hit({ owner: 'su-ccc' })] }]);
  });

  it('excludes an entry no group could match', () => {
    const filter = buildActiveEntryMatchFilter([{ sourceKind: 'claude', sessionId: 'claude-sid', hits: [hit()] }]);
    expect(filter(active[3])).toBe(false); // su-ddd: no sessionId/ompThreadId/owner hit
  });

  it('holds across a mixed multi-group set', () => {
    assertEquivalent([
      { sourceKind: 'claude', sessionId: 'claude-sid', hits: [hit()] },
      { sourceKind: 'omp', sessionId: 'omp-tid', hits: [hit({ sourceKind: 'omp' })] },
      { sourceKind: 'codex', sessionId: 'nope', hits: [hit({ sourceKind: 'codex', owner: 'su-ccc' })] },
    ]);
  });

  it('returns false for every entry when there are no groups', () => {
    const filter = buildActiveEntryMatchFilter([]);
    for (const entry of active) expect(filter(entry)).toBe(false);
  });
});

describe('matchSessionRow', () => {
  const rows = [
    advRow({ id: 1, sessionId: 'claude-sid', ompThreadId: null }),
    advRow({ id: 2, sessionId: null, ompThreadId: 'omp-tid' }),
    advRow({ id: 3, sessionId: 'claude-sid', ompThreadId: null }), // older duplicate
  ];

  it('matches claude by sessionId (first/newest row wins) and omp by thread id', () => {
    expect(matchSessionRow({ sourceKind: 'claude', sessionId: 'claude-sid' }, rows)).toBe(rows[0]);
    expect(matchSessionRow({ sourceKind: 'omp', sessionId: 'omp-tid' }, rows)).toBe(rows[1]);
    expect(matchSessionRow({ sourceKind: 'codex', sessionId: 'claude-sid' }, rows)).toBeNull();
  });
});

describe('classifySessionGroups', () => {
  it('sorts active sessions first, score-desc within each band', () => {
    const active = [roster({ ownerId: 'su-live', sessionId: 'live-sid', ompThreadId: null })];
    const groups = [
      { sourceKind: 'claude', sessionId: 'dead-hi', topScore: 9, hits: [hit()] },
      { sourceKind: 'claude', sessionId: 'live-sid', topScore: 2, hits: [hit()] },
      { sourceKind: 'claude', sessionId: 'dead-lo', topScore: 5, hits: [hit()] },
    ];
    const out = classifySessionGroups(groups, active, [advRow({ id: 7, sessionId: 'dead-hi', ompThreadId: null })]);
    expect(out.map((c) => c.sessionId)).toEqual(['live-sid', 'dead-hi', 'dead-lo']);
    expect(out[0].active).toBe(active[0]);
    expect(out[1].session).not.toBeNull();
    expect(out[2].active).toBeNull();
    expect(out[2].session).toBeNull();
  });

  /**
   * P-010: the active-first partition must not re-derive within-band order from
   * `topScore` — that was the LAST place a Stage-B rerank could be discarded,
   * after groupHitsBySession started preserving it.
   */
  it('preserves the caller order within each band (does not re-sort on topScore)', () => {
    const active = [
      roster({ ownerId: 'su-1', sessionId: 'live-lo', ompThreadId: null }),
      roster({ ownerId: 'su-2', sessionId: 'live-hi', ompThreadId: null }),
    ];
    const groups = [
      { sourceKind: 'claude', sessionId: 'dead-lo', topScore: 0.1, hits: [hit()] },
      { sourceKind: 'claude', sessionId: 'live-lo', topScore: 0.2, hits: [hit()] },
      { sourceKind: 'claude', sessionId: 'dead-hi', topScore: 9, hits: [hit()] },
      { sourceKind: 'claude', sessionId: 'live-hi', topScore: 8, hits: [hit()] },
    ];
    const out = classifySessionGroups(groups, active, []);
    // Actives first in ARRIVAL order (live-lo before live-hi despite 0.2 < 8),
    // then inactives in arrival order (dead-lo before dead-hi).
    expect(out.map((c) => c.sessionId)).toEqual(['live-lo', 'live-hi', 'dead-lo', 'dead-hi']);
  });
});

describe('parseRecencyParams (WI-5097)', () => {
  const parse = (qs: string) => parseRecencyParams(new URLSearchParams(qs));

  const DEFAULTS = {
    halfLifeMs: DEFAULT_HALF_LIFE_H * 3_600_000,
    weight: DEFAULT_WEIGHT,
    freshWindowMs: DEFAULT_FRESH_WINDOW_H * 3_600_000,
  };

  it('ABSENT params → the documented defaults', () => {
    // THE WI-5097 regression: `Number(null)` is 0, so the old inline parse
    // read an absent recencyWeight as an explicit 0 and silently disabled
    // the default-ON recency re-rank for every normal search.
    expect(parse('q=inbox')).toEqual(DEFAULTS);
  });

  it('P-003: the defaults are 7d half-life, weight 0.5, 48h fresh window', () => {
    // Pinned by VALUE as well as by constant, so a future edit to the
    // constants has to come here and state its case. Each was reasoned in the
    // docblocks on adv-session-search.ts:
    //  - 7d, because at 24h a 3-day-old turn kept 12.5% of its recency credit
    //    and the blend degenerated to "today vs everything else";
    //  - 0.5, because P-002 made `weight` a true mixing fraction and 0.3 under
    //    the OLD compressed-relevance blend was already ~the parity point, so
    //    0.5 preserves the effective ranking rather than changing it;
    //  - 48h ABSOLUTE, because the old `2 × halfLife` formula would silently
    //    have redefined "fresh" as a fortnight once the half-life moved to 7d.
    expect(DEFAULT_HALF_LIFE_H).toBe(168);
    expect(DEFAULT_WEIGHT).toBe(0.5);
    expect(DEFAULT_FRESH_WINDOW_H).toBe(48);
  });

  it('P-003: the fresh window no longer tracks the half-life', () => {
    // The regression this decoupling exists to prevent: an explicit long
    // half-life must NOT widen pool admission with it.
    expect(parse('q=x&recencyHalfLifeH=720')).toMatchObject({
      halfLifeMs: 720 * 3_600_000,
      freshWindowMs: DEFAULT_FRESH_WINDOW_H * 3_600_000,
    });
  });

  it('blank values behave like absent ones (never an accidental 0)', () => {
    expect(parse('q=x&recencyWeight=&recencyHalfLifeH=&recencyFreshWindowH=')).toEqual(DEFAULTS);
  });

  it('recency=off → undefined (re-rank disabled entirely)', () => {
    expect(parse('q=x&recency=off')).toBeUndefined();
  });

  it('EXPLICIT values are honored — including weight 0 and freshWindow 0', () => {
    expect(parse('q=x&recencyWeight=0')).toMatchObject({ weight: 0 });
    expect(parse('q=x&recencyWeight=0.7')).toMatchObject({ weight: 0.7 });
    expect(parse('q=x&recencyHalfLifeH=6')).toMatchObject({
      halfLifeMs: 6 * 3_600_000,
      freshWindowMs: DEFAULT_FRESH_WINDOW_H * 3_600_000, // P-003: no longer 2×half-life
    });
    expect(parse('q=x&recencyFreshWindowH=0')).toMatchObject({ freshWindowMs: 0 });
    expect(parse('q=x&recencyFreshWindowH=72')).toMatchObject({ freshWindowMs: 72 * 3_600_000 });
  });

  it('out-of-range / garbage values fall back to defaults', () => {
    expect(parse('q=x&recencyWeight=2')).toMatchObject({ weight: DEFAULT_WEIGHT });
    expect(parse('q=x&recencyWeight=-1')).toMatchObject({ weight: DEFAULT_WEIGHT });
    expect(parse('q=x&recencyWeight=abc')).toMatchObject({ weight: DEFAULT_WEIGHT });
    expect(parse('q=x&recencyHalfLifeH=0')).toMatchObject({
      halfLifeMs: DEFAULT_HALF_LIFE_H * 3_600_000,
    });
    expect(parse('q=x&recencyHalfLifeH=-5')).toMatchObject({
      halfLifeMs: DEFAULT_HALF_LIFE_H * 3_600_000,
    });
    expect(parse('q=x&recencyFreshWindowH=-1')).toMatchObject({
      freshWindowMs: DEFAULT_FRESH_WINDOW_H * 3_600_000,
    });
  });
});
