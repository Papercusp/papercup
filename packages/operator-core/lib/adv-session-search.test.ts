/**
 * adv-session-search — pure grouping/classification for the agents-pill
 * transcript search (agents-pill-inactive-search-2026-07-09 P-002/P-006).
 */
import { describe, expect, it } from 'vitest';
import {
  buildActiveEntryMatchFilter,
  buildIdMatchResults,
  classifySessionGroups,
  filterOwnerVisibleTurnHits,
  DEFAULT_FRESH_WINDOW_H,
  DEFAULT_HALF_LIFE_H,
  DEFAULT_WEIGHT,
  groupHitsBySession,
  matchActiveEntry,
  matchSessionIdField,
  matchSessionRow,
  mergeIdMatches,
  parseRecencyParams,
  parseSessionIdQuery,
  sessionIdCandidateMatches,
  transcriptIdentity,
  type ClassifiedSessionHits,
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

// ── ID search (WI-37204) ────────────────────────────────────────────────────

describe('parseSessionIdQuery (WI-37204)', () => {
  it('accepts the three id shapes this system hands a human', () => {
    // Full coord owner id, and the SHORT HANDLE the roster/HUD actually render.
    expect(parseSessionIdQuery('su-bc38a419-8dc6-4040-a63e-2dc0515e42be')).toBe(
      'su-bc38a419-8dc6-4040-a63e-2dc0515e42be',
    );
    expect(parseSessionIdQuery('su-bc38a419')).toBe('su-bc38a419');
    // Native claude session uuid + the 8-hex head an ended-session card shows.
    expect(parseSessionIdQuery('073c5a1e-d280-4c37-866c-fedcaf096c9e')).toBe(
      '073c5a1e-d280-4c37-866c-fedcaf096c9e',
    );
    expect(parseSessionIdQuery('073c5a1e')).toBe('073c5a1e');
    // Spawn/presence owner id (fleet-spawn + omp-hook-session rows).
    expect(parseSessionIdQuery('s-1786227863758-271597fd')).toBe('s-1786227863758-271597fd');
  });

  it('lowercases, so a pasted upper-case uuid still resolves', () => {
    expect(parseSessionIdQuery('073C5A1E-D280-4C37-866C-FEDCAF096C9E')).toBe(
      '073c5a1e-d280-4c37-866c-fedcaf096c9e',
    );
  });

  it('rejects prose — an id leg firing on ordinary queries would inject unrelated sessions at the top of every search', () => {
    expect(parseSessionIdQuery('escalation')).toBeNull();
    expect(parseSessionIdQuery('why did the gate go red')).toBeNull();
    // A phrase CONTAINING an id is prose: the human is describing, not addressing.
    expect(parseSessionIdQuery('su-bc38a419 crashed')).toBeNull();
    expect(parseSessionIdQuery('green-checkpoint')).toBeNull();
  });

  it('rejects tokens below the short-handle floor, where hex collides with words', () => {
    // `shortHandle` never renders fewer than 6 hex, so nothing shorter is a
    // handle a human was given — and these are all real English words.
    expect(parseSessionIdQuery('added')).toBeNull();
    expect(parseSessionIdQuery('beef')).toBeNull();
    expect(parseSessionIdQuery('decade')).toBe('decade'); // 6 hex: accepted by shape…
    // …and harmless, because it resolves against ids, not text: nothing starts
    // with it, so the id leg contributes nothing and the text leg still runs.
    expect(buildIdMatchResults('decade', [roster({ ownerId: 'su-bc38a419' })], [])).toEqual([]);
  });
});

describe('sessionIdCandidateMatches / matchSessionIdField (WI-37204)', () => {
  it('matches on PREFIX, never mid-string', () => {
    expect(sessionIdCandidateMatches('su-bc38a419-8dc6-4040', 'su-bc38a419')).toBe(true);
    expect(sessionIdCandidateMatches('su-bc38a419-8dc6-4040', 'su-bc38a419-8dc6-4040')).toBe(true);
    // The TAIL of an id is not a handle anyone is given; matching it would let
    // one uuid pull in unrelated sessions that merely share a run of hex.
    expect(sessionIdCandidateMatches('su-bc38a419-8dc6-4040', '8dc6-4040')).toBe(false);
    expect(sessionIdCandidateMatches(null, 'su-bc38a419')).toBe(false);
    expect(sessionIdCandidateMatches(undefined, 'su-bc38a419')).toBe(false);
  });

  it('names WHICH id matched, and prefers the owner id', () => {
    const e = {
      ownerId: 'su-bc38a419-8dc6',
      sessionId: '073c5a1e-d280',
      ompThreadId: 'omp-77aa11bb',
    };
    expect(matchSessionIdField(e, 'su-bc38a4')).toBe('ownerId');
    expect(matchSessionIdField(e, '073c5a1e')).toBe('sessionId');
    expect(matchSessionIdField(e, 'omp-77aa11')).toBe('ompThreadId');
    expect(matchSessionIdField(e, 'ffffffff')).toBeNull();
  });

  it('reads an adv row’s coordOwnerId as its owner id', () => {
    expect(matchSessionIdField({ coordOwnerId: 'su-bc38a419-8dc6' }, 'su-bc38a419')).toBe('ownerId');
  });
});

describe('transcriptIdentity (WI-37204)', () => {
  it('keys claude by native session id and omp by thread id', () => {
    expect(transcriptIdentity({ ownerId: 'su-a', sessionId: 'sid-1' })).toEqual({
      sourceKind: 'claude',
      sessionId: 'sid-1',
    });
    expect(transcriptIdentity({ ownerId: 'su-a', ompThreadId: 'thr-1' })).toEqual({
      sourceKind: 'omp',
      sessionId: 'thr-1',
    });
  });

  it('falls back to a synthetic key that NAMES the backend rather than claiming claude', () => {
    expect(transcriptIdentity({ ownerId: 'su-a', agent: 'codex' })).toEqual({
      sourceKind: 'codex',
      sessionId: 'su-a',
    });
    expect(transcriptIdentity({ coordOwnerId: null, agent: null, id: 42 })).toEqual({
      sourceKind: 'session',
      sessionId: 'adv-42',
    });
  });
});

describe('buildIdMatchResults (WI-37204)', () => {
  const live = roster({ ownerId: 'su-bc38a419-8dc6', sessionId: 'sid-live' });
  const liveRow = advRow({
    id: 7,
    coordOwnerId: 'su-bc38a419-8dc6',
    sessionId: 'sid-live',
    ompThreadId: null,
  });
  const endedRow = advRow({
    id: 8,
    coordOwnerId: 'su-bc38a419-9999',
    sessionId: 'sid-ended',
    ompThreadId: null,
    endedAt: '2026-08-01T00:00:00Z',
  });

  it('resolves a live agent by its su id, with hits EMPTY and idMatch stamped', () => {
    const out = buildIdMatchResults('su-bc38a419-8dc6', [live], []);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      sourceKind: 'claude',
      sessionId: 'sid-live',
      hits: [],
      idMatch: 'ownerId',
    });
    expect(out[0].active).toBe(live);
  });

  it('resolves an ENDED session by id — the case the live roster can never answer', () => {
    const out = buildIdMatchResults('sid-ended', [], [endedRow]);
    expect(out).toHaveLength(1);
    expect(out[0].active).toBeNull();
    expect(out[0].session).toBe(endedRow);
    expect(out[0].idMatch).toBe('sessionId');
  });

  it('puts live entries first and pairs each with its recorded row', () => {
    const out = buildIdMatchResults('su-bc38a419', [live], [endedRow, liveRow]);
    expect(out.map((r) => r.sessionId)).toEqual(['sid-live', 'sid-ended']);
    expect(out[0].active).toBe(live);
    expect(out[0].session).toBe(liveRow); // paired, not left null
  });

  it('does not emit the same agent twice when its roster entry and its row both match', () => {
    // The exact shape that produces a duplicate if only the transcript key is
    // deduped: the roster entry has not recorded a native session id yet, so it
    // keys synthetically while its row keys as claude.
    const noHandle = roster({ ownerId: 'su-bc38a419-8dc6' });
    const out = buildIdMatchResults('su-bc38a419-8dc6', [noHandle], [liveRow]);
    expect(out).toHaveLength(1);
    expect(out[0].active).toBe(noHandle);
  });

  it('caps the result count so a short prefix cannot flood the popover', () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      roster({ ownerId: `su-abcdef${String(i).padStart(2, '0')}`, sessionId: `sid-${i}` }),
    );
    expect(buildIdMatchResults('su-abcdef', many, [])).toHaveLength(20);
    expect(buildIdMatchResults('su-abcdef', many, [], { limit: 3 })).toHaveLength(3);
  });
});

describe('mergeIdMatches (WI-37204)', () => {
  const res = (over: Partial<ClassifiedSessionHits>): ClassifiedSessionHits => ({
    sourceKind: 'claude',
    sessionId: 'sid',
    topScore: 0,
    hits: [],
    active: null,
    session: null,
    ...over,
  });

  it('is a no-op when the query is not an id', () => {
    const text = [res({ sessionId: 'a' }), res({ sessionId: 'b' })];
    expect(mergeIdMatches([], text)).toEqual(text);
  });

  it('KEEPS the text hits of a session that is also an id match', () => {
    // The reason this merges rather than replaces: ids appear in transcript
    // prose, and those hits are often exactly why someone searched the id.
    const textHits = [hit({ sessionId: 'a', excerpt: 'waking su-bc38a419' })];
    const merged = mergeIdMatches(
      [res({ sessionId: 'a', idMatch: 'ownerId' })],
      [res({ sessionId: 'a', hits: textHits, topScore: 9 })],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0].hits).toBe(textHits);
    expect(merged[0].topScore).toBe(9);
    expect(merged[0].idMatch).toBe('ownerId');
  });

  it('hoists id matches above pure text results, and never duplicates one', () => {
    const merged = mergeIdMatches(
      [res({ sessionId: 'b', idMatch: 'sessionId' })],
      [res({ sessionId: 'a' }), res({ sessionId: 'b' }), res({ sessionId: 'c' })],
    );
    expect(merged.map((r) => r.sessionId)).toEqual(['b', 'a', 'c']);
  });

  it('keys on sourceKind AND sessionId — two backends may share an id string', () => {
    const merged = mergeIdMatches(
      [res({ sourceKind: 'claude', sessionId: 'x', idMatch: 'sessionId' })],
      [res({ sourceKind: 'omp', sessionId: 'x' })],
    );
    expect(merged).toHaveLength(2);
  });
});

/**
 * WI-37883 — the owner-facing search must not offer a hit inside a turn the
 * owner's chat pane hides.
 *
 * EI-20135573616431912 fixed the PANE; this route searched the same rows and
 * leaked the same machine text back as excerpts, plus a deep-link that cannot
 * anchor (the target message is no longer rendered, so SessionChatModal's
 * corroboration rejects it and the pane silently opens at the tail).
 */
describe('filterOwnerVisibleTurnHits', () => {
  const hit = (over: Partial<Parameters<typeof filterOwnerVisibleTurnHits>[0][number]> = {}) => ({
    sourceKind: 'claude',
    sessionId: 's1',
    turnIdx: 1,
    excerpt: 'x',
    highlight: 'x',
    score: 1,
    ...over,
  });

  it('DROPS a machine-authored user turn — the excerpt leak and the dead deep-link', () => {
    const kept = filterOwnerVisibleTurnHits([
      hit({ speaker: 'user', textHead: '⟦turn-origin:loop-fire nonce:095d0a31d74f617e⟧\n🔁 Loop wake' }),
    ]);
    expect(kept).toEqual([]);
  });

  it('KEEPS the owner\'s own turn — both shapes they can arrive in', () => {
    const kept = filterOwnerVisibleTurnHits([
      // Typed in the TUI: no envelope at all.
      hit({ turnIdx: 1, speaker: 'user', textHead: 'why did that agent go on to say all this?' }),
      // Typed in the HUD chat pane: enveloped, but owner-authored.
      hit({ turnIdx: 2, speaker: 'user', textHead: '⟦turn-origin:coord-inject:owner nonce:deadbeefcafe1234⟧\nhi' }),
    ]);
    expect(kept.map((h) => h.turnIdx)).toEqual([1, 2]);
  });

  it('KEEPS every assistant turn without consulting the text at all', () => {
    /* The pane renders assistant turns unconditionally, so their content is
       irrelevant here — including text that would LOOK machine-authored if the
       filter were applied by marker instead of by speaker. An agent quoting a
       wake envelope back in its own answer is ordinary, and hiding it would make
       the agent's own words unsearchable. */
    const kept = filterOwnerVisibleTurnHits([
      hit({ speaker: 'assistant', textHead: '⟦turn-origin:loop-fire nonce:095d0a31d74f617e⟧ — as you can see' }),
    ]);
    expect(kept).toHaveLength(1);
  });

  it('FAILS OPEN when the metadata join gave us nothing', () => {
    /* The route hydrates speaker+textHead in a try/catch that deliberately never
       fails the search. A hit that came back bare must stay in the results: the
       recoverable error is showing one machine row, and the unrecoverable one is
       a search that silently drops the owner's own words because a metadata query
       timed out. */
    expect(filterOwnerVisibleTurnHits([hit({ speaker: 'user' })])).toHaveLength(1);
    expect(filterOwnerVisibleTurnHits([hit({ speaker: 'user', textHead: null })])).toHaveLength(1);
    expect(filterOwnerVisibleTurnHits([hit({ speaker: 'user', textHead: '' })])).toHaveLength(1);
    expect(filterOwnerVisibleTurnHits([hit({ textHead: 'anything' })])).toHaveLength(1);
  });

  it('PRESERVES the caller\'s relevance order', () => {
    /* Same property groupHitsBySession is documented to protect: post-Stage-B the
       ARRAY ORDER is the rerank's verdict, so a filter must remove without
       reordering. */
    const kept = filterOwnerVisibleTurnHits([
      hit({ turnIdx: 5, speaker: 'user', textHead: 'owner text' }),
      hit({ turnIdx: 6, speaker: 'user', textHead: '⟦turn-origin:wake-pump nonce:0123456789ab⟧\nblob' }),
      hit({ turnIdx: 7, speaker: 'assistant', textHead: 'reply' }),
    ]);
    expect(kept.map((h) => h.turnIdx)).toEqual([5, 7]);
  });

  it('hides a Stop-hook coaching wall — the shape the owner actually reported', () => {
    const kept = filterOwnerVisibleTurnHits([
      hit({ speaker: 'user', textHead: 'Stop hook feedback:\nThis turn ends by handing the next move back to the owner' }),
    ]);
    expect(kept).toEqual([]);
  });

  it('DROPS a hit whose marked term exists only in the stripped owner-chat note', () => {
    const fullText =
      'take 2: does this arrive as my own turn?\n\n' +
      '⟦owner-chat⟧ machine-only recipients_gone plumbing';
    const kept = filterOwnerVisibleTurnHits([
      hit({
        speaker: 'user',
        textHead: fullText.slice(0, 512),
        fullText,
        highlight: 'machine-only <mark>recipients_gone</mark> plumbing',
      }),
    ]);
    expect(kept).toEqual([]);
  });

  it('KEEPS an owner-chat hit when the marked term is in the rendered owner text', () => {
    const fullText =
      'search this transcript for recipients_gone\n\n' +
      '⟦owner-chat⟧ the note repeats recipients_gone but is hidden';
    const kept = filterOwnerVisibleTurnHits([
      hit({
        speaker: 'user',
        textHead: fullText.slice(0, 512),
        fullText,
        highlight: 'search this transcript for <mark>recipients_gone</mark>',
      }),
    ]);
    expect(kept).toHaveLength(1);
  });

  it('fails open for a semantic hit with no lexical mark', () => {
    const fullText = 'owner-authored context\n\n⟦owner-chat⟧ hidden machine note';
    const kept = filterOwnerVisibleTurnHits([
      hit({
        speaker: 'user',
        textHead: fullText.slice(0, 512),
        fullText,
        highlight: 'owner-authored context',
        matchedBy: 'semantic',
      }),
    ]);
    expect(kept).toHaveLength(1);
  });
});
