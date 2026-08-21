import { describe, expect, it } from 'vitest';
import { completionClaimMismatch, COMPLETION_CLAIM_MISMATCH_FIELD } from './completion-claim-mismatch';

const read = (...refs: string[]) => refs.map((ref) => ({ ref }));

describe('completionClaimMismatch', () => {
  it('flags a named completed plan that is absent from the sender read trace', () => {
    expect(
      completionClaimMismatch({
        summary: 'completed plan:shipped-feature',
        basedOn: read('plan:unrelated-plan'),
      }),
    ).toEqual({
      kind: 'unread-artifact',
      declaredRefs: ['plan:shipped-feature'],
      missingFromBasedOn: ['plan:shipped-feature'],
      note: 'claims completion on artifacts this session never read',
    });
  });

  it('treats a rubric read as the matching persisted plan read', () => {
    expect(
      completionClaimMismatch({
        summary: 'graded rubric "acceptance-rubric" and shipped the result',
        basedOn: read('plan:acceptance-rubric'),
      }),
    ).toBeUndefined();
  });

  it('collects explicit work-item and plan premises from structured message sections', () => {
    expect(
      completionClaimMismatch({
        summary: 'verified the delivery',
        body: [
          {
            text: 'The acceptance is complete.',
            premises: ['WI-2045#completion', 'release-plan#D-004'],
          },
        ],
        basedOn: read('work-item:WI-2045'),
      }),
    ).toMatchObject({
      declaredRefs: ['work-item:WI-2045', 'plan:release-plan'],
      missingFromBasedOn: ['plan:release-plan'],
    });
  });

  it('does not stamp negated completion claims or unnamed completion prose', () => {
    expect(
      completionClaimMismatch({
        summary: 'did not complete plan:shipped-feature',
        basedOn: [],
      }),
    ).toBeUndefined();
    expect(
      completionClaimMismatch({
        summary: 'the completion check is still pending',
        basedOn: [],
      }),
    ).toBeUndefined();
  });

  it('exports the stable envelope field name used by the send seam', () => {
    expect(COMPLETION_CLAIM_MISMATCH_FIELD).toBe('completionClaimMismatch');
  });
});
