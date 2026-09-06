import { describe, expect, it } from 'vitest';
import {
  acceptanceBarApprovalSchema,
  acceptanceBarAmendmentKey,
  acceptanceBarSourceFingerprint,
  synchronizeAcceptanceBarSubjectRevision,
  withAcceptanceBarAmendmentTransaction,
} from './acceptance-bar-amendment';
import { buildAcceptanceBarSeed } from './acceptance-bar-seed';
import {
  ACCEPTANCE_BAR_MEANING_FIELDS,
  acceptanceBarMeaningField,
} from './agent-tools/plans/rubric-loss-guard';

function subjectPlan(overrides: { requirements?: string; map?: string; now?: string } = {}): string {
  return `---
title: Subject plan
slug: subject-plan
status: active
created: 2026-09-06
updated: 2026-09-06
---

# Subject plan

## Now

**State:** ${overrides.now ?? 'working'}

**Next:** keep going

## Requirements

${overrides.requirements ?? '**R-1 — Canonical outcome.** The writer persists one canonical BAR.'}

## Design

### Bar-to-work map for this plan

| bar | implementing plan items | evidence plane |
|---|---|---|
${overrides.map ?? '| R-1 | P-001 | tree |'}

## Phase 1 — Build

- **P-001** \`todo\` persist the canonical BAR
`;
}

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

  it('represents BAR additions and removals explicitly in approval receipts', () => {
    const added = acceptanceBarApprovalSchema.safeParse({
      schemaVersion: 1,
      kind: 'acceptance-bar-amendment-approval',
      rubricRef: 'acceptance-plan',
      subjectPlan: 'plan',
      bars: [{ barKey: 'R-11', priorBarHash: null, nextBarHash: 'a'.repeat(64) }],
    });
    expect(added.success).toBe(true);

    const removed = acceptanceBarApprovalSchema.safeParse({
      schemaVersion: 1,
      kind: 'acceptance-bar-amendment-approval',
      rubricRef: 'acceptance-plan',
      subjectPlan: 'plan',
      bars: [{ barKey: 'R-2', priorBarHash: 'b'.repeat(64), nextBarHash: null }],
    });
    expect(removed.success).toBe(true);
    expect(
      acceptanceBarApprovalSchema.safeParse({
        schemaVersion: 1,
        kind: 'acceptance-bar-amendment-approval',
        rubricRef: 'acceptance-plan',
        subjectPlan: 'plan',
        bars: [{ barKey: 'R-2', priorBarHash: null, nextBarHash: null }],
      }).success,
    ).toBe(false);
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

describe('BAR-neutral subject-plan revision synchronization', () => {
  it('treats Now/Decision prose as neutral but fingerprints BAR source and map changes', async () => {
    const before = subjectPlan();
    const nowEdit = subjectPlan({ now: 'the Now block changed' });
    const requirementEdit = subjectPlan({
      requirements: '**R-1 — Canonical outcome.** The canonical promise changed.',
    });
    const mapEdit = subjectPlan({ map: '| R-1 | P-002 | tree |' });

    await expect(acceptanceBarSourceFingerprint(before)).resolves.toBe(
      await acceptanceBarSourceFingerprint(nowEdit),
    );
    await expect(acceptanceBarSourceFingerprint(before)).resolves.not.toBe(
      await acceptanceBarSourceFingerprint(requirementEdit),
    );
    await expect(acceptanceBarSourceFingerprint(before)).resolves.not.toBe(
      await acceptanceBarSourceFingerprint(mapEdit),
    );
  });

  it('repairs a stale subjectPlanRevision only when the canonical BAR set still matches', async () => {
    const before = subjectPlan();
    const after = subjectPlan({ now: 'the Now block changed' });
    const seeded = buildAcceptanceBarSeed({
      planSlug: 'subject-plan',
      planContent: before,
      actorId: 'seed-author',
      declaredAt: '2026-09-06T00:00:00.000Z',
      cohort: 'post-epoch',
      adoptionEpoch: 1,
      subjectPlanRevision: 1,
      planStatus: 'active',
      rubricSlug: 'acceptance-subject-plan',
      rubricRevision: 4,
    });
    expect(seeded.ok).toBe(true);
    if (!seeded.ok) return;

    const sql = vi.fn(async (strings: TemplateStringsArray) => {
      const statement = strings.join(' ');
      if (statement.includes('SELECT status, acceptance_bar_rubric_slug')) {
        return [{
          status: 'active',
          acceptance_bar_rubric_slug: 'acceptance-subject-plan',
          acceptance_bar_rubric_revision: 4,
          acceptance_bar_set_hash: seeded.barSetHash,
        }];
      }
      if (statement.includes('pg_try_advisory_xact_lock')) return [{ ok: true }];
      if (statement.includes('SELECT version, template_data')) {
        return [{ version: 4, template_data: seeded.templateData }];
      }
      if (statement.includes('UPDATE harness_shared.harness_plans')) return [{ plan_slug: 'acceptance-subject-plan' }];
      throw new Error(`unexpected SQL: ${statement}`);
    });

    await expect(
      synchronizeAcceptanceBarSubjectRevision(sql as never, {
        workspaceId: 'workspace',
        harnessSlug: 'papercusp',
        planSlug: 'subject-plan',
        previousBody: before,
        nextBody: after,
        previousVersion: 2,
        nextVersion: 3,
      }),
    ).resolves.toBe(true);

    expect(sql.mock.calls.some(([strings]) => strings.join(' ').includes('UPDATE harness_shared.harness_plans'))).toBe(true);
  });

  it('does not repair the pin when the Requirements BAR meaning changes', async () => {
    const before = subjectPlan();
    const after = subjectPlan({
      requirements: '**R-1 — Canonical outcome.** The canonical promise changed.',
    });
    const sql = vi.fn();

    await expect(
      synchronizeAcceptanceBarSubjectRevision(sql as never, {
        workspaceId: 'workspace',
        harnessSlug: 'papercusp',
        planSlug: 'subject-plan',
        previousBody: before,
        nextBody: after,
        previousVersion: 2,
        nextVersion: 3,
      }),
    ).resolves.toBe(false);
    expect(sql).not.toHaveBeenCalled();
  });
});
