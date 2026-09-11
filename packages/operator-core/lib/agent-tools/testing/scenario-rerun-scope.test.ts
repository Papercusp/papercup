import { describe, expect, it } from 'vitest';

import { resolveScenarioRerunScope } from './scenario-rerun-scope';

/**
 * SPEC-P006-FAILED-SCENARIO-RERUN@1, at the decision itself.
 *
 * `evidence.test.ts` exercises this through `finishTestEvidence` with a faked ledger, which
 * is the behaviour that ships. These cases pin the DECISION in isolation, where each arm is
 * one changed variable rather than a whole bound row — so a future edit that happens to
 * settle the right phase for the wrong reason still fails here.
 */
describe('resolveScenarioRerunScope', () => {
  const MATRIX = ['boot', 'retry', 'teardown', 'recover'];
  const current = { sourceFingerprint: 'src-1', testFingerprint: 'test-1' };
  const base = { scenarioIds: MATRIX, testNamePattern: 'recover', current };

  // --- the question does not arise -------------------------------------------------
  // These return null rather than a permissive verdict: nothing is being carried, so
  // there is nothing to refuse. Widening either would tax the ordinary cheap rerun.

  it('does not arise for an unfiltered run — it re-measures the matrix itself', () => {
    expect(resolveScenarioRerunScope({ ...base, testNamePattern: undefined })).toBeNull();
    expect(resolveScenarioRerunScope({ ...base, testNamePattern: null })).toBeNull();
    // Whitespace is not a filter; vitest would run everything.
    expect(resolveScenarioRerunScope({ ...base, testNamePattern: '   ' })).toBeNull();
  });

  it('does not arise for a binding with no remaining matrix', () => {
    expect(resolveScenarioRerunScope({ ...base, scenarioIds: ['only'] })).toBeNull();
    expect(resolveScenarioRerunScope({ ...base, scenarioIds: [] })).toBeNull();
    expect(resolveScenarioRerunScope({ ...base, scenarioIds: undefined })).toBeNull();
    // Blank ids are not members of a matrix.
    expect(resolveScenarioRerunScope({ ...base, scenarioIds: ['only', '  '] })).toBeNull();
  });

  // --- the two arms of the falsifier ------------------------------------------------

  it('ARM 1 — carries the remaining matrix while the sibling fingerprints are current', () => {
    expect(resolveScenarioRerunScope({ ...base, priorEvidence: { ...current } })).toEqual({
      scope: 'failed-scenario', reason: 'sibling-evidence-current', carried: MATRIX, stale: [],
    });
  });

  it('ARM 2 — refuses the carry on a stale SOURCE fingerprint', () => {
    expect(resolveScenarioRerunScope({
      ...base, priorEvidence: { sourceFingerprint: 'src-0', testFingerprint: 'test-1' },
    })).toEqual({ scope: 'full-matrix', reason: 'stale-sibling-evidence', carried: [], stale: ['source'] });
  });

  it('ARM 2 — refuses the carry on a stale TEST fingerprint too', () => {
    // The tests themselves moving invalidates the siblings' proof just as the source does.
    expect(resolveScenarioRerunScope({
      ...base, priorEvidence: { sourceFingerprint: 'src-1', testFingerprint: 'test-0' },
    })).toEqual({ scope: 'full-matrix', reason: 'stale-sibling-evidence', carried: [], stale: ['test'] });
  });

  it('names every dimension that moved, not just the first', () => {
    expect(resolveScenarioRerunScope({
      ...base, priorEvidence: { sourceFingerprint: 'src-0', testFingerprint: 'test-0' },
    })!.stale).toEqual(['source', 'test']);
  });

  // --- absence is not currency -------------------------------------------------------

  it('refuses a carry when no sibling evidence was ever recorded', () => {
    for (const priorEvidence of [undefined, null, {}, { sourceFingerprint: '' }, { sourceFingerprint: null }]) {
      expect(resolveScenarioRerunScope({ ...base, priorEvidence })).toMatchObject({
        scope: 'full-matrix', reason: 'no-sibling-evidence', carried: [],
      });
    }
  });

  it('treats a one-sided missing test fingerprint as stale, never as comparable', () => {
    // Absent-on-one-side is the case a `!=` over two optionals silently forgives.
    expect(resolveScenarioRerunScope({
      ...base, priorEvidence: { sourceFingerprint: 'src-1' },
    })!.stale).toEqual(['test']);
    expect(resolveScenarioRerunScope({
      ...base, current: { sourceFingerprint: 'src-1' },
      priorEvidence: { sourceFingerprint: 'src-1', testFingerprint: 'test-1' },
    })!.stale).toEqual(['test']);
  });

  it('never reports carried ids alongside a refusal', () => {
    // `carried` is what the run leans on; a refusal leans on nothing. Keeping these
    // coupled stops a caller reading a refusal's id list as licence to carry them.
    const refusals = [
      resolveScenarioRerunScope({ ...base, priorEvidence: { sourceFingerprint: 'src-0' } }),
      resolveScenarioRerunScope({ ...base, priorEvidence: null }),
    ];
    for (const verdict of refusals) {
      expect(verdict!.scope).toBe('full-matrix');
      expect(verdict!.carried).toEqual([]);
    }
  });
});
