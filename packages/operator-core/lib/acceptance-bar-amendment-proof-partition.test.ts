/**
 * review-system-rework-reduction-2026-09-23 P-002 (covers P-027): the amend dry run
 * reports CARRIED vs INVALIDATED proof separately.
 *
 * Before this, the preview built `invalidatedProofRefs` from EVERY bar's proof, so a
 * one-bar amendment told the amender to re-bind all of it, and agents answered with
 * hand-written re-bind scripts. Unchanged bars keep their clause revision (P-001) and
 * their proof, so only a changed bar's proof is invalidated.
 */
import { describe, expect, it } from 'vitest';
import { invalidatedAdequacyCardSubjects, partitionAmendmentProof } from './acceptance-bar-amendment';

const bar = (barKey: string, ...evidenceRefs: string[]) => ({ barKey, proof: { evidenceRefs } });

describe('partitionAmendmentProof (P-002)', () => {
  it('invalidates only the changed bar and carries every unchanged one', () => {
    const result = partitionAmendmentProof(
      [bar('R-1', 'test:r1', 'mutation:r1'), bar('R-2', 'test:r2'), bar('R-3', 'probe:r3')],
      ['R-2'],
    );

    expect(result).toEqual({
      invalidatedProofRefs: ['test:r2'],
      carriedProofRefs: ['mutation:r1', 'probe:r3', 'test:r1'],
    });
  });

  it('carries everything when no bar changed (a method-only amendment)', () => {
    const result = partitionAmendmentProof([bar('R-1', 'a'), bar('R-2', 'b')], []);

    expect(result).toEqual({ invalidatedProofRefs: [], carriedProofRefs: ['a', 'b'] });
  });

  it('lists a ref shared with a changed bar only as invalidated, so carried is safe to skip', () => {
    const result = partitionAmendmentProof([bar('R-1', 'shared', 'only-r1'), bar('R-2', 'shared')], ['R-2']);

    expect(result.invalidatedProofRefs).toEqual(['shared']);
    expect(result.carriedProofRefs).toEqual(['only-r1']);
  });

  it('invalidates a removed or added bar named in changedBars even with no surviving proof', () => {
    const result = partitionAmendmentProof([bar('R-1', 'kept'), bar('R-9', 'retired-proof')], ['R-9', 'R-10']);

    expect(result).toEqual({ invalidatedProofRefs: ['retired-proof'], carriedProofRefs: ['kept'] });
  });

  it('names the adequacy card of each clause a meaning-changed bar re-revisions (spec B)', () => {
    const mapped = (barKey: string, ...specs: Array<[string, number]>) => ({
      barKey, mappings: specs.map(([specId, specRevision]) => ({ specId, specRevision })),
    });
    const subjects = invalidatedAdequacyCardSubjects(
      'subject-plan',
      [
        mapped('R-1', ['AUTO-BAR-R-1-P-001', 3]),
        mapped('R-2', ['AUTO-BAR-R-2-P-002', 5], ['AUTO-BAR-R-2-P-003', 2]),
        mapped('R-9', ['AUTO-BAR-R-9-P-009', 4]),
        mapped('R-4', ['AUTO-BAR-R-4-P-004', 0]),
      ],
      // R-2 meaning-changed; R-9 removed (absent from survivors); R-4 changed but its
      // clause was never projected (revision 0); R-1 unchanged.
      ['R-2', 'R-9', 'R-4'],
      new Set(['R-1', 'R-2', 'R-4']),
    );

    expect(subjects).toEqual([
      'subject-plan#AUTO-BAR-R-2-P-002@5',
      'subject-plan#AUTO-BAR-R-2-P-003@2',
    ]);
  });

  it('calibration: the pre-P-002 rule (every bar invalidated) would fail the first case', () => {
    // The old preview expression, kept here as a deliberately-wrong control: it reports the
    // unchanged R-1/R-3 proof as invalidated, which is exactly the over-report this fixes.
    const bars = [bar('R-1', 'test:r1'), bar('R-2', 'test:r2'), bar('R-3', 'probe:r3')];
    const legacy = [...new Set(bars.flatMap((entry) => entry.proof.evidenceRefs))].sort();

    expect(legacy).not.toEqual(partitionAmendmentProof(bars, ['R-2']).invalidatedProofRefs);
  });
});
