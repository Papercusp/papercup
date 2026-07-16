/**
 * adv-session-search — pure grouping/classification for the agents-pill
 * transcript search (agents-pill-inactive-search-2026-07-09 P-002/P-006).
 */
import { describe, expect, it } from 'vitest';
import {
  buildActiveEntryMatchFilter,
  classifySessionGroups,
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
  it('groups per (sourceKind, sessionId), orders groups by best score', () => {
    const groups = groupHitsBySession([
      hit({ sessionId: 'a', score: 1 }),
      hit({ sessionId: 'b', score: 9 }),
      hit({ sessionId: 'a', score: 5 }),
      hit({ sourceKind: 'omp', sessionId: 'a', score: 3 }), // distinct kind ⇒ own group
    ]);
    expect(groups.map((g) => `${g.sourceKind}:${g.sessionId}`)).toEqual(['claude:b', 'claude:a', 'omp:a']);
    expect(groups[1].topScore).toBe(5);
  });

  it('sorts hits within a group score-desc and caps at maxHitsPerSession', () => {
    const groups = groupHitsBySession(
      [1, 4, 2, 5, 3].map((score, i) => hit({ score, turnIdx: i })),
      3,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].hits.map((h) => h.score)).toEqual([5, 4, 3]);
    expect(groups[0].topScore).toBe(5);
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
});

describe('parseRecencyParams (WI-5097)', () => {
  const parse = (qs: string) => parseRecencyParams(new URLSearchParams(qs));

  it('ABSENT params → the documented defaults (24h half-life, weight 0.3, fresh window 2×half-life)', () => {
    // THE WI-5097 regression: `Number(null)` is 0, so the old inline parse
    // read an absent recencyWeight as an explicit 0 and silently disabled
    // the default-ON recency re-rank for every normal search.
    expect(parse('q=inbox')).toEqual({
      halfLifeMs: 24 * 3_600_000,
      weight: 0.3,
      freshWindowMs: 48 * 3_600_000,
    });
  });

  it('blank values behave like absent ones (never an accidental 0)', () => {
    expect(parse('q=x&recencyWeight=&recencyHalfLifeH=&recencyFreshWindowH=')).toEqual({
      halfLifeMs: 24 * 3_600_000,
      weight: 0.3,
      freshWindowMs: 48 * 3_600_000,
    });
  });

  it('recency=off → undefined (re-rank disabled entirely)', () => {
    expect(parse('q=x&recency=off')).toBeUndefined();
  });

  it('EXPLICIT values are honored — including weight 0 and freshWindow 0', () => {
    expect(parse('q=x&recencyWeight=0')).toMatchObject({ weight: 0 });
    expect(parse('q=x&recencyWeight=0.7')).toMatchObject({ weight: 0.7 });
    expect(parse('q=x&recencyHalfLifeH=6')).toMatchObject({
      halfLifeMs: 6 * 3_600_000,
      freshWindowMs: 12 * 3_600_000, // fresh default tracks the half-life
    });
    expect(parse('q=x&recencyFreshWindowH=0')).toMatchObject({ freshWindowMs: 0 });
    expect(parse('q=x&recencyFreshWindowH=72')).toMatchObject({ freshWindowMs: 72 * 3_600_000 });
  });

  it('out-of-range / garbage values fall back to defaults', () => {
    expect(parse('q=x&recencyWeight=2')).toMatchObject({ weight: 0.3 });
    expect(parse('q=x&recencyWeight=-1')).toMatchObject({ weight: 0.3 });
    expect(parse('q=x&recencyWeight=abc')).toMatchObject({ weight: 0.3 });
    expect(parse('q=x&recencyHalfLifeH=0')).toMatchObject({ halfLifeMs: 24 * 3_600_000 });
    expect(parse('q=x&recencyHalfLifeH=-5')).toMatchObject({ halfLifeMs: 24 * 3_600_000 });
    expect(parse('q=x&recencyFreshWindowH=-1')).toMatchObject({ freshWindowMs: 48 * 3_600_000 });
  });
});
