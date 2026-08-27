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

  it('ignores future and modal intent refs while retaining past completion refs', () => {
    expect(
      completionClaimMismatch({
        summary: 'completed WI-2045; will read WI-2046, will reconcile WI-2047, and next I will inspect WI-2048',
        basedOn: read('work-item:WI-2045'),
      }),
    ).toBeUndefined();

    expect(
      completionClaimMismatch({
        summary: 'completed WI-2045; next I will inspect WI-2046; have verified WI-2047',
        basedOn: read('work-item:WI-2045'),
      }),
    ).toMatchObject({
      declaredRefs: ['work-item:WI-2045', 'work-item:WI-2047'],
      missingFromBasedOn: ['work-item:WI-2047'],
    });
  });

  it('ignores read-only reconciliation refs in a prospective unit hand-off', () => {
    expect(
      completionClaimMismatch({
        summary: 'Accepted WI-42228 investigate-only gate',
        body: [
          {
            text: 'I am limiting this unit to fresh read-only reconciliation of WI-212675, then checkpointing WI-42228.',
          },
        ],
        basedOn: read('work-item:WI-42228'),
      }),
    ).toBeUndefined();
  });

  it('exports the stable envelope field name used by the send seam', () => {
    expect(COMPLETION_CLAIM_MISMATCH_FIELD).toBe('completionClaimMismatch');
  });
});
