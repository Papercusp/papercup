/**
 * Unit tests for the corpus categorizer (coord-lifecycle-automation D-006).
 * Examples are faithful reconstructions of REAL coord_event_log messages.
 */

import { describe, it, expect } from 'vitest';
import { categorizeCoordMessage, categorizeCorpus } from './corpus-categorize';

describe('categorizeCoordMessage', () => {
  it('auto-stamped emissions → lifecycle-auto (the automated win)', () => {
    expect(categorizeCoordMessage({ auto: true, summary: 'F-1 DONE' })).toBe('lifecycle-auto');
    expect(categorizeCoordMessage({ lifecycle: 'completion', summary: 'x' })).toBe('lifecycle-auto');
  });

  it('completion prose → completion (needs a corroborating signal)', () => {
    expect(
      categorizeCoordMessage({
        summary: 'fleet-as-supervised-blackboard BUILT+TESTED (su-d3187): all 5 phases/8 decisions, 67 green tests, migs 146/147/148',
      }),
    ).toBe('completion');
    // bare "done" in a sentence with no corroboration is NOT completion
    expect(categorizeCoordMessage({ summary: 'are you done looking at that file?' })).toBe('contextual');
  });

  it('restart / resource broadcasts → restart-resource', () => {
    expect(categorizeCoordMessage({ summary: '🔒 "dev-server" is draining for an exclusive hold' })).toBe('restart-resource');
    expect(categorizeCoordMessage({ summary: '✅ "dev-server" is back up (released by res:up-1)' })).toBe('restart-resource');
  });

  it('claim/start prose → claim-start', () => {
    expect(categorizeCoordMessage({ summary: 'Taking BRIEF-test-coverage-fu-coordination per option (b)' })).toBe('claim-start');
    expect(categorizeCoordMessage({ summary: 'Executing unify-work-items-2026-06-04 end-to-end overnight' })).toBe('claim-start');
  });

  it('intent / window heads-up → intent-window', () => {
    expect(categorizeCoordMessage({ summary: 'heads-up — adding optional isolation field to BlueprintRoleSchema' })).toBe('intent-window');
    expect(categorizeCoordMessage({ summary: "I'll keep CRDT primitives in a NEW file, coordinate before touching yours" })).toBe('intent-window');
  });

  it('ack → ack', () => {
    expect(categorizeCoordMessage({ kind: 'ack', summary: '' })).toBe('ack');
    expect(categorizeCoordMessage({ summary: 'Thanks — split confirmed, I own the R2 blob layer' })).toBe('ack');
  });

  it('finding / health → finding-health', () => {
    expect(categorizeCoordMessage({ summary: '⚠ Migration number collision resolved: you used 147' })).toBe('finding-health');
  });

  it('genuinely contextual stays contextual (the irreducible residual)', () => {
    expect(
      categorizeCoordMessage({
        summary: 'Should the snapshot fork preserve the original author or reattribute to the forker?',
      }),
    ).toBe('contextual');
    expect(
      categorizeCoordMessage({ summary: 'I think the projection should prefer HLC when both ops carry one — thoughts?' }),
    ).toBe('contextual');
  });
});

describe('categorizeCorpus', () => {
  it('aggregates buckets + computes the headline percentages', () => {
    const report = categorizeCorpus([
      { auto: true, summary: 'F-1 DONE' }, // lifecycle-auto
      { auto: true, summary: 'F-2 claim' }, // lifecycle-auto
      { summary: 'Taking BRIEF-x' }, // claim-start (automatable)
      { summary: 'Should we reattribute the fork author?' }, // contextual
    ]);
    expect(report.total).toBe(4);
    expect(report.byBucket['lifecycle-auto']).toBe(2);
    expect(report.byBucket['claim-start']).toBe(1);
    expect(report.byBucket.contextual).toBe(1);
    expect(report.automatedPct).toBe(50);
    expect(report.contextualPct).toBe(25);
    expect(report.automatablePct).toBe(25);
  });
});
