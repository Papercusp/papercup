/** dead-end-matcher (ambient-semantic-push P-006, plan D-002/D-006 + D-010):
 *  the dead-end matcher thin pure core. Verifies it fires a legible, data-not-
 *  directive WARNING push when the agent's cursor overlaps a documented dead-end
 *  fact, stays silent below the floor / on disjoint facts, orders strongest
 *  first, honors the handle kind, and is pure. */
import { describe, it, expect } from 'vitest';
import { buildCursor } from './lexical-cursor';
import { selectPushes, type KnownContext } from './ambient-push';
import {
  matchDeadEnds,
  DEFAULT_DEAD_END_MIN_SCORE,
  type DeadEndFact,
} from './dead-end-matcher';

/** A note whose keywords (a WI id, a path/symbol, domain terms) give the cursor
 *  strong, legible join keys. */
const WORK_NOTE = 'debugging psu-launcher.mjs restart loop under compaction — WI-4790 advisory lock';

describe('matchDeadEnds — fires on overlap with a documented dead end', () => {
  it('emits a warning dead-end push when the cursor overlaps a fact note', () => {
    const cursor = buildCursor([WORK_NOTE]);
    // The fact note re-states the same dead end → identical cursor → overlap 1.
    const fact: DeadEndFact = { ref: 'FACT-launcher-wedge', note: WORK_NOTE };
    const [match, ...rest] = matchDeadEnds(cursor, [fact]);

    expect(rest).toHaveLength(0);
    expect(match.overlap.score).toBeCloseTo(1, 5);
    expect(match.push.matcherKind).toBe('dead-end');
    expect(match.push.severity).toBe('warning'); // drones DO see warnings (D-004)
    expect(match.push.provenance).toBe('data-not-directive');
    expect(match.push.handle.ref).toBe('FACT-launcher-wedge');
  });

  it('the handle query + teaser name the shared terms (legible "why")', () => {
    const cursor = buildCursor([WORK_NOTE]);
    const { push } = matchDeadEnds(cursor, [{ ref: 'FACT-1', note: WORK_NOTE }])[0];
    // The highest-value shared term is the artifact id — it must lead the query.
    expect(push.handle.query).toContain('WI-4790');
    expect(push.handle.query.length).toBeGreaterThan(0);
    expect(push.teaser).toContain('FACT-1'); // ref is legible in the teaser
    expect(push.teaser).toContain('shared:');
    expect(push.teaser).toContain('WI-4790');
  });

  it('defaults the handle kind to fact, but honors an explicit kind', () => {
    const cursor = buildCursor([WORK_NOTE]);
    const def = matchDeadEnds(cursor, [{ ref: 'FACT-1', note: WORK_NOTE }])[0];
    expect(def.push.handle.kind).toBe('fact');

    const wi = matchDeadEnds(cursor, [{ ref: 'WI-4790', note: WORK_NOTE, kind: 'work-item' }])[0];
    expect(wi.push.handle.kind).toBe('work-item');
  });
});

describe('matchDeadEnds — stays silent when it should', () => {
  it('emits nothing for a fact that shares no terms with the cursor', () => {
    const cursor = buildCursor([WORK_NOTE]);
    const disjoint: DeadEndFact = { ref: 'FACT-mac', note: 'rotate the mac build VM sudo password quarterly' };
    expect(matchDeadEnds(cursor, [disjoint])).toEqual([]);
  });

  it('drops a fact whose overlap is below the (default) warning floor', () => {
    const cursor = buildCursor([WORK_NOTE]);
    // A fact sharing exactly one low-weight domain term ("compaction") among many
    // unrelated ones scores low. Read its score at floor 0, then gate just above.
    const weak: DeadEndFact = { ref: 'FACT-weak', note: 'the deployment pipeline batches compaction of cold storage logs nightly offsite' };
    const unfloored = matchDeadEnds(cursor, [weak], { minScore: 0 });
    expect(unfloored).toHaveLength(1);
    const s = unfloored[0].overlap.score;

    const gated = matchDeadEnds(cursor, [weak], { minScore: s + 0.01 });
    expect(gated).toEqual([]);
  });

  it('skips empty / ref-less facts and an empty cursor', () => {
    const cursor = buildCursor([WORK_NOTE]);
    expect(matchDeadEnds(cursor, [{ ref: 'X', note: '   ' }, { ref: '', note: WORK_NOTE }])).toEqual([]);
    // An empty cursor overlaps nothing.
    expect(matchDeadEnds(buildCursor([]), [{ ref: 'FACT-1', note: WORK_NOTE }])).toEqual([]);
  });

  it('uses DEFAULT_DEAD_END_MIN_SCORE below ambient-push drone floor (matcher proposes, policy disposes)', () => {
    expect(DEFAULT_DEAD_END_MIN_SCORE).toBeLessThan(0.4); // drone minScore
  });
});

describe('matchDeadEnds — ordering + determinism', () => {
  it('returns the strongest-overlap dead end first', () => {
    const cursor = buildCursor([WORK_NOTE]);
    const strong: DeadEndFact = { ref: 'FACT-strong', note: WORK_NOTE }; // identical → ~1
    const weak: DeadEndFact = { ref: 'FACT-weak', note: 'compaction of cold storage logs nightly offsite' }; // shares just "compaction"
    const order = matchDeadEnds(cursor, [weak, strong], { minScore: 0 }).map((m) => m.fact.ref);
    expect(order[0]).toBe('FACT-strong');
    expect(order).toContain('FACT-weak');
  });

  it('breaks ties on equal score by ref, deterministically', () => {
    const cursor = buildCursor([WORK_NOTE]);
    // Two facts with the SAME note → equal overlap; ordered by ref ascending.
    const order = matchDeadEnds(cursor, [
      { ref: 'FACT-b', note: WORK_NOTE },
      { ref: 'FACT-a', note: WORK_NOTE },
    ]).map((m) => m.fact.ref);
    expect(order).toEqual(['FACT-a', 'FACT-b']);
  });

  it('does not mutate its inputs (pure)', () => {
    const cursor = buildCursor([WORK_NOTE]);
    const facts: DeadEndFact[] = [{ ref: 'FACT-1', note: WORK_NOTE }];
    const snapshot = JSON.parse(JSON.stringify(facts));
    matchDeadEnds(cursor, facts);
    expect(facts).toEqual(snapshot);
  });
});

describe('matchDeadEnds — composes with the delivery pipeline', () => {
  it('a strong dead-end push flows through selectPushes to a drone (warning, above floor)', () => {
    const cursor = buildCursor([WORK_NOTE]);
    const matches = matchDeadEnds(cursor, [{ ref: 'FACT-1', note: WORK_NOTE }]);
    expect(matches[0].push.score).toBeCloseTo(1, 5); // clears the 0.4 drone floor

    const known: KnownContext = { refs: new Set() };
    const { selected, dropped } = selectPushes({ candidates: matches.map((m) => m.push), sessionClass: 'drone', known });
    expect(selected).toHaveLength(1);
    expect(selected[0].handle.ref).toBe('FACT-1');
    expect(dropped).toHaveLength(0);
  });

  it('a dead-end push the agent already carries is dropped not-novel', () => {
    const cursor = buildCursor([WORK_NOTE]);
    const matches = matchDeadEnds(cursor, [{ ref: 'FACT-1', note: WORK_NOTE }]);
    const known: KnownContext = { refs: new Set(['FACT-1']) }; // already carried
    const { selected, dropped } = selectPushes({ candidates: matches.map((m) => m.push), sessionClass: 'drone', known });
    expect(selected).toHaveLength(0);
    expect(dropped[0].reason).toBe('not-novel');
  });
});
