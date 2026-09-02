/**
 * The `completion-claim-falsified` grade (EI-22175397357614106).
 *
 * The gap: every other check in `insufficientEvidenceReason` is a PRESENCE test, so a close
 * whose evidence is present, well-formed and WRONG grades `committed`. These tests pin the
 * falsity half — and, just as importantly, pin that it stays FAIL-OPEN: a claim the server
 * could not decide must leave today's grade exactly as it was.
 *
 * Controls are permanent (CLAUDE.md § "Proving a guard is falsifiable"): each assertion that
 * a finding DOWNGRADES is paired with the same evidence carrying no finding, so a
 * degenerate "always proposed" implementation fails here rather than looking green.
 */
import { describe, expect, it } from 'vitest';

import type { CompletionVerificationEvidence } from './coord-lifecycle/records';
import {
  authorityForCompletion,
  insufficientEvidenceReason,
  type CompletionEvidenceFindings,
} from './work-item-completion-authority';

/** Evidence that grades `committed` on its own — so any downgrade below is the finding's doing. */
const SUFFICIENT: CompletionVerificationEvidence = {
  verifiedHow: 'unit',
  testsRun: 'npm run test:file -- lib/thing.test.ts',
  testResult: '9/9 green',
  filesChanged: ['packages/operator-core/lib/thing.ts'],
};

const falsified = (n = 1): CompletionEvidenceFindings => ({
  claimsFalsified: Array.from({ length: n }, (_, i) => ({
    claim: `{"kind":"string-in-array","value":"coord:dispatch","container":"CORE_${i}"}`,
    reason: `'coord:dispatch' is NOT an element of 'CORE_${i}'`,
  })),
});

describe('completion-claim-falsified', () => {
  it('CONTROL — the same evidence with NO findings grades committed', () => {
    // Without this the downgrade assertions below would pass against an implementation
    // that simply never returns `committed`.
    expect(insufficientEvidenceReason(SUFFICIENT)).toBeUndefined();
    expect(authorityForCompletion(SUFFICIENT)).toBe('committed');
  });

  it('a falsified declared claim downgrades otherwise-sufficient evidence', () => {
    expect(insufficientEvidenceReason(SUFFICIENT, falsified())).toBe('completion-claim-falsified');
    expect(authorityForCompletion(SUFFICIENT, falsified())).toBe('proposed');
  });

  it('an EMPTY claimsFalsified list is not a finding — absence is never judged-guilty', () => {
    // The evaluator returns an empty array when every claim held or was undecidable. That
    // must be indistinguishable from having run no claims at all.
    expect(insufficientEvidenceReason(SUFFICIENT, { claimsFalsified: [] })).toBeUndefined();
    expect(authorityForCompletion(SUFFICIENT, { claimsFalsified: [] })).toBe('committed');
  });

  it('an absent findings object leaves today’s grade untouched (fail-open)', () => {
    expect(authorityForCompletion(SUFFICIENT, {})).toBe('committed');
    expect(authorityForCompletion(SUFFICIENT, undefined)).toBe('committed');
  });

  it('carries every falsified claim, not just the first', () => {
    // The message quotes them all; a finding that silently kept one would under-report.
    const f = falsified(3);
    expect(f.claimsFalsified).toHaveLength(3);
    expect(insufficientEvidenceReason(SUFFICIENT, f)).toBe('completion-claim-falsified');
  });
});

describe('precedence against the neighbouring present-and-wrong checks', () => {
  it('a RED ledgered run outranks it — unfinished work blocks harder than a wrong record', () => {
    const both: CompletionEvidenceFindings = {
      ...falsified(),
      testRunContradictedByLedger: {
        runGroupId: 'rg-1',
        failingFiles: ['lib/a.test.ts'],
        filesInRun: 3,
      },
    };
    expect(insufficientEvidenceReason(SUFFICIENT, both)).toBe('test-result-contradicted-by-run');
  });

  it('it outranks a fabricated path — a false claim about behaviour beats a wrong file list', () => {
    const both: CompletionEvidenceFindings = {
      ...falsified(),
      filesChangedNeverExisted: ['packages/ghost/never.ts'],
    };
    expect(insufficientEvidenceReason(SUFFICIENT, both)).toBe('completion-claim-falsified');
  });

  it('MISSING-FIELD checks still come first — the cheaper repair is reported before this one', () => {
    const noVerifiedHow = { ...SUFFICIENT, verifiedHow: undefined };
    expect(insufficientEvidenceReason(noVerifiedHow, falsified())).toBe('no-verified-how');
  });
});
