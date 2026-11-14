import { describe, expect, it } from 'vitest';
import { completionEvidenceFromRecord } from './complete';

describe('assessment proof survives the public completion boundary', () => {
  it('keeps the canonical nested scorecard selector for preflight and terminal issuance', () => {
    expect(completionEvidenceFromRecord({ summary: 'Requested scope was measured.',
      verification: { assessmentScorecardId: 'EI-scope-proof' } }))
      .toEqual({ assessmentScorecardId: 'EI-scope-proof' });
  });
});
