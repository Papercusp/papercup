/**
 * WI-10006745 — a mutation binding is clause-bound only when its measured failed case is declared
 * in the same-clause test binding's adequacy.testCases. The measured case comes from the ledger
 * reporter's tail, which writes `<case full name>: <message>` per failed case
 * (libs/test-config admin-test-runs-reporter `buildOutputTail`). The first implementation split
 * that tail on ' — ', which matched no reporter output and, when a describe title itself held an
 * em dash, returned a truncated prefix — so no mutation proof could ever pass.
 */
import { describe, expect, it } from 'vitest';
import { mutationFailureLines } from './spec-evidence-store';
import { mutationMeasuredFailedCase, type SpecEvidenceForAdequacy } from './spec-test-adequacy';

// Shape of live test_run 20842783 (source=mutation-probe, status=fail): two failed cases, the
// describe title containing an em dash, a newline-separated multi-case tail.
const LIVE_TAIL =
  "public target — licensed export > ships the Elastic License 2.0 text verbatim plus a license NOTICE, and names the target in MANIFEST.json: ENOENT: no such file or directory, open '/tmp/x/public-export/LICENSE'\n" +
  "public target — append-only history > the first configured export creates the history: expected 0 to be 1\n" +
  'actual: 0\n';

const FIRST_CASE =
  'public target — licensed export > ships the Elastic License 2.0 text verbatim plus a license NOTICE, and names the target in MANIFEST.json';
const SECOND_CASE = 'public target — append-only history > the first configured export creates the history';

function mutationRow(tail: string | null): SpecEvidenceForAdequacy {
  return {
    evidenceKind: 'mutation',
    testRunProvenance: {
      filePath: 'packages/operator-core/lib/source-preview-public.test.ts',
      commitSha: 'abc',
      worktreeDirty: false,
      ...(tail === null ? {} : { mutationFailureLines: mutationFailureLines(tail) }),
    },
  } as unknown as SpecEvidenceForAdequacy;
}

describe('mutation failure lines (WI-10006745)', () => {
  it('keeps every non-empty reporter line, bounded', () => {
    expect(mutationFailureLines(LIVE_TAIL)).toEqual([
      expect.stringMatching(/^public target — licensed export > /),
      expect.stringMatching(/^public target — append-only history > /),
      'actual: 0',
    ]);
    expect(mutationFailureLines(Array.from({ length: 100 }, (_, i) => `case ${i}: boom`).join('\n'))).toHaveLength(64);
  });

  it('matches each measured case by its exact full name, even with an em dash in the describe title', () => {
    const row = mutationRow(LIVE_TAIL);
    expect(mutationMeasuredFailedCase(row, FIRST_CASE)).toBe(true);
    expect(mutationMeasuredFailedCase(row, SECOND_CASE)).toBe(true);
  });

  it('refuses the truncated prefix the em-dash split used to produce, sibling cases and malformed titles', () => {
    const row = mutationRow(LIVE_TAIL);
    // The old derivation: split_part(output_tail, ' — ', 1) → 'public target'.
    expect(mutationMeasuredFailedCase(row, 'public target')).toBe(false);
    // A case that never failed in this run (a sibling clause's test) cannot bind.
    expect(mutationMeasuredFailedCase(row, 'public target — append-only history > keeps prior commits')).toBe(false);
    // A prefix that is not a whole `<name>: ` boundary does not match.
    expect(mutationMeasuredFailedCase(row, 'public target — append-only history > the first')).toBe(false);
    expect(mutationMeasuredFailedCase(row, ` ${SECOND_CASE}`)).toBe(false);
    expect(mutationMeasuredFailedCase(row, `${SECOND_CASE}\u0007`)).toBe(false);
    expect(mutationMeasuredFailedCase(row, '')).toBe(false);
    expect(mutationMeasuredFailedCase(row, 42)).toBe(false);
  });

  it('measures nothing when the run recorded no tail', () => {
    expect(mutationMeasuredFailedCase(mutationRow(null), SECOND_CASE)).toBe(false);
  });
});
