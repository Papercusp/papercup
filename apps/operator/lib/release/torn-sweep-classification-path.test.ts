/**
 * Plan `gate-resilience-vs-torn-git-sync-sweeps-retry-failing-files-2026-08-14`, P-006 — the
 * guard test for the torn-sweep path. READ D-002 BEFORE CHANGING ANYTHING HERE: the verdict
 * downgrade, the streak-carry and the classifier itself all SHIPPED (WI-39450 + WI-41141).
 * Nothing in this file implements gate behaviour; it guards the SEAM between the two halves,
 * which is the one thing no existing suite covers.
 *
 * ## Why a seam test earns its place
 *
 *  - `green-checkpoint.test.ts` exercises `classifyRedAgainstTip` ALONE — producer side.
 *  - `release-actions.gate-health.test.ts` exercises `trackGateStall` with a HAND-WRITTEN
 *    `{ classification: 'stale-candidate' }` literal — consumer side, classification ASSUMED.
 *
 * So both suites can be green while the two disagree. Drift the classifier's vocabulary, or
 * narrow what `isProvenStaleCandidate` admits, and a real torn sweep would advance the red
 * streak again — the run-9 regression, silently reintroduced, with every existing test passing.
 * These tests are the only place a torn-sweep FIXTURE is run from the producer into the
 * consumer's own predicates.
 *
 * ## The falsifiability control is PERMANENT and lives in this file
 *
 * Per the repo's mutation-probe guidance, a guard for an importable module proves it can fail by
 * keeping a deliberately-different control in the test file — never by mutating the shared tree.
 * `genuinelyBroken()` is the SAME fixture with the tip re-run failing, and every assertion below
 * is repeated against it with the opposite expectation. If the seam ever collapses to "everything
 * is stale" (or "everything is red"), one of the two blocks fails. `describe('the discriminator
 * …')` is the calibration: it pins that the two fixtures differ in exactly one input.
 */

import { describe, expect, it } from 'vitest';
import { classifyRedAgainstTip } from './green-checkpoint';
import {
  buildTornSweepAnnouncement,
  classifyGateStallStatus,
  isProvenStaleCandidate,
} from '@papercusp/operator-core/lib/harness/routines/release-actions';

const CANDIDATE = '1a9e8a1f0000000000000000000000000000abcd';
const TIP = '9f7c3d2e1111111111111111111111111111beef';

/**
 * The run-9 shape (D-002): a git-sync sweep landed test files whose assertions describe behaviour
 * whose implementation had not been committed yet, so the gate cut a candidate containing the
 * assertions WITHOUT their implementation — which arrives one sha later at TIP. The file
 * identities are irrelevant to the property; the shape is what matters: named failing test files
 * that PASS when re-run at the newer tip.
 */
const TORN_FILES = [
  'packages/operator-core/lib/harness/routines/release-actions.gate-health.test.ts',
  'packages/operator-core/lib/harness/routines/release-actions.torn-sweep.test.ts',
  'apps/operator/lib/release/green-checkpoint.test.ts',
];

type Triage = ReturnType<typeof classifyRedAgainstTip>;

/** The fixture. `tipPasses` is the ONLY thing the control varies (see the calibration block). */
function classifyFixture(
  tipPasses: boolean,
  overrides: Partial<Parameters<typeof classifyRedAgainstTip>[0]> = {},
): Triage {
  return classifyRedAgainstTip({
    candidate: CANDIDATE,
    tip: TIP,
    failingTests: [...TORN_FILES],
    tipRetest: { ran: true, pass: tipPasses },
    refireAttempts: 0,
    maxRefires: 2,
    ...overrides,
  });
}

/** The torn sweep: every named file passes when re-run at the newer tip. */
const tornSweep = (overrides?: Partial<Parameters<typeof classifyRedAgainstTip>[0]>): Triage =>
  classifyFixture(true, overrides);

/** THE PERMANENT CONTROL: same candidate, same files — but the group re-run at tip still fails. */
const genuinelyBroken = (overrides?: Partial<Parameters<typeof classifyRedAgainstTip>[0]>): Triage =>
  classifyFixture(false, overrides);

/**
 * The production adapter, mirrored exactly — green-checkpoint.ts builds the object the writer
 * receives as `{ ...verdict, tip }` (the `retriage = { ...verdict, tip }` assignment on the
 * re-triage path). Nothing is re-typed by hand here on purpose: the whole point is that the
 * classifier's OWN output is what reaches the consumer.
 */
function asRetriage(v: Triage) {
  return { ...v, tip: TIP };
}

const announce = (v: Triage) =>
  buildTornSweepAnnouncement({
    installSlug: 'papercusp',
    candidate: CANDIDATE,
    failingTests: TORN_FILES,
    retriage: asRetriage(v),
    runId: 'run-9',
  });

describe('P-006: a torn-sweep candidate records stale-candidate with NO red increment', () => {
  it('the classifier calls the run-9 fixture stale, not red', () => {
    const v = tornSweep();
    expect(v.classification).toBe('stale-candidate');
    expect(v.detail).toMatch(/PASS at tip/);
  });

  it('⭐ the verdict the classifier actually produces is one the streak-carry ADMITS', () => {
    // The seam. `isProvenStaleCandidate` is the writer's admitting predicate; feeding it a
    // hand-written literal (as the consumer suite must) cannot catch a producer-side drift.
    expect(isProvenStaleCandidate(asRetriage(tornSweep()))).toBe(true);
  });

  it('⭐ and that routes the tick to record-only — the class whose entire meaning is "do not increment"', () => {
    // `trackGateStall` derives `recordOnly` from exactly this value, and `carryStreak` from
    // `recordOnly`; the arithmetic itself is pinned in release-actions.gate-health.test.ts.
    expect(classifyGateStallStatus('not-green', false, asRetriage(tornSweep()))).toBe('record-only');
  });

  it('announces the sweep, naming the files and the sha range that healed them', () => {
    const a = announce(tornSweep());
    expect(a).not.toBeNull();
    expect(a!.payload).toMatchObject({
      shaRange: '1a9e8a1f0000..9f7c3d2e1111',
      fileCount: TORN_FILES.length,
      classification: 'stale-candidate',
      streakAdvanced: false,
    });
  });

  it('still records when the rescue was blocked by the DEADLINE — the measured run-9 failure mode', () => {
    // WI-39450 run 9 was `classification=stale-candidate refireBlockedBy=deadline`: the gate had
    // PROVED the files were healed and was then denied the refire. A blocked rescue must not
    // downgrade the proof — that conflation is what P-004 exists to keep from returning.
    const v = tornSweep({ deadlineExceeded: true });
    expect(v.classification).toBe('stale-candidate');
    expect(v.refireBlockedBy).toBe('deadline');
    expect(v.autoRefire).toBe(false);
    expect(isProvenStaleCandidate(asRetriage(v))).toBe(true);
    expect(classifyGateStallStatus('not-green', false, asRetriage(v))).toBe('record-only');
  });

  it('but a CHARGED-BUDGET exhaustion is deliberately NOT admitted — the same red survived every rescue', () => {
    // The one exclusion in `isProvenStaleCandidate`. Pinned here because it is the difference
    // between "the tree healed" and "we gave up", and both arrive as `stale-candidate`.
    const v = tornSweep({ refireAttempts: 2, maxRefires: 2 });
    expect(v.classification).toBe('stale-candidate');
    expect(v.refireBlockedBy).toBe('charged-budget');
    expect(isProvenStaleCandidate(asRetriage(v))).toBe(false);
    expect(classifyGateStallStatus('not-green', false, asRetriage(v))).toBe('red');
  });
});

describe('P-006 falsifiability control: the same fixture still failing at tip keeps the RED path', () => {
  it('the classifier calls it a real red', () => {
    expect(genuinelyBroken().classification).toBe('real-red');
  });

  it('⭐ record-only is NOT admitted — the streak must advance', () => {
    const v = genuinelyBroken();
    expect(isProvenStaleCandidate(asRetriage(v))).toBe(false);
    expect(classifyGateStallStatus('not-green', false, asRetriage(v))).toBe('red');
  });

  it('and nothing is announced — a genuine red is not a torn sweep', () => {
    expect(announce(genuinelyBroken())).toBeNull();
  });

  it('a red the gate could not measure at tip stays a red, and stays silent', () => {
    // `unknown` is the third arm: no tip, no named files, or no re-run. It must never be
    // absorbed — an UNMEASURED red is not a proven-stale one.
    for (const v of [
      classifyRedAgainstTip({
        candidate: CANDIDATE,
        tip: null,
        failingTests: [...TORN_FILES],
        tipRetest: { ran: true, pass: true },
        refireAttempts: 0,
        maxRefires: 2,
      }),
      classifyFixture(true, { tipRetest: { ran: false, pass: false } }),
      classifyFixture(true, { failingTests: [] }),
    ]) {
      // Passed bare, not via asRetriage(): `GateStallRetriage` is deliberately narrower than the
      // object the writer receives — it declares no `tip` at all, because these two predicates
      // never read one. The classifier's verdict alone is what they consume.
      expect(v.classification).not.toBe('stale-candidate');
      expect(isProvenStaleCandidate(v)).toBe(false);
      expect(classifyGateStallStatus('not-green', false, v)).toBe('red');
      expect(announce(v)).toBeNull();
    }
  });
});

describe('the discriminator is the tip re-run, and only the tip re-run (calibration)', () => {
  it('the two fixtures differ in exactly one input and land on opposite verdicts', () => {
    // Without this, a seam that had collapsed to a constant could still satisfy one block above
    // while the other silently stopped measuring anything.
    expect(tornSweep().classification).not.toBe(genuinelyBroken().classification);
    expect(classifyGateStallStatus('not-green', false, asRetriage(tornSweep()))).not.toBe(
      classifyGateStallStatus('not-green', false, asRetriage(genuinelyBroken())),
    );
  });

  it('a green tick is a reset regardless of what the re-triage said', () => {
    // Guards the ordering inside `classifyGateStallStatus`: the stale-candidate branch must not
    // be able to hold a streak open across an actual advance.
    expect(classifyGateStallStatus('advanced', false, asRetriage(tornSweep()))).toBe('reset');
  });
});
