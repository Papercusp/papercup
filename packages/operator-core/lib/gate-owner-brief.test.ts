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
  assessment: 'held-live',
} as unknown as GateOwnerBriefInput['ownership'];

/**
 * The EI-22123840107491540 shape: held, but the presence oracle can only say
 * `suspect`/`draining` — neither alive nor dead. `held-needs-confirmation` used to be
 * counted as a live hold here, which is why a stranded gate could never surface as
 * anything but owned-and-being-worked.
 */
const heldUnconfirmedOwnership = {
  claimState: 'held',
  takenBy: 'su-respawn-b353b06382f5752cbb0b9b781e91be86',
  workItem: 'WI-212675',
  assessment: 'held-needs-confirmation',
} as unknown as GateOwnerBriefInput['ownership'];

const claimableOwnership = {
  claimState: 'claimable',
  takenBy: null,
  workItem: 'WI-212675',
  assessment: 'claimable',
} as unknown as GateOwnerBriefInput['ownership'];

const base: GateOwnerBriefInput = {
  nowMs: NOW,
  consecutiveReds: 0,
  failingTests: [],
  failingTestsMeasured: true,
  failingTestsProvenance: 'measured',
  mainBehindStaging: false,
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

  it('P-005: distinguishes a green verdict with an unpromoted staging buffer in the headline itself', () => {
    const b = composeGateOwnerBrief({ ...base, mainBehindStaging: true });
    expect(b.answer).toBe('green-not-promoted');
    expect(b.assessment.code).toBe('green-not-promoted');
    expect(b.assessment.safeAction).toMatch(/green-checkpoint/i);
    expect(b.assessment.safeAction).toMatch(/do not fast-forward main directly/i);
    expect(b.mainGreen.value).toBe(true);
    expect(b.whyNot).toBeNull();
  });

  it('P-005: a missing promotion measurement is named instead of guessed', () => {
    const b = composeGateOwnerBrief({ ...base, mainBehindStaging: null });
    expect(b.answer).toBe('green');
    expect(b.unknownLegs.map((l) => l.leg)).toContain('mainBehindStaging');
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

  // ── EI-22123840107491540: the cell must not report a live-looking hold for a
  // stranded gate. The measured case is reproduced exactly: ownership resolved to
  // `held-needs-confirmation` (holder `suspect`, no turn in 5h11m, two required wakes
  // absorbed) while the repair queue had never dispatched a fixer at all.
  it('an UNCONFIRMED holder with no fixer ever dispatched is red-owned-unconfirmed, not stalled or remediating', () => {
    const b = composeGateOwnerBrief({
      ...base,
      consecutiveReds: 89,
      failingTests: ['lint:tsc'],
      ownership: heldUnconfirmedOwnership,
      repairQueue: redQueue({ attempts: 0, fixerSpawnId: null, fixerAlive: null, zeroAttemptStalled: true }),
    });
    expect(b.answer).toBe('red-owned-unconfirmed');
    // The two readings this used to collapse into. `red-owned-stalled` is the
    // dangerous one: its safeAction ends at "tell the holder / escalate", which is
    // exactly what the reporter did — twice — with no terminating branch left.
    expect(b.answer).not.toBe('red-owned-stalled');
    expect(b.answer).not.toBe('red-owned-remediating');
    // The answer must name the reclaim, or it is the same dead end in a new code.
    expect(b.assessment.safeAction).toMatch(/reclaim/i);
  });

  it('an UNCONFIRMED holder with a LIVE fixer still reads remediating — the new code stays narrow', () => {
    const b = composeGateOwnerBrief({
      ...base,
      consecutiveReds: 4,
      ownership: heldUnconfirmedOwnership,
      repairQueue: redQueue({ fixerAlive: true }),
    });
    expect(b.answer).toBe('red-owned-remediating');
  });

  // Deliberately-wrong control: the ownership oracle's own liveness table
  // (`POSITIVELY_LIVE`) marks draining/suspect false, so a brief that treats
  // `held-needs-confirmation` as a live hold contradicts the module it reads from.
  // Pin the two together rather than trusting the two files to stay in step.
  it('does not treat an unconfirmed hold the same as a live one when remediation has stalled', () => {
    const stalled = { ...base, consecutiveReds: 30, repairQueue: redQueue({ fixerAlive: false }) };
    const live = composeGateOwnerBrief({ ...stalled, ownership: heldLiveOwnership });
    const unconfirmed = composeGateOwnerBrief({ ...stalled, ownership: heldUnconfirmedOwnership });
    expect(live.answer).not.toBe(unconfirmed.answer);
  });

  /*
   * FALSIFIABILITY CONTROL — kept permanently, per the tier-1 rule for a subject you
   * `import` (mutating the shared tree to prove a guard fails is the shape git-sync
   * commits by accident). `OLD_OWNED_LIVE_CODES` is the pre-EI-22123840107491540
   * classification verbatim; the control asserts it lands on the WRONG answer for the
   * measured input, and the calibration asserts the REAL subject lands on the right
   * one. Without the control, both tests above would also pass if the whole
   * `red-owned-unconfirmed` branch were deleted and the code simply never reached.
   */
  describe('falsifiability control: the pre-fix classification', () => {
    const OLD_OWNED_LIVE_CODES = new Set(['held-live', 'held-needs-confirmation']);
    const strandedInput = {
      ...base,
      consecutiveReds: 89,
      ownership: heldUnconfirmedOwnership,
      repairQueue: redQueue({ attempts: 0, fixerSpawnId: null, fixerAlive: null, zeroAttemptStalled: true }),
    };

    it('the OLD rule classifies the stranded holder as a live hold — the defect', () => {
      const code = (strandedInput.ownership as unknown as { assessment: string }).assessment;
      expect(OLD_OWNED_LIVE_CODES.has(code)).toBe(true);
    });

    it('CALIBRATION: the real subject reaches the stranded answer on that same input', () => {
      expect(composeGateOwnerBrief(strandedInput).answer).toBe('red-owned-unconfirmed');
    });
  });

  it('P-005: an inconclusive attempt at zero reds is no-verdict, never a manufactured red or green', () => {
    const b = composeGateOwnerBrief({
      ...base,
      consecutiveReds: 0,
      failingTestsMeasured: false,
      failingTestsProvenance: 'not-measured',
      inconclusive: { status: 'repair-in-progress', detail: 'fixer dispatched', observedAtMs: NOW - 5_000 },
    });
    expect(b.answer).toBe('no-verdict');
    expect(b.answer).not.toBe('red-owned-remediating');
    expect(b.mainGreen.value).toBeNull();
    expect(b.whyNot?.inconclusiveStatus).toBe('repair-in-progress');
    expect(b.whyNot?.provenance).toBe('not-measured');
    expect(b.assessment.safeAction).toMatch(/clear the condition/i);
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

  /* ═══════════════════════════════════════════════════════════════════════════════
   * main-green-status-visible-2026-09-03 P-010 — per-leg attestations.
   *
   * The spread was already reported; what it structurally cannot say is WHICH leg is old,
   * which is the question a reader must answer before deciding which half of a mixed brief
   * to believe. The deliberately-wrong control here is the two-hour spread: it must NOT
   * read as `coherent`, and it must NAME the stale leg rather than leave a number to convert.
   * ══════════════════════════════════════════════════════════════════════════════ */

  it('names WHICH leg is stale, not merely that the legs disagree about when', () => {
    const b = composeGateOwnerBrief({
      ...base,
      consecutiveReds: 3,
      failingTests: ['lint:tsc'],
      // The live 2026-09-03 shape: a ~2h-old verdict fused with a live ownership read.
      verdictObservedAtMs: NOW - 7_040_975,
      repairQueue: redQueue({ updatedAtMs: NOW - 60_000 }),
    });
    expect(b.attestations.verdict).toBe('incoherent');
    expect(b.attestations.staleLegs).toEqual(['mainGreen']);
    expect(b.attestations.oldestLeg).toBe('mainGreen');
    // The stale leg is named in prose too — the reader should not have to convert ms.
    expect(b.attestations.summary).toContain('mainGreen');
    // Newest first, so the tail IS the oldest leg.
    expect(b.attestations.legs[0]!.leg).toBe('ownership');
    expect(b.attestations.legs.at(-1)!.leg).toBe('mainGreen');
    expect(b.attestations.legs.at(-1)!.stale).toBe(true);
  });

  it('a brief whose legs were all observed together reads coherent with no stale legs', () => {
    const b = composeGateOwnerBrief({
      ...base,
      consecutiveReds: 3,
      failingTests: ['lint:tsc'],
      verdictObservedAtMs: NOW - 30_000,
      repairQueue: redQueue({ updatedAtMs: NOW - 45_000 }),
    });
    expect(b.attestations.verdict).toBe('coherent');
    expect(b.attestations.staleLegs).toEqual([]);
    expect(b.attestations.legs.every((l) => l.stale === false)).toBe(true);
  });

  /**
   * THE CONTROL THAT MATTERS. Fewer than two stamped legs means there is nothing to
   * compare, and `coherent` there would be a verdict of agreement computed over an empty
   * comparison — the same false-green shape as a count over zero measurements. It must be
   * `not-knowable`, and it must say so.
   */
  it('one stamped leg is NOT-KNOWABLE, never coherent — an empty comparison is not agreement', () => {
    const b = composeGateOwnerBrief({ ...base, verdictObservedAtMs: null });
    // ownership is stamped at `nowMs` by construction; the verdict leg is not.
    expect(b.attestations.legs.map((l) => l.leg)).toEqual(['ownership']);
    expect(b.attestations.spreadMs).toBeNull();
    expect(b.attestations.verdict).toBe('not-knowable');
    expect(b.attestations.summary).toContain('not agreement');
  });

  it('vintageSpreadMs and attestations.spreadMs are ONE derivation, so they cannot drift', () => {
    for (const verdictObservedAtMs of [NOW - 30_000, NOW - 600_000, NOW - 7_040_975, null]) {
      const b = composeGateOwnerBrief({
        ...base,
        consecutiveReds: 3,
        verdictObservedAtMs,
        repairQueue: redQueue({ updatedAtMs: NOW - 60_000 }),
      });
      expect(b.vintageSpreadMs).toBe(b.attestations.spreadMs);
    }
  });

  it('an unstamped leg contributes no attestation — it cannot attest to its own freshness', () => {
    const withQueue = composeGateOwnerBrief({ ...base, consecutiveReds: 3, repairQueue: redQueue() });
    const withoutQueue = composeGateOwnerBrief({ ...base, consecutiveReds: 3, repairQueue: null });
    expect(withQueue.attestations.legs.map((l) => l.leg)).toContain('remediation');
    expect(withoutQueue.attestations.legs.map((l) => l.leg)).not.toContain('remediation');
  });

  it('never claims measurement it does not have: an explicit not-measured list stays labelled', () => {
    const b = composeGateOwnerBrief({
      ...base,
      consecutiveReds: 5,
      failingTests: ['lint:tsc'],
      failingTestsMeasured: false,
      failingTestsProvenance: 'not-measured',
    });
    expect(b.whyNot?.measured).toBe(false);
    expect(b.whyNot?.provenance).toBe('not-measured');
  });

  it('P-005: a carried list remains visible with provenance rather than reading as a fresh measurement', () => {
    const b = composeGateOwnerBrief({
      ...base,
      consecutiveReds: 5,
      failingTests: ['lint:tsc'],
      failingTestsMeasured: null,
      failingTestsProvenance: 'carried',
      inconclusive: { status: 'repair-in-progress', detail: 'fixer dispatched', observedAtMs: NOW - 5_000 },
    });
    expect(b.whyNot).toMatchObject({
      failingLegs: ['lint:tsc'],
      measured: null,
      provenance: 'carried',
    });
  });
});
