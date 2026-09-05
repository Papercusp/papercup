/**
 * Pins the launch-refusal population labels to the constants they mirror
 * (spend-attribution…-2026-09-04 P-004).
 *
 * `REFUSAL_SCOPES.BUDGET_POT` duplicates `GOAL_SPEND_POT_SCOPE`, and
 * `budgetSpendScope` duplicates the two provenance markers from `@papercusp/db-org`,
 * because importing `./goals/spend-rollup` from `goal-launch-settings` would close a
 * runtime cycle (spend-rollup → @papercusp/agent-mcp → goal-launch-settings).
 *
 * The repo's rule for code-describing metadata that cannot be DERIVED is to PIN it,
 * so this file is the divergence check: rename a scope or a marker on one side and
 * this fails, instead of a ceiling refusal quietly labelling a number with a
 * population that no longer exists. A wrong label is worse than no label — it is the
 * failure this whole plan is about, wearing the costume of the fix.
 */
import { describe, expect, it } from 'vitest';
import { GOAL_SPEND_SNAPSHOT_SOURCE, GOAL_SPEND_TICK_SOURCE } from '@papercusp/db-org';
import { GOAL_SPEND_POT_SCOPE } from './goals/spend-rollup';
import { REFUSAL_SCOPES, budgetSpendScope } from './goal-launch-settings';

describe('launch-refusal population labels stay pinned to their sources', () => {
  it('BUDGET_POT is byte-identical to GOAL_SPEND_POT_SCOPE', () => {
    // The load-bearing assertion. These are two literals that must agree; nothing
    // but this test makes them.
    expect(REFUSAL_SCOPES.BUDGET_POT).toBe(GOAL_SPEND_POT_SCOPE);
  });

  it('treats BOTH known provenance markers as pot-scoped', () => {
    // Both writers persist a pot-leg figure: spend-rollup's tick writes
    // `spentCents: rollup.potCents`, and goals:update only accepts a verified pots
    // rollup. Reading the markers from db-org rather than retyping them means a
    // renamed marker fails here instead of silently falling through to UNVERIFIED —
    // which would look like a provenance problem rather than a broken comparison.
    expect(budgetSpendScope(GOAL_SPEND_SNAPSHOT_SOURCE)).toBe(GOAL_SPEND_POT_SCOPE);
    expect(budgetSpendScope(GOAL_SPEND_TICK_SOURCE)).toBe(GOAL_SPEND_POT_SCOPE);
  });

  it('refuses to claim pot provenance for an UNMARKED value', () => {
    // The gate's SELECT filters on nothing, so an unmarked legacy figure reaches the
    // ceiling identically to a rollup-written one. Labelling that as pot-scoped would
    // assert provenance nothing verified.
    expect(budgetSpendScope(null)).toBe(REFUSAL_SCOPES.BUDGET_UNVERIFIED);
    expect(budgetSpendScope('')).toBe(REFUSAL_SCOPES.BUDGET_UNVERIFIED);
    expect(budgetSpendScope('hand-entered-by-someone')).toBe(REFUSAL_SCOPES.BUDGET_UNVERIFIED);
  });

  it('never labels an unverified value with the same string as a verified one', () => {
    // If these two ever collapsed to one value, every assertion above would still
    // pass while the distinction they exist to draw had silently disappeared.
    expect(REFUSAL_SCOPES.BUDGET_UNVERIFIED).not.toBe(REFUSAL_SCOPES.BUDGET_POT);
  });

  it('CONTROL: the pin actually detects a diverged label', () => {
    // The comparison above is only worth having if it FAILS when the literals drift.
    // Proving that by editing the real constant would race git-sync (it sweeps the
    // whole tree on a timer and would commit the mutant), so the control is permanent
    // and synthetic: run the identical comparison against a deliberately-wrong value.
    const drifted = `${GOAL_SPEND_POT_SCOPE}-renamed`;
    expect(drifted).not.toBe(REFUSAL_SCOPES.BUDGET_POT);
  });

  it('CALIBRATION: the labels are non-empty, so the equalities are not vacuous', () => {
    // Two empty strings are equal. Without this, a refactor that emptied both sides
    // would turn the pin into a permanent silent pass.
    expect(GOAL_SPEND_POT_SCOPE.length).toBeGreaterThan(0);
    expect(REFUSAL_SCOPES.BUDGET_UNVERIFIED.length).toBeGreaterThan(0);
    expect(GOAL_SPEND_SNAPSHOT_SOURCE.length).toBeGreaterThan(0);
  });

  it('gives every distinct ceiling its own population label', () => {
    // A shared label between the agent ceilings and the budget ceiling would make the
    // structured field useless for telling them apart.
    const labels = [
      REFUSAL_SCOPES.BUDGET_POT,
      REFUSAL_SCOPES.BUDGET_UNVERIFIED,
      REFUSAL_SCOPES.LIVE_AGENTS_IN_GOAL,
      REFUSAL_SCOPES.LIVE_AGENTS_IN_FLEET,
    ];
    expect(new Set(labels).size).toBe(labels.length);
  });
});
