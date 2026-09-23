/**
 * Unit tests for the pure min/max responder-selection half of the relevance
 * router (plan consult-min-max-and-rubric-vetting-2026-08-17, P-001;
 * decisions D-001 §1 / D-002 / D-003). selectResponders is deliberately pure
 * and shared by every selecting surface so the semantics cannot drift between
 * call sites — these tests pin them.
 */
import { describe, expect, it } from 'vitest';
import {
  selectResponders,
  selectionSnapshot,
  snapshotCandidateQualifies,
  qualifyingScoreOf,
  relevanceOf,
  freshnessOf,
  FRESHNESS_BASE,
  type RoutingCandidate,
  type SelectedResponder,
} from './relevance-router';

const cand = (ownerId: string, over: Partial<RoutingCandidate> = {}): RoutingCandidate => ({
  ownerId,
  score: 0.7,
  relevance: 0.7,
  relativeAgeDays: 0,
  signals: { similarity: 0.72, verification: 0.3, authorship: 0, freshness: 1 },
  evidence: [],
  liveness: 'live',
  ...over,
});

const ids = (s: SelectedResponder[]) => s.map((x) => x.candidate.ownerId);
const vias = (s: SelectedResponder[]) => s.map((x) => x.via);

describe('selectResponders — floor picks', () => {
  it('selects every qualified candidate best-first up to max, labeled via:floor', () => {
    const q = [cand('a', { score: 0.9 }), cand('b', { score: 0.8 }), cand('c', { score: 0.7 })];
    const s = selectResponders({ qualified: q, allCandidates: q, min: 1, max: 2 });
    expect(ids(s)).toEqual(['a', 'b']); // capped at max, order preserved
    expect(vias(s)).toEqual(['floor', 'floor']);
  });

  it('does not fill past min when qualified already satisfies it', () => {
    const q = [cand('a')];
    const all = [cand('a'), cand('fill')];
    const s = selectResponders({ qualified: q, allCandidates: all, min: 1, max: 3 });
    expect(ids(s)).toEqual(['a']); // fill is for reaching MIN, never max
  });
});

describe('selectResponders — minimum fill (D-001 §1 / D-002)', () => {
  it('fills to min from allCandidates when the floors filtered everyone, labeled via:minimum', () => {
    const all = [cand('best', { score: 0.4 }), cand('next', { score: 0.3 })];
    const s = selectResponders({ qualified: [], allCandidates: all, min: 1, max: 3 });
    expect(ids(s)).toEqual(['best']);
    expect(vias(s)).toEqual(['minimum']);
  });

  it('mixes floor picks and fills, deduped by ownerId (qualified ⊆ allCandidates)', () => {
    const a = cand('a', { score: 0.9 });
    const all = [a, cand('b', { score: 0.45 }), cand('c', { score: 0.35 })];
    const s = selectResponders({ qualified: [a], allCandidates: all, min: 2, max: 3 });
    expect(ids(s)).toEqual(['a', 'b']); // 'a' not re-picked from the fill pool
    expect(vias(s)).toEqual(['floor', 'minimum']);
  });

  it('min is clamped to max', () => {
    const all = [cand('a'), cand('b'), cand('c')];
    const s = selectResponders({ qualified: [], allCandidates: all, min: 5, max: 2 });
    expect(s).toHaveLength(2);
  });

  it('min 0 restores pure-floor selection: nothing qualified ⇒ empty', () => {
    const all = [cand('below', { score: 0.3 })];
    expect(selectResponders({ qualified: [], allCandidates: all, min: 0, max: 3 })).toEqual([]);
  });
});

describe('selectResponders — selectability gate (liveness, D-008 §5)', () => {
  const notDead = (c: RoutingCandidate) => c.liveness !== 'ended';

  it('skips unselectable candidates in BOTH legs', () => {
    const deadQ = cand('dead-q', { score: 0.9, liveness: 'ended' });
    const liveQ = cand('live-q', { score: 0.8 });
    const all = [deadQ, liveQ, cand('dead-fill', { score: 0.5, liveness: 'ended' }), cand('live-fill', { score: 0.4 })];
    const s = selectResponders({ qualified: [deadQ, liveQ], allCandidates: all, min: 2, max: 3, isSelectable: notDead });
    expect(ids(s)).toEqual(['live-q', 'live-fill']);
    expect(vias(s)).toEqual(['floor', 'minimum']);
  });

  it('skips owner-paused candidates in BOTH legs', () => {
    const pausedQ = cand('paused-q', { score: 0.9, ownerPaused: true });
    const liveQ = cand('live-q', { score: 0.8 });
    const pausedFill = cand('paused-fill', { score: 0.5, ownerPaused: true });
    const liveFill = cand('live-fill', { score: 0.4 });
    const s = selectResponders({
      qualified: [pausedQ, liveQ],
      allCandidates: [pausedQ, liveQ, pausedFill, liveFill],
      min: 2,
      max: 3,
      isSelectable: (c) => c.ownerPaused !== true,
    });
    expect(ids(s)).toEqual(['live-q', 'live-fill']);
    expect(vias(s)).toEqual(['floor', 'minimum']);
  });

  it('rejects unknown liveness from absent presence in BOTH legs', () => {
    const absentFloor = cand('absent-floor', { score: 0.9, liveness: 'unknown' });
    const liveFloor = cand('live-floor', { score: 0.8 });
    const absentFill = cand('absent-fill', { score: 0.5, liveness: 'unknown' });
    const liveFill = cand('live-fill', { score: 0.4 });
    const s = selectResponders({
      qualified: [absentFloor, liveFloor],
      allCandidates: [absentFloor, liveFloor, absentFill, liveFill],
      min: 2,
      max: 3,
      // Missing presence is normalized to `unknown`; only a reachable live or
      // parked session may receive the cascade wake.
      isSelectable: (c) => c.liveness === 'live' || c.liveness === 'parked',
    });
    expect(ids(s)).toEqual(['live-floor', 'live-fill']);
    expect(vias(s)).toEqual(['floor', 'minimum']);
  });

  it('a minimum only fillable by the unreachable stays UNFILLED (honest short set)', () => {
    const all = [cand('dead', { liveness: 'ended' })];
    expect(selectResponders({ qualified: [], allCandidates: all, min: 1, max: 3, isSelectable: notDead })).toEqual([]);
  });

  it('max 0 selects nobody regardless of min', () => {
    const all = [cand('a')];
    expect(selectResponders({ qualified: all, allCandidates: all, min: 1, max: 0 })).toEqual([]);
  });
});

describe('relevanceOf — stage 1 has no time term (D-001 §1)', () => {
  const signals = { similarity: 0.8, verification: 0.5, authorship: 0 };

  it('renormalizes by the weight total, so the floor keeps its meaning under any weights', () => {
    // The floor is calibrated against a [0,1] quantity. Without the
    // renormalization, dropping a signal's weight would silently lower every
    // candidate's score and quietly raise the effective bar.
    expect(relevanceOf(signals, { similarity: 0.55, verification: 0.15, authorship: 0.15 })).toBeCloseTo(
      (0.55 * 0.8 + 0.15 * 0.5) / 0.85,
      10,
    );
    // Same weights at double scale ⇒ identical relevance.
    expect(relevanceOf(signals, { similarity: 1.1, verification: 0.3, authorship: 0.3 })).toBeCloseTo(
      relevanceOf(signals, { similarity: 0.55, verification: 0.15, authorship: 0.15 }),
      10,
    );
  });

  it('all-zero weights yield 0 rather than NaN', () => {
    expect(relevanceOf(signals, { similarity: 0, verification: 0, authorship: 0 })).toBe(0);
  });
});

describe('freshnessOf — stage 2 is RELATIVE (D-001 §2)', () => {
  const DAY = 86_400_000;
  const H = 7;

  it('is shift-invariant: moving the whole set in time changes nothing', () => {
    const a = freshnessOf(1_000 * DAY, 1_010 * DAY, H);
    const b = freshnessOf(2_000 * DAY, 2_010 * DAY, H); // same gap, 1000 days later
    expect(b).toEqual(a);
    expect(a.relativeAgeDays).toBe(10);
  });

  it('the reference candidate is fully fresh, and a fresher-than-reference one cannot exceed it', () => {
    expect(freshnessOf(500 * DAY, 500 * DAY, H)).toEqual({ freshness: 1, relativeAgeDays: 0 });
    // An unqualified candidate may be newer than the freshest QUALIFIED one.
    expect(freshnessOf(505 * DAY, 500 * DAY, H)).toEqual({ freshness: 1, relativeAgeDays: 0 });
  });

  it('decays toward the base, never to zero', () => {
    const ancient = freshnessOf(0, 10_000 * DAY, H);
    expect(ancient.freshness).toBeGreaterThanOrEqual(FRESHNESS_BASE);
    expect(ancient.freshness).toBeCloseTo(FRESHNESS_BASE, 6);
  });

  it('undated inputs are honest rather than scored: no reference ⇒ no differentiation', () => {
    expect(freshnessOf(500 * DAY, null, H)).toEqual({ freshness: 1, relativeAgeDays: null });
    expect(freshnessOf(null, 500 * DAY, H)).toEqual({ freshness: FRESHNESS_BASE, relativeAgeDays: null });
  });

  it('a non-positive half-life degrades to a step, not to NaN/Infinity', () => {
    expect(freshnessOf(500 * DAY, 500 * DAY, 0)).toEqual({ freshness: 1, relativeAgeDays: 0 });
    expect(freshnessOf(499 * DAY, 500 * DAY, 0)).toEqual({ freshness: FRESHNESS_BASE, relativeAgeDays: 1 });
  });
});

describe('snapshotCandidateQualifies — reads a persisted snapshot on its OWN terms', () => {
  it('two-stage snapshot: the floor reads `relevance`, never the comparison score', () => {
    const snap = { relevanceFloor: 0.41, simFloor: 0.4 };
    // Stale but relevant: a low comparison score with an above-floor relevance
    // is EXACTLY the case D-001 exists for — it must label `floor`.
    expect(snapshotCandidateQualifies(snap, { relevance: 0.6, score: 0.15, signals: { similarity: 0.7 } })).toBe(true);
    // …and the reverse must not be admitted by a generous score.
    expect(snapshotCandidateQualifies(snap, { relevance: 0.2, score: 0.99, signals: { similarity: 0.7 } })).toBe(false);
    // The hard sim sub-floor still gates independently.
    expect(snapshotCandidateQualifies(snap, { relevance: 0.9, score: 0.9, signals: { similarity: 0.1 } })).toBe(false);
  });

  it('pre-D-001 snapshot: `floor` + the blended `score` are applied as that record meant them', () => {
    // These rows are still in consult_state.routing until the last one expires.
    // Judging them by the new rule would relabel a responder's provenance.
    const legacy = { floor: 0.5, simFloor: 0.4 };
    expect(snapshotCandidateQualifies(legacy, { score: 0.62, signals: { similarity: 0.7 } })).toBe(true);
    expect(snapshotCandidateQualifies(legacy, { score: 0.31, signals: { similarity: 0.7 } })).toBe(false);
  });

  it('an unreadable floor admits NOBODY — a missing bar is unknown, not zero', () => {
    // Guessing here would promote a best-available fill to "qualified expert",
    // which is the one mislabel the whole D-002 provenance rule exists to stop.
    expect(snapshotCandidateQualifies({ simFloor: 0.4 }, { relevance: 0.9, signals: { similarity: 0.9 } })).toBe(false);
    expect(snapshotCandidateQualifies({ relevanceFloor: 0.41 }, { relevance: 0.9, signals: { similarity: 0.9 } })).toBe(
      false,
    );
    expect(snapshotCandidateQualifies(null, { relevance: 0.9, signals: { similarity: 0.9 } })).toBe(false);
    expect(snapshotCandidateQualifies({ relevanceFloor: 0.41, simFloor: 0.4 }, null)).toBe(false);
  });
});

describe('qualifyingScoreOf — the displayable number, across both snapshot generations', () => {
  it('prefers relevance, falls back to the pre-D-001 blended score, and never throws on a partial record', () => {
    expect(qualifyingScoreOf({ relevance: 0.62, score: 0.19 })).toBe(0.62);
    // A pre-D-001 selection entry has NO relevance at all. The wake copy renders
    // these straight out of consult_state.routing, so reaching for a missing
    // field here is a TypeError mid-wake, not a cosmetic gap.
    expect(qualifyingScoreOf({ score: 0.71 })).toBe(0.71);
    expect(qualifyingScoreOf({})).toBe(0);
    expect(qualifyingScoreOf(null)).toBe(0);
    // Non-finite is not a number worth printing.
    expect(qualifyingScoreOf({ relevance: Number.NaN, score: 0.5 })).toBe(0.5);
  });
});

describe('selectionSnapshot — persisted provenance (D-002)', () => {
  it('records min/max and each selection with via + score + similarity + liveness', () => {
    const a = cand('a', {
      score: 0.9,
      relevance: 0.95,
      signals: { similarity: 0.8, verification: 0.3, authorship: 0, freshness: 0.95 },
    });
    const b = cand('b', {
      score: 0.4,
      relevance: 0.44,
      signals: { similarity: 0.3, verification: 0.3, authorship: 0, freshness: 0.91 },
      liveness: 'parked',
    });
    const snap = selectionSnapshot(2, 3, [
      { candidate: a, via: 'floor' },
      { candidate: b, via: 'minimum' },
    ]);
    // `relevance` rides along with `score` deliberately: `via` is derived from
    // the stage-1 number, so a provenance record holding only the stage-2 score
    // cannot be checked against the floors it claims to describe.
    expect(snap).toEqual({
      min: 2,
      max: 3,
      selected: [
        { ownerId: 'a', via: 'floor', score: 0.9, relevance: 0.95, similarity: 0.8, liveness: 'live' },
        { ownerId: 'b', via: 'minimum', score: 0.4, relevance: 0.44, similarity: 0.3, liveness: 'parked' },
      ],
    });
  });
});
