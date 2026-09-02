/**
 * WIRING test for declared completion claims (EI-22175397357614106).
 *
 * WHY THIS FILE EXISTS, SEPARATELY FROM THE ALGORITHM TESTS.
 *
 * `completionEvidenceFromRecord` is a WHITELIST: it copies named fields off the caller's
 * record and silently drops everything else. When `claims` was first wired in, the
 * evaluator, the finding, the authority downgrade and the caller-facing warning were all
 * implemented and all correct — and the feature was still entirely dead, because this
 * mapping never copied the field. `completionEvidenceForGate?.claims` read `undefined`,
 * so every declared claim went unchecked while the close reported success.
 *
 * That failure is invisible to `completion-claims.test.ts` (19 passing tests against the
 * evaluator) and to `work-item-completion-authority.claim-falsified.test.ts` (8 passing
 * tests against the grade), because both exercise the parts on either SIDE of the break.
 * It is the same "checked zero, therefore green" shape this repo keeps re-encountering:
 * an instrument that measured nothing is indistinguishable from one that found nothing.
 *
 * So these tests assert the PLUMBING, not the algorithm.
 */
import { describe, expect, it } from 'vitest';

import type { CompletionClaim } from '../../completion-claims';
import { completionEvidenceFromRecord } from './complete';

const CLAIM: CompletionClaim = {
  kind: 'string-in-array',
  path: 'libs/papercusp/packages/orchestrator/src/invoke.ts',
  container: 'CORE_MCP_TOOL_NAMES',
  value: 'coord:dispatch',
  expect: 'present',
};

describe('declared claims survive the evidence whitelist', () => {
  it('carries verification.claims through to the gate evidence', () => {
    // The regression under test: this returned evidence WITHOUT `claims`, and nothing
    // downstream could tell that from a close that declared none.
    const evidence = completionEvidenceFromRecord({
      summary: 'did the thing',
      verification: { verifiedHow: 'unit', testsRun: 'x', testResult: 'green', claims: [CLAIM] },
    } as never);
    expect(evidence?.claims).toHaveLength(1);
    expect(evidence?.claims?.[0]).toMatchObject({ value: 'coord:dispatch', container: 'CORE_MCP_TOOL_NAMES' });
  });

  it('CONTROL — a record declaring no claims yields no claims key', () => {
    // Pairs with the above so a degenerate "always populate claims" mapping fails here.
    const evidence = completionEvidenceFromRecord({
      summary: 'did the thing',
      verification: { verifiedHow: 'unit', testsRun: 'x', testResult: 'green' },
    } as never);
    expect(evidence?.claims).toBeUndefined();
  });

  it('an EMPTY claims array does not create the key', () => {
    const evidence = completionEvidenceFromRecord({
      summary: 'did the thing',
      verification: { verifiedHow: 'unit', testsRun: 'x', testResult: 'green', claims: [] },
    } as never);
    expect(evidence?.claims).toBeUndefined();
  });

  it('claims alone are enough to produce an evidence object', () => {
    // `completionEvidenceFromRecord` returns undefined for an empty object, so a close
    // whose ONLY structured field is a claim must still reach the evaluator.
    const evidence = completionEvidenceFromRecord({ summary: 's', verification: { claims: [CLAIM] } } as never);
    expect(evidence).toBeDefined();
    expect(evidence?.claims).toHaveLength(1);
  });

  it('FALSIFIABILITY CONTROL — the pre-fix whitelist fails these very assertions', () => {
    // CLAUDE.md § "Proving a guard is falsifiable", MODULE tier: keep the deliberately
    // wrong implementation permanently here rather than mutating the shared tree (the
    // sweep can commit an in-tree mutant even when nothing goes wrong).
    //
    // This is the mapping EXACTLY as it stood before EI-22175397357614106 — every field
    // the real function copies except `claims`. It is not hypothetical: this is the code
    // that shipped the evaluator, the finding, the downgrade and the warning as dead code.
    const preFixWhitelist = (rec: {
      verification?: { verifiedHow?: string; testsRun?: string; testResult?: string; claims?: unknown[] };
    }): Record<string, unknown> | undefined => {
      const nested = rec.verification ?? {};
      const evidence: Record<string, unknown> = {};
      if (nested.testsRun?.trim()) evidence.testsRun = nested.testsRun;
      if (nested.testResult?.trim()) evidence.testResult = nested.testResult;
      if (nested.verifiedHow) evidence.verifiedHow = nested.verifiedHow;
      // …and no `claims` line. That single omission is the whole defect.
      return Object.keys(evidence).length > 0 ? evidence : undefined;
    };

    const record = {
      verification: { verifiedHow: 'unit', testsRun: 'x', testResult: 'green', claims: [CLAIM] },
    };

    // The control DROPS the claims — so the primary assertion of this file fails against it.
    expect(preFixWhitelist(record)?.claims).toBeUndefined();
    // …while the real subject carries them. If the two ever agree, this file is asserting
    // nothing and the feature is dead again.
    expect(completionEvidenceFromRecord(record as never)?.claims).toHaveLength(1);
  });

  it('is canonical-nested only — a top-level `claims` alias is deliberately NOT read', () => {
    // Documented intent, pinned so it cannot become an accident later: the legacy
    // top-level aliases are carry-over, and this field mints no new one.
    const evidence = completionEvidenceFromRecord({
      summary: 's',
      verification: { verifiedHow: 'unit', testsRun: 'x', testResult: 'green' },
      claims: [CLAIM],
    } as never);
    expect(evidence?.claims).toBeUndefined();
  });
});
