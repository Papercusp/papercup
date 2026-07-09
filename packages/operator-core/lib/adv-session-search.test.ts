/**
 * adv-session-search — pure grouping/classification for the agents-pill
 * transcript search (agents-pill-inactive-search-2026-07-09 P-002/P-006).
 */
import { describe, expect, it } from 'vitest';
import {
  classifySessionGroups,
  groupHitsBySession,
  matchActiveEntry,
  matchSessionRow,
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
