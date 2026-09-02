/**
 * P-005 (plan `design-to-code-coverage-seam-2026-09-02`), governed by D-016.
 *
 * The resolver's own falsifiability lives in
 * `agent-tools/work_items/untouched-paths.test.ts`. THIS file pins the half that decides a
 * grade: that a `filesChangedUntouched` finding actually lowers the authority, that its
 * ABSENCE never does, and where it sits in the reason ordering.
 *
 * The absence case is the one worth stating out loud. Every field on
 * `CompletionEvidenceFindings` means "not judged" when missing, never "judged clean", so a
 * caller that cannot run the probe — or does not run it at all — must get exactly today's
 * grade. A regression there would silently downgrade every close made by any caller that
 * has not been taught the new probe.
 */
import { describe, expect, it } from 'vitest';

import {
  authorityForCompletion,
  insufficientEvidenceReason,
  isSufficientEvidence,
  type CompletionEvidenceFindings,
} from './work-item-completion-authority';

/** A close whose own evidence is complete, so only findings can lower it. */
const goodEvidence = {
  summary: 'implemented the thing',
  verifiedHow: 'unit',
  testsRun: 'npm run test:file -- packages/operator-core/lib/thing.test.ts',
  testResult: 'passed',
  filesChanged: ['packages/operator-core/lib/thing.ts'],
};

const untouched = (...paths: string[]): CompletionEvidenceFindings => ({
  filesChangedUntouched: paths.map((path) => ({ path, lastCommitAt: '2026-07-01T00:00:00.000Z' })),
});

describe('insufficientEvidenceReason — files-changed-untouched (P-005)', () => {
  it('grades a close down when a declared path was real but untouched', () => {
    const findings = untouched('packages/operator-core/lib/thing.ts');

    expect(insufficientEvidenceReason(goodEvidence, findings)).toBe('files-changed-untouched');
    expect(isSufficientEvidence(goodEvidence, findings)).toBe(false);
    expect(authorityForCompletion(goodEvidence, findings)).toBe('proposed');
  });

  it('leaves the grade untouched when the probe was not run — absence is not a clean verdict', () => {
    expect(insufficientEvidenceReason(goodEvidence, undefined)).toBeUndefined();
    expect(authorityForCompletion(goodEvidence, undefined)).toBe('committed');
    // An explicitly EMPTY finding is the "ran it, found nothing" shape and must also pass.
    expect(authorityForCompletion(goodEvidence, { filesChangedUntouched: [] })).toBe('committed');
  });

  it('is reported below its own predecessor, so the more concrete defect is heard first', () => {
    // The two populations are disjoint by construction (absent from disk vs present on it),
    // but if a caller ever supplies both, "this path never existed" is the cheaper repair.
    const both: CompletionEvidenceFindings = {
      ...untouched('packages/real-but-idle.ts'),
      filesChangedNeverExisted: ['packages/invented.ts'],
    };

    expect(insufficientEvidenceReason(goodEvidence, both)).toBe('files-changed-never-existed');
  });

  it('yields to every finding that outranks it, so a closer hears the blocking problem first', () => {
    const base = untouched('packages/real-but-idle.ts');

    // A red run means the WORK is unfinished; a stale path list means the RECORD is wrong.
    expect(
      insufficientEvidenceReason(goodEvidence, {
        ...base,
        testRunContradictedByLedger: { runGroupId: 'grp-1', failingFiles: ['a.test.ts'], filesInRun: 3 },
      }),
    ).toBe('test-result-contradicted-by-run');

    // A false claim about what the code DOES outranks a wrong account of WHERE it landed.
    expect(
      insufficientEvidenceReason(goodEvidence, {
        ...base,
        claimsFalsified: [{ claim: '"x" in Y', reason: 'Y does not contain x' }],
      }),
    ).toBe('completion-claim-falsified');

    // A record wrong about the ASK outranks one wrong about the files.
    expect(
      insufficientEvidenceReason(goodEvidence, {
        ...base,
        requirementDispositionShortfall: { kind: 'unfaithful', entries: [] },
      }),
    ).toBe('requirement-disposition-unfaithful');
  });

  it('still fires when it is the only thing wrong with an otherwise exemplary close', () => {
    // Guards against the finding being masked by a missing-field check that outranks it:
    // if this ever regressed, the check would be dead code on exactly its own population.
    expect(insufficientEvidenceReason(goodEvidence, untouched('a.ts', 'b.ts'))).toBe(
      'files-changed-untouched',
    );
  });
});
