import { describe, it, expect } from 'vitest';
import { derivePlanLifecycle, reconcilePlanLifecycle, type PlanItem } from '@papercusp/plan-parser';
import { shouldEvaluateAcceptanceGate } from './agent-tools/plans/set-plan-status';

/**
 * R-4 (P-004 of generic-acceptance-routing-and-live-plan-agent-brief-2026-09-20).
 *
 * THE BAR: "A plan in `awaiting-acceptance` remains there until an explicit shipped
 * transition is requested, so neither a scorecard nor a fully satisfied bar set alone
 * moves it to `shipped`."
 *
 * ITS FALSIFIER, verbatim: "Produce a passing scorecard for a plan in
 * `awaiting-acceptance` without requesting a shipped transition, then read the plan
 * status; a status of `shipped` falsifies R-4 on P-004."
 *
 * WHY THIS IS THE RIGHT PLANE FOR IT. The bar's evidence plane is `tree`, and the
 * property is STRUCTURAL rather than statistical: `shipped` is reachable only by a
 * caller naming it. Two independent mechanisms have to hold, and this file pins both
 * because either one alone is a silent hole:
 *
 *   1. The DERIVATION is report-only. `reconcilePlanLifecycle` returns a `disposition`
 *      about a stored status; it never returns a status and never rewrites one. So a
 *      drained plan with a satisfied acceptance signal is REPORTED as agreed-upon,
 *      not promoted. This is the half that a future "helpfully auto-advance a plan
 *      whose bars all pass" change would break, and it would break silently: the plan
 *      would simply start reading `shipped` to every consumer.
 *   2. The WRITE is gated on an explicit request. `shouldEvaluateAcceptanceGate` runs
 *      the acceptance gate exactly when a caller asks for `shipped`, which is what
 *      makes "requested" the load-bearing word in the bar.
 *
 * FALSIFIABILITY. Every assertion below is PAIRED with a control differing in exactly
 * one input and landing on a DIFFERENT answer, so a constant-return mutant
 * (`disposition: 'agreed'` always, `shouldEvaluateAcceptanceGate: () => true`) fails at
 * least one half of every pair. Asserting only the R-4 direction would pass against a
 * function that ignores its arguments entirely — which is precisely the shape of
 * "the guard rotted" rather than "the property holds".
 */

const item = (id: string, storedStatus: PlanItem['storedStatus']): PlanItem => ({
  id,
  text: `${id} body text`,
  storedStatus,
  importance: 'normal',
  riskTier: null,
  authority: 'system',
  blockedBy: [],
  decisionRefs: [],
  phase: null,
  lineNumber: 1,
  rawLine: `- **${id}** \`${storedStatus}\` ${id} body text`,
});

/** Implementation COMPLETE — the precondition for `awaiting-acceptance`. */
const DRAINED = [item('P-001', 'done'), item('P-002', 'done')];
/** The same plan with one item still live — the one-input control. */
const NOT_DRAINED = [item('P-001', 'done'), item('P-002', 'todo')];

/**
 * The state the falsifier asks us to construct: grading has HAPPENED. `rubricActive:
 * false` on a drained plan is what a completed-and-retired acceptance validation looks
 * like to this layer, i.e. the most ship-ward signal the derivation can be handed.
 */
const GRADED = { acceptance: { rubricActive: false } } as const;

describe('R-4 — awaiting-acceptance is not promoted by evidence alone', () => {
  it('leaves a fully graded, fully drained plan in awaiting-acceptance', () => {
    const derived = derivePlanLifecycle(DRAINED, GRADED);
    const r = reconcilePlanLifecycle('awaiting-acceptance', derived);

    // THE BAR ITSELF: the status the caller stored is the status that comes back.
    expect(r.storedStatus).toBe('awaiting-acceptance');
    expect(r.disposition).toBe('agreed');

    // THE FALSIFIER, asserted structurally rather than by eyeballing one field: no
    // reachable part of the reconciliation may carry the string `shipped`, so a
    // future auto-advance cannot hide in a field this test does not happen to name.
    expect(JSON.stringify(r)).not.toContain('"shipped"');
  });

  it("CONTROL — the same derived lifecycle reports 'shipped' when that is what was STORED", () => {
    // Differs from the case above in exactly one input: the stored status. If this
    // also came back `awaiting-acceptance`, the assertion above would be passing
    // because the function ignores its argument, not because R-4 holds.
    const derived = derivePlanLifecycle(DRAINED, GRADED);
    const r = reconcilePlanLifecycle('shipped', derived);

    expect(r.storedStatus).toBe('shipped');
    expect(r.disposition).toBe('agreed');
  });

  it('CONTROL — a live item contradicts awaiting-acceptance rather than being waved through', () => {
    // Proves the fixture drives real branches: this reconciliation is capable of
    // returning something other than `agreed`, so `agreed` above is a measured
    // verdict and not this function's only possible output.
    const derived = derivePlanLifecycle(NOT_DRAINED, GRADED);
    const r = reconcilePlanLifecycle('awaiting-acceptance', derived);

    expect(r.disposition).toBe('contradicted');
    expect(r.storedStatus).toBe('awaiting-acceptance');
  });
});

describe('R-4 — the shipped write is gated on an EXPLICIT request', () => {
  it('evaluates the acceptance gate only when the caller asks for shipped', () => {
    // "requested" is the load-bearing word in the bar: the gate is what stands
    // between a plan and `shipped`, and it is armed by the request itself.
    expect(shouldEvaluateAcceptanceGate('shipped')).toBe(true);
  });

  it('CONTROL — no other lifecycle transition arms the acceptance gate', () => {
    // Each of these is a real status a caller can request. None of them may drag a
    // plan through the ship gate as a side effect.
    for (const status of ['awaiting-acceptance', 'active', 'ready', 'draft', 'superseded']) {
      expect(shouldEvaluateAcceptanceGate(status), `${status} must not arm the ship gate`).toBe(
        false,
      );
    }
  });

  it('CONTROL — the idempotent shipped->shipped repair pass is not a ship transition', () => {
    // A caller supplying expectedCurrent:'shipped' is repairing an ALREADY-shipped
    // plan, not entering the state, so re-running the gate (and possibly recruiting a
    // grader) for it would be wrong. This is the one carve-out, and pinning it stops
    // a later simplification from collapsing the predicate to `status === 'shipped'`.
    expect(shouldEvaluateAcceptanceGate('shipped', 'shipped')).toBe(false);
  });
});
