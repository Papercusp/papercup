import { describe, expect, it } from 'vitest';
import {
  acceptanceBarAmendmentKey,
  withAcceptanceBarAmendmentTransaction,
} from './acceptance-bar-amendment';
import {
  ACCEPTANCE_BAR_MEANING_FIELDS,
  acceptanceBarMeaningField,
} from './agent-tools/plans/rubric-loss-guard';

describe('acceptance BAR amendment transaction contract', () => {
  it('derives a stable replay key independent of BAR hash ordering', () => {
    const first = acceptanceBarAmendmentKey({
      rubricId: 'acceptance-plan',
      subjectPlan: 'plan',
      actorId: 'actor',
      reason: 'correct the contract',
      priorRubricRevision: 4,
      nextBarHashes: ['b'.repeat(64), 'a'.repeat(64)],
    });
    const second = acceptanceBarAmendmentKey({
      rubricId: 'acceptance-plan',
      subjectPlan: 'plan',
      actorId: 'actor',
      reason: 'correct the contract',
      priorRubricRevision: 4,
      nextBarHashes: ['a'.repeat(64), 'b'.repeat(64)],
    });
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(second).toBe(first);
    expect(
      acceptanceBarAmendmentKey({
        rubricId: 'acceptance-plan',
        subjectPlan: 'plan',
        actorId: 'actor',
        reason: 'different reason',
        priorRubricRevision: 4,
        nextBarHashes: ['a'.repeat(64), 'b'.repeat(64)],
      }),
    ).not.toBe(first);
  });

  it('keeps the BAR meaning field set explicit and excludes METHOD-only fields', () => {
    expect(ACCEPTANCE_BAR_MEANING_FIELDS).toContain('model');
    expect(ACCEPTANCE_BAR_MEANING_FIELDS).toContain('driftMarkers');
    expect(acceptanceBarMeaningField('model')).toBe(true);
    expect(acceptanceBarMeaningField('method')).toBe(false);
    expect(acceptanceBarMeaningField('replication')).toBe(false);
  });

  it('rejects an empty cross-plan transaction before opening a workspace', async () => {
    await expect(withAcceptanceBarAmendmentTransaction({ plans: [] }, async () => true)).rejects.toThrow(
      /at least one plan is required/,
    );
  });

  it('rejects plans from different workspaces before locking either plan', async () => {
    await expect(
      withAcceptanceBarAmendmentTransaction(
        {
          plans: [
            { workspaceId: 'ws-a', harnessSlug: 'h', planSlug: 'subject' },
            { workspaceId: 'ws-b', harnessSlug: 'h', planSlug: 'rubric' },
          ],
        },
        async () => true,
      ),
    ).rejects.toThrow(/must share one workspace/);
  });
});

