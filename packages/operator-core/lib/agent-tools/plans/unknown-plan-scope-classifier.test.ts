/**
 * P-014 / EI-19286551248996972 — a registry-read FAULT must never be classified as
 * "this harness has no plans".
 *
 * The incident: `plans:list` returned `ok:true` with `[]` and `plans:get` returned
 * not_found for `papercusp`, while psql held 960 plan rows. The final layer of that
 * wrong answer was a classifier that separated "absent" from "unreadable" by matching
 * words in an error message. Those two conditions can render the same words, so no
 * string test can separate them — the distinction has to be typed at the source.
 *
 * `isUnknownPlanScopeError` is that typed boundary. These tests pin both directions:
 * a genuine absence must still classify as absence (or plans:list starts throwing on
 * ordinary stale-slug reads), and a fault must not, *regardless of how it is spelled*.
 */
import { describe, expect, it } from 'vitest';
import { isUnknownPlanScopeError } from './source';
import { RegistryReadUnavailableError } from '../../harness-core';

/**
 * The pre-fix classifier that shipped inline in plans/list.ts, kept here PERMANENTLY
 * as a deliberately-wrong control. Its job is to fail the leak case below — if it ever
 * starts agreeing with the real predicate on every case, this file has stopped testing
 * anything and the guard is no longer falsifiable.
 */
const HISTORICAL_LOOSE_PATTERN = /not registered|not a Hive home/i;

/** The real messages `resolvePlanScope` throws for the two genuine-absence conditions. */
const ABSENCE_NOT_REGISTERED =
  "resolvePlanScope: harness 'desktop-notes-demo' is not registered in the harness registry " +
  '(harness_shared.harness_registry) or harness_shared.projects in any workspace, so its plan ' +
  "workspace cannot be resolved. Register the harness, or pass an explicit workspaceId.";

const ABSENCE_NOT_HIVE_HOME =
  "resolvePlanScope: plans are Hive-scoped, but 'pot-verify' is not a Hive home and does not " +
  "belong to one in workspace 'papercusp-workspace'.";

describe('isUnknownPlanScopeError — genuine absence still reads as absence (calibration)', () => {
  it('classifies the unregistered-harness throw as an unknown scope', () => {
    expect(isUnknownPlanScopeError(new Error(ABSENCE_NOT_REGISTERED))).toBe(true);
  });

  it('classifies the non-Hive-home throw as an unknown scope (EI-7864)', () => {
    expect(isUnknownPlanScopeError(new Error(ABSENCE_NOT_HIVE_HOME))).toBe(true);
  });
});

describe('isUnknownPlanScopeError — a read FAULT is never an absence', () => {
  it('does not classify RegistryReadUnavailableError as an unknown scope', () => {
    const fault = new RegistryReadUnavailableError('papercusp', new Error('connection terminated'));
    expect(isUnknownPlanScopeError(fault)).toBe(false);
  });

  /**
   * THE LEAK CASE, and the reason the `instanceof` check must run before any text test.
   *
   * RegistryReadUnavailableError appends `Underlying: <cause.message>`, and the cause is
   * whatever the failing registry read threw — text this code does not control. A cause
   * that happens to contain "not registered" makes the fault's full message match a purely
   * textual classifier, which then reports a 960-row harness as empty.
   *
   * The control assertion below proves this is a real escape and not a hypothetical: the
   * historical pattern matches this message. If someone reverts the predicate to a string
   * test, the expectation under it fails.
   */
  it('does not classify a fault whose UNDERLYING cause message says "not registered"', () => {
    const cause = new Error('permission denied for relation harness_registry: role is not registered');
    const fault = new RegistryReadUnavailableError('papercusp', cause);

    // Control: a text-matching classifier IS fooled by this message.
    expect(HISTORICAL_LOOSE_PATTERN.test(fault.message)).toBe(true);

    // The typed predicate is not.
    expect(isUnknownPlanScopeError(fault)).toBe(false);
  });

  it('does not classify a fault whose cause message says "not a Hive home"', () => {
    const cause = new Error('upstream said: target is not a Hive home');
    const fault = new RegistryReadUnavailableError('papercusp', cause);
    expect(HISTORICAL_LOOSE_PATTERN.test(fault.message)).toBe(true);
    expect(isUnknownPlanScopeError(fault)).toBe(false);
  });
});

describe('isUnknownPlanScopeError — unrelated failures stay loud', () => {
  it('does not classify an ordinary DB error as an unknown scope', () => {
    expect(isUnknownPlanScopeError(new Error('connection terminated unexpectedly'))).toBe(false);
  });

  /**
   * The `resolvePlanScope:` anchor. plans/list.ts's inline copy lacked it, so ANY error
   * carrying these words — from any layer — was swallowed into an empty result. Only the
   * function that owns this failure mode gets to declare an absence.
   */
  it('does not classify a foreign error that merely contains the absence wording', () => {
    const foreign = new Error("some other subsystem: widget 'x' is not registered anywhere");
    expect(HISTORICAL_LOOSE_PATTERN.test(foreign.message)).toBe(true);
    expect(isUnknownPlanScopeError(foreign)).toBe(false);
  });

  it('handles non-Error throwables without crashing', () => {
    expect(isUnknownPlanScopeError('a bare string')).toBe(false);
    expect(isUnknownPlanScopeError(null)).toBe(false);
    expect(isUnknownPlanScopeError(undefined)).toBe(false);
  });
});
