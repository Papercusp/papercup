/**
 * WIRING test for the CLOSE-TIME claim baseline (WI-2142447).
 *
 * The sibling `complete.claims-wiring.test.ts` records why a file like this exists at all:
 * when `claims` first landed, the evaluator, the finding, the authority downgrade and the
 * caller-facing warning were all implemented and all correct, and the feature was entirely
 * dead because one mapping never copied the field. Every test on either SIDE of that break
 * passed. That is the "checked zero, therefore green" shape — an instrument that measured
 * nothing is indistinguishable from one that found nothing.
 *
 * The baseline is one link further down the same chain and fails the same way: if it is
 * never persisted, the post-close sweep reads `undefined` for every close, classifies every
 * claim `falsified-unbaselined` or `indeterminate`, and therefore reports ZERO regressions
 * forever — a permanently clean audit bucket that has never judged anything. No test of the
 * classifier or of the sweep can see that, because both are correct.
 *
 * So these tests assert the PLUMBING.
 */
import { describe, expect, it } from 'vitest';

import type { CompletionClaim, CompletionClaimsReport } from '../../completion-claims';
import type { PersistedCompletionEvidence } from '../../coord-lifecycle/records';
import { withClaimBaseline } from './complete';

const CLAIM: CompletionClaim = {
  kind: 'string-in-array',
  path: 'libs/papercusp/packages/orchestrator/src/invoke.ts',
  container: 'CORE_MCP_TOOL_NAMES',
  value: 'coord:dispatch',
  expect: 'present',
};

const AT = '2026-09-02T21:00:00.000Z';

function reportOf(verdict: 'holds' | 'falsified' | 'unevaluatable'): CompletionClaimsReport {
  return {
    results: [{ claim: CLAIM, verdict, reason: `it was ${verdict}` }],
    held: verdict === 'holds' ? 1 : 0,
    falsified: verdict === 'falsified' ? 1 : 0,
    unevaluatable: verdict === 'unevaluatable' ? 1 : 0,
    anyFalsified: verdict === 'falsified',
  };
}

const EVIDENCE: PersistedCompletionEvidence = { verifiedHow: 'unit', testResult: 'green', claims: [CLAIM] };

describe('the close-time claim baseline reaches the persisted record', () => {
  it('carries the verdicts onto the evidence that gets written', () => {
    // The regression under test: this returned evidence WITHOUT `claimVerdicts`, and
    // nothing downstream could tell that from a close whose claims were never evaluated.
    const out = withClaimBaseline(EVIDENCE, reportOf('holds'), AT);
    expect(out?.claimVerdicts?.at).toBe(AT);
    expect(out?.claimVerdicts?.entries).toHaveLength(1);
    expect(out?.claimVerdicts?.entries[0]).toMatchObject({ verdict: 'holds' });
    expect(out?.claimVerdicts?.entries[0].claim).toMatchObject({ value: 'coord:dispatch' });
  });

  it('records a FALSIFIED close-time verdict too, not only the passing ones', () => {
    // Load-bearing: without the falsified verdicts on the record, the sweep cannot tell a
    // claim that was ALREADY false at close (already reported, already graded) from one
    // that has since gone false, and would re-file the former as a fresh staleness finding.
    const out = withClaimBaseline(EVIDENCE, reportOf('falsified'), AT);
    expect(out?.claimVerdicts?.entries[0].verdict).toBe('falsified');
  });

  it('records an UNEVALUATABLE verdict rather than omitting the claim', () => {
    // Omitting it would be indistinguishable from "no baseline for this claim", which is a
    // materially different state — absence of judgement must be recorded as such.
    const out = withClaimBaseline(EVIDENCE, reportOf('unevaluatable'), AT);
    expect(out?.claimVerdicts?.entries[0].verdict).toBe('unevaluatable');
  });

  it('leaves every other evidence field untouched', () => {
    const out = withClaimBaseline(EVIDENCE, reportOf('holds'), AT);
    expect(out).toMatchObject({ verifiedHow: 'unit', testResult: 'green' });
    expect(out?.claims).toHaveLength(1);
  });

  it('CONTROL — a close that evaluated no claims gets no claimVerdicts key', () => {
    // Pairs with the above so a degenerate "always attach a baseline" fold fails here.
    expect(withClaimBaseline(EVIDENCE, undefined, AT)?.claimVerdicts).toBeUndefined();
  });

  it('CONTROL — an EMPTY verdict report gets no claimVerdicts key', () => {
    const empty: CompletionClaimsReport = {
      results: [],
      held: 0,
      falsified: 0,
      unevaluatable: 0,
      anyFalsified: false,
    };
    expect(withClaimBaseline(EVIDENCE, empty, AT)?.claimVerdicts).toBeUndefined();
  });

  it('never conjures an evidence object for a close that carries no record at all', () => {
    // The persist site's deliberate invariant: a close with nothing on it must not gain an
    // `_completionEvidence` object whose only key came from the server, which a later
    // reader could mistake for caller-supplied proof.
    expect(withClaimBaseline(undefined, reportOf('holds'), AT)).toBeUndefined();
  });

  it('does not mutate the evidence it was handed', () => {
    const original: PersistedCompletionEvidence = { verifiedHow: 'unit', claims: [CLAIM] };
    withClaimBaseline(original, reportOf('holds'), AT);
    expect(original.claimVerdicts).toBeUndefined();
  });
});
