/**
 * P-004 (test-gym): the compare/select verdict → Scout meta-learning wire.
 *
 * Proves the projected entries flow through the EXISTING outcome-feedback
 * machinery end-to-end: a selected winner classifies `won`, a measured loser
 * `lost`, an errored arm stays `pending` — and the lens report moves
 * accordingly. No new attribution machinery.
 */

import { describe, expect, it } from 'vitest';

import { evalVerdictEntries, evalVerdictRef, selectedCandidate, type EvalVerdictLike } from './eval-verdict-wire';
import { classifyIdeaOutcome, computeLensOutcomes, type RoutedIdeaProvenance } from './outcome-feedback';
import type { CreativeLens } from './types';

const VERDICT: EvalVerdictLike = {
  scenarioId: 'coord-eval',
  primaryScorer: 'lock-block-rate',
  selected: 'scout-idea-42',
  selectionReason: "selected 'scout-idea-42': primary improved by 0.2 (> minDelta 0)",
  candidates: [
    { variantId: 'scout-idea-42', rank: 1, errored: false, primaryImprovement: 0.2 },
    { variantId: 'scout-idea-7', rank: 2, errored: false, primaryImprovement: -0.1 },
    { variantId: 'scout-idea-13', rank: 3, errored: true },
  ],
};

function prov(ideaId: string, lens: CreativeLens, variantId: string): RoutedIdeaProvenance {
  return {
    ideaId,
    lens,
    rail: 'gym',
    routedRef: evalVerdictRef('coord-eval', variantId),
    routedAt: '2026-06-10T00:00:00Z',
  };
}

describe('evalVerdictEntries', () => {
  it('emits accepted for the winner, rejected for measured losers, nothing for errored arms', () => {
    const entries = evalVerdictEntries(VERDICT, new Date('2026-06-10T01:00:00Z'));
    expect(entries.map((e) => e.ref)).toEqual([
      'eval:coord-eval#scout-idea-42',
      'eval:coord-eval#scout-idea-7',
    ]);
    expect(entries[0]!.kind).toBe('proposal');
    expect(entries[0]!.detail).toContain('status: accepted');
    expect(entries[1]!.detail).toContain('status: rejected');
  });

  it('emits nothing when no candidate was measured', () => {
    const entries = evalVerdictEntries(
      { ...VERDICT, selected: undefined, candidates: [{ variantId: 'x', rank: 1, errored: true }] },
      new Date(),
    );
    expect(entries).toEqual([]);
  });
});

describe('verdict entries flow through classifyIdeaOutcome unchanged', () => {
  const entries = evalVerdictEntries(VERDICT, new Date('2026-06-10T01:00:00Z'));
  const byRef = new Map(entries.map((e) => [e.ref, e]));

  it('selected winner → won', () => {
    expect(classifyIdeaOutcome(prov('i1', 'reframing', 'scout-idea-42'), byRef)).toBe('won');
  });

  it('measured loser → lost', () => {
    expect(classifyIdeaOutcome(prov('i2', 'analogical', 'scout-idea-7'), byRef)).toBe('lost');
  });

  it('errored arm → pending (no entry, unknown is not lost)', () => {
    expect(classifyIdeaOutcome(prov('i3', 'analogical', 'scout-idea-13'), byRef)).toBe('pending');
  });

  it('the lens report counts the eval outcomes', () => {
    const report = computeLensOutcomes(
      [prov('i1', 'reframing', 'scout-idea-42'), prov('i2', 'analogical', 'scout-idea-7')],
      entries,
    );
    expect(report.byLens['reframing']!.won).toBe(1);
    expect(report.byLens['analogical']!.lost).toBe(1);
  });
});

describe('selectedCandidate (the promotion read)', () => {
  it('returns the winning candidate', () => {
    expect(selectedCandidate(VERDICT)?.variantId).toBe('scout-idea-42');
  });

  it('returns undefined when baseline held', () => {
    expect(selectedCandidate({ ...VERDICT, selected: undefined })).toBeUndefined();
  });
});
