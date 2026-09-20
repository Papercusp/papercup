import { describe, expect, it } from 'vitest';
import {
  createFrozenCandidateRepairQueue,
  decideFrozenCandidateRepairQueue,
  type FrozenCandidateRepairPhase,
  type FrozenCandidateRepairQueue,
} from './release/frozen-candidate-repair-queue';
import { REPAIR_HEAD_RESUMING_PHASES, frozenQueueCandidate } from './git-pipeline-position';

/**
 * WI-10002104 — `gate.greenCheckpoint.candidate`'s `judgingSha` must name the sha the gate
 * ACTUALLY materializes for the queue's current phase.
 *
 * Why this guard exists, measured 2026-09-20: `frozenQueueCandidate` returned the IMMUTABLE
 * frozen candidate for every phase but `'blocked'`, while a live run in `ready-to-verify`
 * logged `release checkout ready … detached e6360c1ba375…` — the repairHead. Because
 * `reconcileGateCandidates` is called BEFORE blob containment (deliberately, so the falsifier
 * measures the judged sha), the wrong sha propagated into `judgingContainsPath` as well, so
 * the headline and its own falsifier AGREED and the cell reported
 * `judging-without-current-path`: "do not read this run's verdict as a judgement on your
 * change", stamped `authoritative: true`, about a run judging exactly that change. The cell's
 * stated job in CLAUDE.md is to kill the inverse of that error, so a silent regression here
 * is worse than having no cell at all.
 *
 * The parity assertions below DERIVE the expected sha by calling
 * `decideFrozenCandidateRepairQueue` — the authority on what the next run materializes —
 * rather than restating a phase list this file would then have to keep in sync by hand.
 */

const CANDIDATE = '1111111111111111111111111111111111111111';
const REPAIR_HEAD = '2222222222222222222222222222222222222222';
const BASE = '0000000000000000000000000000000000000000';
const T0 = 1_800_000_000_000;

/**
 * A queue whose `repairHead` DIFFERS from its frozen candidate — the only shape in which the
 * bug is observable. A fixture where the two coincide passes either way, which is exactly how
 * this went unnoticed.
 */
function queueAt(phase: FrozenCandidateRepairPhase): FrozenCandidateRepairQueue {
  const fresh = createFrozenCandidateRepairQueue({
    candidate: CANDIDATE,
    base: BASE,
    failingTests: ['lib/a.test.ts'],
    nowMs: T0,
  });
  return {
    ...fresh,
    phase,
    repairHead: REPAIR_HEAD,
    ...(phase === 'blocked' ? { blockedReason: 'attempts-exhausted' as const } : {}),
  };
}

/** The sha the gate's OWN policy names for this queue, or null when it names none. */
function policyJudgedSha(queue: FrozenCandidateRepairQueue): string | null {
  const decision = decideFrozenCandidateRepairQueue(queue, {
    nowMs: T0 + 1,
    // `ready-to-promote` branches on this; `true` selects the clean `promote-repair` decision.
    stagingContainsRepair: true,
  });
  return 'candidate' in decision && typeof decision.candidate === 'string' ? decision.candidate : null;
}

/**
 * Exhaustive over the phase union BY TYPE: adding a phase to `FrozenCandidateRepairPhase`
 * fails the typecheck here until someone states which sha it judges. That is the whole point —
 * the previous code silently defaulted a new phase to the frozen candidate.
 */
const PHASE_JUDGED_SHA: Record<FrozenCandidateRepairPhase, 'candidate' | 'repairHead' | null> = {
  'ready-to-test': 'candidate',
  // No suite runs while a fixer is awaited (`runSuite: false`), so the judged subject stays
  // the frozen candidate the recorded red was computed on.
  'awaiting-fixer': 'candidate',
  'ready-to-verify': 'repairHead',
  'ready-to-promote': 'repairHead',
  // A blocked queue is awaiting retire or escape: "the next run resumes this" no longer holds,
  // so the honest answer is null and the caller falls back to the probe.
  blocked: null,
};

const EXPECTED_SHA = { candidate: CANDIDATE, repairHead: REPAIR_HEAD } as const;

describe('WI-10002104: judgingSha tracks the gate policy, per phase', () => {
  const phases = Object.keys(PHASE_JUDGED_SHA) as FrozenCandidateRepairPhase[];

  it.each(phases)('phase %s: frozenQueueCandidate returns the declared sha', (phase) => {
    const want = PHASE_JUDGED_SHA[phase];
    expect(frozenQueueCandidate(queueAt(phase))).toBe(want === null ? null : EXPECTED_SHA[want]);
  });

  /**
   * `'blocked'` is the ONE deliberate divergence and is asserted on its own below, not skipped
   * here: its `hold-exhausted` decision still ECHOES the pinned candidate while doing nothing
   * (`runSuite: false`), so a blanket parity assertion would demand a sha for a queue that has
   * stopped being the gate's subject.
   */
  const parityPhases = phases.filter((p) => p !== 'blocked');

  it.each(parityPhases)(
    'phase %s: when the gate policy names a candidate, frozenQueueCandidate AGREES with it',
    (phase) => {
      const fromPolicy = policyJudgedSha(queueAt(phase));
      if (fromPolicy === null) return; // policy names no judged sha for this phase
      expect(frozenQueueCandidate(queueAt(phase))).toBe(fromPolicy);
    },
  );

  it('blocked DIVERGES from the policy pin on purpose — a held queue is no longer the judged subject', () => {
    // The policy still names a candidate in its hold decision, so this divergence is real and
    // must be stated rather than inferred: answering that sha would tell a caller the gate is
    // judging a lineage on which nothing will run until someone retires or escapes it.
    expect(policyJudgedSha(queueAt('blocked'))).toBe(CANDIDATE);
    expect(frozenQueueCandidate(queueAt('blocked'))).toBeNull();
  });

  it('the policy-parity assertion is NOT vacuous — it really does name a sha for the suite-running phases', () => {
    // If the policy stopped naming candidates, every parity case above would early-return and
    // the guard would pass while checking nothing.
    expect(policyJudgedSha(queueAt('ready-to-verify'))).toBe(REPAIR_HEAD);
    expect(policyJudgedSha(queueAt('ready-to-test'))).toBe(CANDIDATE);
    expect(policyJudgedSha(queueAt('ready-to-promote'))).toBe(REPAIR_HEAD);
  });

  it('REGRESSION: ready-to-verify names the repairHead, not the immutable frozen candidate', () => {
    const queue = { ...queueAt('ready-to-verify'), frozenCandidate: CANDIDATE };
    expect(frozenQueueCandidate(queue)).toBe(REPAIR_HEAD);
    expect(frozenQueueCandidate(queue)).not.toBe(CANDIDATE);
  });

  it('CALIBRATION: ready-to-test still names the frozen candidate, so this is not "always repairHead"', () => {
    const queue = { ...queueAt('ready-to-test'), frozenCandidate: CANDIDATE };
    expect(frozenQueueCandidate(queue)).toBe(CANDIDATE);
    expect(frozenQueueCandidate(queue)).not.toBe(REPAIR_HEAD);
  });

  it('prefers frozenCandidate over candidate for the non-resuming phases (unchanged behaviour)', () => {
    const queue = queueAt('awaiting-fixer');
    expect(frozenQueueCandidate({ ...queue, frozenCandidate: BASE })).toBe(BASE);
  });

  it('falls back to the frozen candidate when a fixture carries no repairHead', () => {
    // A phase-appropriate best answer beats returning null and degrading the whole read to the
    // checkout-head probe.
    expect(frozenQueueCandidate({ phase: 'ready-to-verify', candidate: CANDIDATE })).toBe(CANDIDATE);
  });

  it('FALSIFIABLE: the pre-fix implementation fails the property, and agrees where it should', () => {
    /**
     * The exact pre-WI-10002104 body, kept permanently as a control (CLAUDE.md's tier for an
     * imported module — never mutate the shared tree to prove a guard can fail). If someone
     * reverts `frozenQueueCandidate` to phase-blindness, the REGRESSION case above goes red;
     * this case proves that case is discriminating rather than tautological.
     */
    const preFix = (q: { phase?: string | null; frozenCandidate?: string | null; candidate?: string | null }) => {
      if (q.phase === 'blocked') return null;
      const sha = q.frozenCandidate ?? q.candidate ?? null;
      return typeof sha === 'string' && sha.length > 0 ? sha : null;
    };

    const verifying = queueAt('ready-to-verify');
    expect(preFix(verifying)).toBe(CANDIDATE); // the bug: names the abandoned candidate
    expect(frozenQueueCandidate(verifying)).toBe(REPAIR_HEAD); // the fix
    expect(preFix(verifying)).not.toBe(frozenQueueCandidate(verifying));

    // CALIBRATION — the control is not simply wrong everywhere: where the phase does NOT
    // resume repairHead it must agree with the real subject, or the discrimination above
    // would prove nothing about phase-awareness specifically.
    const testing = queueAt('ready-to-test');
    expect(preFix(testing)).toBe(frozenQueueCandidate(testing));
  });

  it('declares exactly the repairHead-resuming phases, and the exported set says so', () => {
    const declared = phases.filter((p) => PHASE_JUDGED_SHA[p] === 'repairHead').sort();
    expect([...REPAIR_HEAD_RESUMING_PHASES].sort()).toEqual(declared);
  });
});
