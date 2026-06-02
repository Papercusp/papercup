/**
 * Spec for the `destructive-replan → plans:promote` route change
 * (dbos-system-completion-2026-06-01, optional follow-up).
 *
 * The PURE core (`computeDestructiveReplanDiff`) is fully specified + green here.
 * The HANDLER wiring (a `destructive: true` arg on plans:promote that reads the
 * plan's features from PG, calls this diff, and routes deprecations through the
 * canonical feature-state path) is specified as `it.todo` — the executable
 * contract for whoever lands the route, without shipping CI-red tests to the
 * shared tree.
 */
import { describe, it, expect } from 'vitest';
import {
  computeDestructiveReplanDiff,
  decideDestructiveReplan,
  DEFAULT_PROTECTED_STATUSES,
  type ExistingPlanFeature,
} from './destructive-replan';

const feat = (featureId: string, status = 'todo'): ExistingPlanFeature => ({ featureId, status });

describe('computeDestructiveReplanDiff — mint / keep / deprecate partition', () => {
  it('fresh promote (no existing features) → everything mints, nothing to deprecate', () => {
    const d = computeDestructiveReplanDiff(['F-1', 'F-2', 'F-3'], []);
    expect(d.toMint).toEqual(['F-1', 'F-2', 'F-3']);
    expect(d.toKeep).toEqual([]);
    expect(d.toDeprecate).toEqual([]);
    expect(d.unsafeEmptyReplan).toBe(false);
  });

  it('idempotent re-promote (plan set == harness set) → all keep, no mint, no deprecate', () => {
    const existing = [feat('F-1'), feat('F-2')];
    const d = computeDestructiveReplanDiff(['F-1', 'F-2'], existing);
    expect(d.toMint).toEqual([]);
    expect(d.toKeep).toEqual(['F-1', 'F-2']);
    expect(d.toDeprecate).toEqual([]);
  });

  it('a feature added to the plan mints; the rest keep', () => {
    const d = computeDestructiveReplanDiff(['F-1', 'F-2', 'F-3'], [feat('F-1'), feat('F-2')]);
    expect(d.toMint).toEqual(['F-3']);
    expect(d.toKeep).toEqual(['F-1', 'F-2']);
    expect(d.toDeprecate).toEqual([]);
  });

  it('THE DESTRUCTIVE CASE: a feature dropped from the plan is deprecated (additive promote would not)', () => {
    // Harness has F-1,F-2,F-3 from the plan; the plan now only declares F-1,F-2.
    const d = computeDestructiveReplanDiff(['F-1', 'F-2'], [feat('F-1'), feat('F-2'), feat('F-3')]);
    expect(d.toDeprecate).toEqual(['F-3']);
    expect(d.toKeep).toEqual(['F-1', 'F-2']);
    expect(d.toMint).toEqual([]);
  });

  it('mints new + deprecates dropped in a single replan', () => {
    // Plan: F-1 (kept), F-9 (new). Harness: F-1, F-2 (dropped), F-3 (dropped).
    const d = computeDestructiveReplanDiff(['F-1', 'F-9'], [feat('F-1'), feat('F-2'), feat('F-3')]);
    expect(d.toMint).toEqual(['F-9']);
    expect(d.toKeep).toEqual(['F-1']);
    expect(d.toDeprecate).toEqual(['F-2', 'F-3']);
  });

  it('an already-deprecated dropped feature is a no-op (not re-deprecated)', () => {
    const d = computeDestructiveReplanDiff(['F-1'], [feat('F-1'), feat('F-2', 'deprecated')]);
    expect(d.toDeprecate).toEqual([]);
    expect(d.protectedFromDeprecation).toEqual([]);
  });
});

describe('computeDestructiveReplanDiff — safety: protected statuses (the lost-work guard)', () => {
  it('NEVER auto-deprecates passed work dropped from the plan — surfaces it as protected', () => {
    const d = computeDestructiveReplanDiff(['F-1'], [feat('F-1'), feat('F-2', 'passed')]);
    expect(d.toDeprecate).toEqual([]);
    expect(d.protectedFromDeprecation).toEqual(['F-2']);
  });

  it('NEVER auto-deprecates in_progress work dropped from the plan', () => {
    const d = computeDestructiveReplanDiff(['F-1'], [feat('F-1'), feat('F-7', 'in_progress')]);
    expect(d.toDeprecate).toEqual([]);
    expect(d.protectedFromDeprecation).toEqual(['F-7']);
  });

  it('default protected set is exactly {passed, in_progress}', () => {
    expect([...DEFAULT_PROTECTED_STATUSES].sort()).toEqual(['in_progress', 'passed']);
  });

  it('deprecates dropped todo / failing features (no real work to lose)', () => {
    const d = computeDestructiveReplanDiff(
      ['F-1'],
      [feat('F-1'), feat('F-2', 'todo'), feat('F-3', 'failing')],
    );
    expect(d.toDeprecate).toEqual(['F-2', 'F-3']);
    expect(d.protectedFromDeprecation).toEqual([]);
  });

  it('an explicit force path (protectStatuses: []) may deprecate even passed work', () => {
    const d = computeDestructiveReplanDiff(['F-1'], [feat('F-1'), feat('F-2', 'passed')], {
      protectStatuses: [],
    });
    expect(d.toDeprecate).toEqual(['F-2']);
    expect(d.protectedFromDeprecation).toEqual([]);
  });
});

describe('computeDestructiveReplanDiff — safety: policy-less / empty-plan wipe guard', () => {
  it('empty plan set WITH existing features → unsafeEmptyReplan (would wipe the whole queue)', () => {
    const d = computeDestructiveReplanDiff([], [feat('F-1'), feat('F-2')]);
    expect(d.unsafeEmptyReplan).toBe(true);
    // The dangerous deletions are still computed (so a forced caller can see them)…
    expect(d.toDeprecate).toEqual(['F-1', 'F-2']);
    // …but the flag is the signal for the handler to fail closed.
  });

  it('empty plan set with NO existing features → safe (nothing to wipe)', () => {
    const d = computeDestructiveReplanDiff([], []);
    expect(d.unsafeEmptyReplan).toBe(false);
    expect(d.toDeprecate).toEqual([]);
  });

  it('a non-empty plan set is never flagged as an empty-wipe', () => {
    const d = computeDestructiveReplanDiff(['F-1'], [feat('F-2')]);
    expect(d.unsafeEmptyReplan).toBe(false);
  });
});

describe('computeDestructiveReplanDiff — input normalization', () => {
  it('de-dups + drops falsy plan ids, preserving first-seen order', () => {
    const d = computeDestructiveReplanDiff(['F-2', 'F-1', 'F-2', '', 'F-1'], []);
    expect(d.toMint).toEqual(['F-2', 'F-1']);
  });

  it('features sourced from OTHER plans are the caller’s concern — only the passed existing set is eligible', () => {
    // The helper deprecates only within the existing set it is given; the handler
    // is responsible for scoping that set to THIS plan (source_plan = slug).
    const d = computeDestructiveReplanDiff(['F-1'], [feat('F-1')]);
    expect(d.toDeprecate).toEqual([]);
  });
});

describe('decideDestructiveReplan — fail-closed / force policy', () => {
  it('applies a safe non-empty diff, passing through toDeprecate + protectedHeld', () => {
    const diff = computeDestructiveReplanDiff(['F-1'], [feat('F-1'), feat('F-2'), feat('F-9', 'passed')]);
    const dec = decideDestructiveReplan(diff);
    expect(dec.action).toBe('apply');
    expect(dec.toDeprecate).toEqual(['F-2']);
    expect(dec.protectedHeld).toEqual(['F-9']); // passed → held back, reported
  });

  it('REFUSES unsafe_empty_replan (empty plan + existing features) when not forced', () => {
    const diff = computeDestructiveReplanDiff([], [feat('F-1'), feat('F-2')]);
    const dec = decideDestructiveReplan(diff);
    expect(dec.action).toBe('refuse');
    expect(dec.refusalCode).toBe('unsafe_empty_replan');
    expect(dec.toDeprecate).toEqual([]); // refuse deprecates nothing
    expect(dec.refusalDetail).toMatch(/force/);
  });

  it('force overrides the empty-wipe refusal → applies (deprecating everything)', () => {
    // force ⇒ the diff is computed with protectStatuses:[] (nothing protected).
    const diff = computeDestructiveReplanDiff([], [feat('F-1'), feat('F-2', 'passed')], {
      protectStatuses: [],
    });
    const dec = decideDestructiveReplan(diff, { force: true });
    expect(dec.action).toBe('apply');
    expect(dec.toDeprecate).toEqual(['F-1', 'F-2']);
    expect(dec.protectedHeld).toEqual([]);
  });

  it('a non-empty plan is never refused, even with protected drops', () => {
    const diff = computeDestructiveReplanDiff(['F-1'], [feat('F-1'), feat('F-2', 'in_progress')]);
    const dec = decideDestructiveReplan(diff);
    expect(dec.action).toBe('apply');
    expect(dec.toDeprecate).toEqual([]); // F-2 is in_progress → protected
    expect(dec.protectedHeld).toEqual(['F-2']);
  });
});

// ── Handler route-change contract (plans:promote `destructive: true`) ──────────
// The pure core (diff + decision) above is fully green. These remaining specs
// are PG/loopback integration (a live harness schema + the features import/PATCH
// routes) — kept as `todo` rather than shipping a heavy integration test on the
// shared tree. The handler in promote.ts implements all of them
// (runDestructiveReplan): scoped source_plan read, importRes.ids diff, canonical
// PATCH deprecations, fail-closed refuse, force overrides, preview-without-mutate.
describe('plans:promote destructive mode — PG/loopback integration (TODO: integration test)', () => {
  it.todo('apply=false preview reports the diff (read-only — no import, no PATCH) using supplied feature_ids');
  it.todo('apply diffs importRes.ids against the source_plan=slug read and PATCHes drops to status=deprecated');
  it.todo('scopes the existing-feature read to (workspace_id, source_plan_slug, harness_slug) — never other plans');
  it.todo('is idempotent: a second destructive promote of the same plan deprecates nothing new');
});
