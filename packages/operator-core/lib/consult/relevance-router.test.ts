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
  type RoutingCandidate,
  type SelectedResponder,
} from './relevance-router';

const cand = (ownerId: string, over: Partial<RoutingCandidate> = {}): RoutingCandidate => ({
  ownerId,
  score: 0.7,
  signals: { similarity: 0.72, recency: 0.5, verification: 0.3, authorship: 0 },
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

describe('selectionSnapshot — persisted provenance (D-002)', () => {
  it('records min/max and each selection with via + score + similarity + liveness', () => {
    const a = cand('a', { score: 0.9, signals: { similarity: 0.8, recency: 0.5, verification: 0.3, authorship: 0 } });
    const b = cand('b', { score: 0.4, signals: { similarity: 0.3, recency: 0.5, verification: 0.3, authorship: 0 }, liveness: 'parked' });
    const snap = selectionSnapshot(2, 3, [
      { candidate: a, via: 'floor' },
      { candidate: b, via: 'minimum' },
    ]);
    expect(snap).toEqual({
      min: 2,
      max: 3,
      selected: [
        { ownerId: 'a', via: 'floor', score: 0.9, similarity: 0.8, liveness: 'live' },
        { ownerId: 'b', via: 'minimum', score: 0.4, similarity: 0.3, liveness: 'parked' },
      ],
    });
  });
});
