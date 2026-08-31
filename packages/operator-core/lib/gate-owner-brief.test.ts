/**
 * gate-owner-brief.test.ts — gate-audit-hardening-2026-08-31 P-001.
 *
 * Pure-composition tests: every case is a value-in/value-out check on
 * `composeGateOwnerBrief`, no I/O. The deliberately-wrong control the falsifiability
 * discipline asks for is the STALLED case: a live holder plus a DEAD fixer must NOT
 * read as remediating — that misread is the measured ~5h gap the audit found.
 */

import { describe, expect, it } from 'vitest';
import { composeGateOwnerBrief, type GateOwnerBriefInput } from './gate-owner-brief';

const NOW = 1_788_193_000_000;

const heldLiveOwnership = {
  claimState: 'held',
  takenBy: 'su-40d60b0c-5441-431f-959c-7d3c196b534a',
  workItem: 'WI-212675',
  assessment: { code: 'held-live' },
} as unknown as GateOwnerBriefInput['ownership'];

const claimableOwnership = {
  claimState: 'claimable',
  takenBy: null,
  workItem: 'WI-212675',
  assessment: { code: 'claimable' },
} as unknown as GateOwnerBriefInput['ownership'];

const base: GateOwnerBriefInput = {
  nowMs: NOW,
  consecutiveReds: 0,
  failingTests: [],
  failingTestsMeasured: true,
  lastGreenAtMs: NOW - 60_000,
  verdictObservedAtMs: NOW - 30_000,
  fireStale: false,
  verdictStale: false,
  inconclusive: null,
  repairQueue: null,
  ownership: heldLiveOwnership,
};

const redQueue = (over: Partial<NonNullable<GateOwnerBriefInput['repairQueue']>> = {}) => ({
  phase: 'awaiting-fixer',
  attempts: 1,
  updatedAtMs: NOW - 120_000,
  ageMs: 3_600_000,
  fixerSpawnId: 's-123',
  fixerAlive: true,
  zeroAttemptStalled: false,
  ...over,
});

describe('composeGateOwnerBrief', () => {
  it('answers green when the gate is green and current, with no whyNot leg', () => {
    const b = composeGateOwnerBrief(base);
    expect(b.answer).toBe('green');
    expect(b.assessment.code).toBe('green');
    expect(b.mainGreen.value).toBe(true);
    expect(b.whyNot).toBeNull();
  });

  it('not-judging outranks everything else when the gate is not firing', () => {
    const b = composeGateOwnerBrief({ ...base, fireStale: true, consecutiveReds: 7 });
    expect(b.answer).toBe('not-judging');
  });

  it('unmeasured counters answer unknown and name the missing leg', () => {
    const b = composeGateOwnerBrief({ ...base, consecutiveReds: null });
    expect(b.answer).toBe('unknown');
    expect(b.mainGreen.value).toBeNull();
    expect(b.unknownLegs.map((l) => l.leg)).toContain('verdict');
  });

  it('a red with no live holder is red-unowned — the pileup shape', () => {
    const b = composeGateOwnerBrief({
      ...base,
      consecutiveReds: 79,
      failingTests: ['lint:tsc'],
      ownership: claimableOwnership,
    });
    expect(b.answer).toBe('red-unowned');
    expect(b.whyNot?.failingLegs).toEqual(['lint:tsc']);
    expect(b.ownership.assessmentCode).toBe('claimable');
  });

  it('a red with a live holder and a live fixer is red-owned-remediating', () => {
    const b = composeGateOwnerBrief({
      ...base,
      consecutiveReds: 79,
      failingTests: ['lint:tsc'],
      repairQueue: redQueue(),
    });
    expect(b.answer).toBe('red-owned-remediating');
    expect(b.remediation?.fixerAlive).toBe(true);
  });

  it('a live holder with a DEAD fixer is red-owned-stalled, never remediating (the 5h-gap case)', () => {
    const b = composeGateOwnerBrief({
      ...base,
      consecutiveReds: 79,
      failingTests: ['lint:tsc'],
      repairQueue: redQueue({ fixerAlive: false }),
    });
    expect(b.answer).toBe('red-owned-stalled');
  });

  it('zero-attempt stall also reads as stalled even when liveness is unmeasurable', () => {
    const b = composeGateOwnerBrief({
      ...base,
      consecutiveReds: 12,
      repairQueue: redQueue({ fixerAlive: null, zeroAttemptStalled: true }),
    });
    expect(b.answer).toBe('red-owned-stalled');
    expect(b.unknownLegs.map((l) => l.leg)).toContain('remediation.fixerAlive');
  });

  it('an inconclusive record makes the answer a red-family one even at zero reds', () => {
    const b = composeGateOwnerBrief({
      ...base,
      consecutiveReds: 0,
      inconclusive: { status: 'repair-in-progress', detail: 'fixer dispatched', observedAtMs: NOW - 5_000 },
    });
    expect(b.answer).toBe('red-owned-remediating');
    expect(b.whyNot?.inconclusiveStatus).toBe('repair-in-progress');
  });

  it('stamps every leg with a vintage and reports the spread between them', () => {
    const b = composeGateOwnerBrief({
      ...base,
      consecutiveReds: 3,
      failingTests: ['lint:tsc'],
      verdictObservedAtMs: NOW - 600_000,
      repairQueue: redQueue({ updatedAtMs: NOW - 60_000 }),
    });
    expect(b.mainGreen.vintage.observedAtMs).toBe(NOW - 600_000);
    expect(b.mainGreen.vintage.ageMs).toBe(600_000);
    expect(b.ownership.vintage.observedAtMs).toBe(NOW);
    // spread = newest (ownership, NOW) − oldest (verdict, NOW-600s)
    expect(b.vintageSpreadMs).toBe(600_000);
    expect(b.lastGreen.ageMs).toBe(60_000);
  });

  it('never claims measurement it does not have: carried failing legs read measured=false', () => {
    const b = composeGateOwnerBrief({
      ...base,
      consecutiveReds: 5,
      failingTests: ['lint:tsc'],
      failingTestsMeasured: false,
    });
    expect(b.whyNot?.measured).toBe(false);
  });
});
