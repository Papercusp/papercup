/**
 * blender-self-learning-2026-07-12 P-012 — the END-TO-END chain test over the
 * program's pure pipeline: per-lane accumulator counts → weighted signal score
 * → volume-based cadence verdict → delta-first digest rendering. Each PG edge
 * (the 30s recount sweep, the snapshot store, the scheduler wiring) is
 * live-verified separately; THIS suite pins the logic chain those edges feed,
 * so a regression in any hand-off (weights, thresholds, veto, render split)
 * reds here without a database.
 */
import { describe, it, expect } from 'vitest';
import { weightedSignalScore, effectiveWatermarkMs, SIGNAL_LANES } from './signal-accumulator';
import { shouldRunScoutCycle, type ScoutCadenceState } from './cadence';
import { renderDigest, buildRubricFocus } from './lenses';
import type { CorpusDigest, MetaPattern } from './types';

const NOW = Date.parse('2026-07-12T12:00:00Z');
const base = (over: Partial<ScoutCadenceState> = {}): ScoutCadenceState => ({
  idleRatio: 0.1,
  frictionSignals: 0,
  lastRunAtMs: NOW - 16 * 60_000, // past the 15-min volume floor
  nowMs: NOW,
  ...over,
});
const pat = (ref: string, summary: string): MetaPattern => ({ ref, summary });
const digest = (over: Partial<CorpusDigest> = {}): CorpusDigest =>
  ({ recurringFriction: [], timeTokenSinks: [], chronicDeferrals: [], capabilityGaps: [], ...over }) as CorpusDigest;

describe('signal chain: quiet workspace → NOTHING fires, NOTHING renders stale', () => {
  it('zero signal in every lane → score 0 → no-signal veto (no stale-corpus cycle)', () => {
    const counts = Object.fromEntries(SIGNAL_LANES.map((l) => [l, 0]));
    const score = weightedSignalScore(counts);
    expect(score).toBe(0);
    const verdict = shouldRunScoutCycle(base({ signalScore: score, idleRatio: 1 }));
    expect(verdict).toEqual({ fire: false, reason: 'no-signal' });
  });
});

describe('signal chain: busy workspace → volume fire → delta-first prompt', () => {
  // The live 2026-07-12 shape: a busy 30-minute window.
  const counts = {
    'scorecard-rating-changes': 1,
    observations: 28,
    captures: 9,
    reverts: 16,
    deferrals: 0,
    completions: 20,
  };

  it('the weighted score crosses the threshold and fires signal-volume', () => {
    const score = weightedSignalScore(counts); // 3+56+9+48+0+10 = 126
    expect(score).toBe(126);
    const verdict = shouldRunScoutCycle(base({ signalScore: score }));
    expect(verdict).toEqual({ fire: true, reason: 'signal-volume' });
  });

  it('the fired cycle renders NEW-first against the previous snapshot refs', () => {
    const d = digest({
      recurringFriction: [pat('wi:new-friction', 'fresh pain')],
      capabilityGaps: [pat('gap:old', 'standing gap')],
      previousCycleRefs: ['gap:old'],
    });
    const out = renderDigest(d);
    const newIdx = out.indexOf('## NEW since your last cycle');
    const standingIdx = out.indexOf('## Standing patterns');
    expect(newIdx).toBeGreaterThanOrEqual(0);
    expect(out.indexOf('(ref: wi:new-friction)')).toBeLessThan(standingIdx);
    expect(out.indexOf('(ref: gap:old)')).toBeGreaterThan(standingIdx);
  });

  it('rubric measurements in the digest yield a deterministic ideator focus block', () => {
    const d = digest({
      rubricRatings: [pat('rubric:su-agent-behavior#context-burn@papercusp', 'broken 3× over 5 obs')],
    });
    const focus = buildRubricFocus(d);
    expect(focus).toContain('(ref: rubric:su-agent-behavior#context-burn@papercusp)');
  });
});

describe('signal chain: failed cycles never lose signal', () => {
  it('the watermark only advances on a SUCCESSFUL run — an error streak leaves it (and the accumulated signal) in place', () => {
    const lastSuccessfulRun = NOW - 3 * 3600_000; // errors since then
    // The recount baseline stays pinned to the last success (within lookback),
    // so counts keep accumulating across transport-death cycles.
    expect(effectiveWatermarkMs(lastSuccessfulRun, NOW, 604_800)).toBe(lastSuccessfulRun);
  });

  it('a trickle below threshold still heartbeats eventually (never fully dark while signal exists)', () => {
    const score = weightedSignalScore({ captures: 2 }); // 2 < 25
    const verdict = shouldRunScoutCycle(base({ signalScore: score, lastRunAtMs: NOW - 61 * 60_000 }));
    expect(verdict).toEqual({ fire: true, reason: 'heartbeat' });
  });
});
