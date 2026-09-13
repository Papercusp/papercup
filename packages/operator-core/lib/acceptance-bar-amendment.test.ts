import { describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ withWorkspace: vi.fn() }));

vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  withWorkspace: h.withWorkspace,
}));

import {
  acceptanceBarApprovalSchema,
  approvalReceiptJsonSource,
  resolveAcceptanceBarApproval,
  acceptanceBarAmendmentKey,
  acceptanceBarSourceFingerprint,
  synchronizeAcceptanceBarSubjectRevision,
  withAcceptanceBarAmendmentTransaction,
} from './acceptance-bar-amendment';
import { buildAcceptanceBarSeed } from './acceptance-bar-seed';
import { normalizeAcceptanceBarCriterion } from './rubrics';
import { OrgTxnTimeoutError } from './pg-bounded-txn';
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
    expect(ACCEPTANCE_BAR_MEANING_FIELDS).toContain('check');
    expect(acceptanceBarMeaningField('model')).toBe(true);
    expect(acceptanceBarMeaningField('check')).toBe(true);
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

  it('normalizes a raw advisory lock timeout to OrgTxnTimeoutError', async () => {
    const raw = Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' });
    const tx = ((strings: TemplateStringsArray) => {
      if (strings.join(' ').includes('pg_advisory_xact_lock')) return Promise.reject(raw);
      return Promise.resolve([]);
    }) as unknown;
    h.withWorkspace.mockImplementationOnce(
      async (_workspaceId: string, fn: (tx: unknown) => Promise<unknown>) => fn(tx),
    );

    const rejected = withAcceptanceBarAmendmentTransaction(
      { plans: [{ workspaceId: 'ws', harnessSlug: 'h', planSlug: 'rubric' }] },
      async () => true,
    );

    await expect(rejected).rejects.toBeInstanceOf(OrgTxnTimeoutError);
    await expect(rejected).rejects.toMatchObject({ name: 'OrgTxnTimeoutError', pgCode: '55P03', cause: raw });
  });
});

describe('BAR-neutral subject-plan revision synchronization', () => {
  it('treats Now/Decision prose as neutral but fingerprints BAR source and map changes', async () => {
    const before = subjectPlan();
    const nowEdit = subjectPlan({ now: 'the Now block changed' });
    const decisionEdit = `${before}\n## Decisions\n\n### D-001 — Keep the BAR source canonical\n\nDate: 2026-09-06\n\nThe decision prose is not BAR source.\n`;
    const requirementEdit = subjectPlan({
      requirements: '**R-1 — Canonical outcome.** The canonical promise changed.',
    });
    const mapEdit = subjectPlan({ map: '| R-1 | P-002 | tree |' });

    await expect(acceptanceBarSourceFingerprint(before)).resolves.toBe(
      await acceptanceBarSourceFingerprint(nowEdit),
    );
    await expect(acceptanceBarSourceFingerprint(before)).resolves.toBe(
      await acceptanceBarSourceFingerprint(decisionEdit),
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

  // WI-10000058. Two defects made the pin repair silently impossible for a real plan.
  // Both failures returned `false` out of a boolean nobody reads, so the plan write
  // succeeded, the pin went stale, and ship later refused bar_snapshot_rubric_revision_mismatch.
  it('derives the mandatory pass rating from the rubric ratingScale instead of hardcoding healthy', async () => {
    const body = subjectPlan();
    const healthyScale = buildAcceptanceBarSeed({
      planSlug: 'subject-plan', planContent: body, actorId: 'seed-author',
      declaredAt: '2026-09-06T00:00:00.000Z', cohort: 'post-epoch', adoptionEpoch: 1,
      subjectPlanRevision: 1, planStatus: 'active',
      rubricSlug: 'acceptance-subject-plan', rubricRevision: 4,
    });
    expect(healthyScale.ok).toBe(true);
    if (!healthyScale.ok) return;
    // CALIBRATION: the default scale is healthy-based, so the pre-fix hardcode was
    // correct HERE. This case must keep passing or the test proves nothing about the fix.
    expect(healthyScale.criteria[0]!.passRatings).toEqual(['healthy']);

    // A pass/partial/fail/unknown rubric is equally valid and must not be normalised.
    // subjectPlanRevision deliberately DIFFERS from the stored pin (1) so that
    // preserveCanonicalBars is false and the criteria are genuinely re-derived — a
    // matching pin returns the stored criterion verbatim and would make this test
    // vacuous (caught by mutation probe: the mutant survived until this was fixed).
    const passScale = buildAcceptanceBarSeed({
      planSlug: 'subject-plan', planContent: body, actorId: 'seed-author',
      declaredAt: '2026-09-06T00:00:00.000Z', cohort: 'post-epoch', adoptionEpoch: 1,
      subjectPlanRevision: 2, planStatus: 'active',
      rubricSlug: 'acceptance-subject-plan', rubricRevision: 4,
      // A self-consistent pass-scale rubric: scale AND stored criteria both on 'pass'.
      existingTemplateData: {
        ...healthyScale.templateData,
        ratingScale: ['pass', 'partial', 'fail', 'unknown'],
        criteria: (healthyScale.criteria as Array<Record<string, unknown>>).map((c) => ({
          ...c, passRatings: ['pass'],
        })),
      },
    });
    // Pre-fix this refused bar_rubric_conflict: "mandatory outcome pass rating 'healthy'
    // is not present in the rubric ratingScale".
    expect(passScale.ok).toBe(true);
    if (!passScale.ok) return;
    expect(passScale.criteria[0]!.passRatings).toEqual(['pass']);
  });

  it('preserves amended canonical BAR text when advancing the pin, instead of reverting it to the seed', async () => {
    const before = subjectPlan();
    const after = subjectPlan({ now: 'the Now block changed' });
    const seeded = buildAcceptanceBarSeed({
      planSlug: 'subject-plan', planContent: before, actorId: 'seed-author',
      declaredAt: '2026-09-06T00:00:00.000Z', cohort: 'post-epoch', adoptionEpoch: 1,
      subjectPlanRevision: 2, planStatus: 'active',
      rubricSlug: 'acceptance-subject-plan', rubricRevision: 4,
    });
    expect(seeded.ok).toBe(true);
    if (!seeded.ok) return;

    // Simulate a rubric AMENDED after seeding: its criterion model is richer than the
    // text a fresh seed of the same body produces. This is the real shape — an amendment
    // that removed a factually-false constant from the original seed.
    const amendedModel = 'The AMENDED canonical promise, corrected after seeding.';
    const amended = {
      ...seeded.templateData,
      // Normalise so barHash is genuinely RECOMPUTED from the amended text. A hand-spread
      // that leaves the original barHash in place does not move barSetHash, which made an
      // earlier version of this fixture non-discriminating (caught by mutation probe).
      criteria: seeded.criteria.map((c) => normalizeAcceptanceBarCriterion({
        ...c, model: amendedModel,
      })),
    };

    // The STORED hash must be the AMENDED set's hash, not the fresh seed's — otherwise a
    // re-derivation reproduces it and preservation is not discriminating (caught by
    // mutation probe: the mutant survived until this fixture was corrected).
    const amendedSeed = buildAcceptanceBarSeed({
      planSlug: 'subject-plan', planContent: before, actorId: 'seed-author',
      declaredAt: '2026-09-06T00:00:00.000Z', cohort: 'post-epoch', adoptionEpoch: 1,
      subjectPlanRevision: 2, planStatus: 'active',
      rubricSlug: 'acceptance-subject-plan', rubricRevision: 4,
      existingTemplateData: amended,
    });
    expect(amendedSeed.ok).toBe(true);
    if (!amendedSeed.ok) return;
    // Sanity: the amendment really did move the hash away from the fresh seed's.
    expect(amendedSeed.barSetHash).not.toBe(seeded.barSetHash);

    let written: unknown = null;
    const sql = vi.fn(async (strings: TemplateStringsArray) => {
      const statement = strings.join(' ');
      if (statement.includes('SELECT status, acceptance_bar_rubric_slug')) {
        return [{
          status: 'active',
          acceptance_bar_rubric_slug: 'acceptance-subject-plan',
          acceptance_bar_rubric_revision: 4,
          acceptance_bar_set_hash: amendedSeed.barSetHash,
        }];
      }
      if (statement.includes('pg_try_advisory_xact_lock')) return [{ ok: true }];
      if (statement.includes('SELECT version, template_data')) {
        // The realistic post-amendment row: amended criteria AND the matching
        // barSetHash the amendment wrote alongside them.
        return [{ version: 4, template_data: amendedSeed.templateData }];
      }
      if (statement.includes('UPDATE harness_shared.harness_plans')) {
        written = statement;
        return [{ plan_slug: 'acceptance-subject-plan' }];
      }
      throw new Error(`unexpected SQL: ${statement}`);
    });

    // Pre-fix, preserveCanonicalBars was false by construction on a pin repair (the
    // stored pin never equals the incoming revision), so the criteria were re-derived
    // from the plan body and the barSetHash check then failed — returning false here.
    await expect(
      synchronizeAcceptanceBarSubjectRevision(sql as never, {
        workspaceId: 'workspace', harnessSlug: 'papercusp', planSlug: 'subject-plan',
        previousBody: before, nextBody: after, previousVersion: 2, nextVersion: 3,
      }),
    ).resolves.toBe(true);

    // The UPDATE must touch ONLY the pin — the amended text is never rewritten by it.
    expect(String(written)).toContain('{barContract,subjectPlanRevision}');
    expect(String(written)).not.toContain('criteria');
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

describe('approval receipt parsing (EI-22617748468342848)', () => {
  const RECEIPT = {
    schemaVersion: 1,
    kind: 'acceptance-bar-amendment-approval',
    rubricRef: 'acceptance-plan',
    subjectPlan: 'plan',
    bars: [{ barKey: 'R-1', priorBarHash: 'a'.repeat(64), nextBarHash: 'b'.repeat(64) }],
  } as const;

  const expected = {
    schemaVersion: 1 as const,
    kind: 'acceptance-bar-amendment-approval' as const,
    rubricRef: 'acceptance-plan',
    subjectPlan: 'plan',
    bars: [{ barKey: 'R-1', priorBarHash: 'a'.repeat(64), nextBarHash: 'b'.repeat(64) }],
  };

  function sqlReturning(body: string) {
    return (() =>
      Promise.resolve([
        { author_id: 'su-reviewer', body, approved_at: '2026-09-07T00:00:00.000Z' },
      ])) as unknown as Parameters<typeof resolveAcceptanceBarApproval>[0];
  }

  const resolve = (body: string) =>
    resolveAcceptanceBarApproval(sqlReturning(body), {
      workspaceId: 'papercusp-workspace',
      approvalRef: 'thread-post:123',
      expected,
    });

  it('strips a ```json fence before parsing, and leaves an unfenced body untouched', () => {
    expect(approvalReceiptJsonSource('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(approvalReceiptJsonSource('```\n{"a":1}\n```')).toBe('{"a":1}');
    expect(approvalReceiptJsonSource('{"a":1}')).toBe('{"a":1}');
  });

  it('accepts a fenced reviewer receipt', async () => {
    await expect(resolve('```json\n' + JSON.stringify(RECEIPT) + '\n```')).resolves.toMatchObject({
      approvalRef: 'thread-post:123',
      approvedBy: 'su-reviewer',
    });
  });

  it('still accepts a raw receipt', async () => {
    await expect(resolve(JSON.stringify(RECEIPT))).resolves.toMatchObject({
      approvedBy: 'su-reviewer',
    });
  });

  it('reports a non-JSON body as _unparseable, naming the cause', async () => {
    await expect(resolve('Approved! see above.')).rejects.toThrow(
      /acceptance_bar_approval_unparseable/,
    );
  });

  // The case that proves the split is real rather than cosmetic: well-formed JSON
  // that fails the schema must KEEP the old code, one line below the new one.
  it('keeps _invalid_receipt for well-formed JSON that fails the schema', async () => {
    const wrongSchema = JSON.stringify({ schemaVersion: 1, kind: 'not-an-approval' });
    await expect(resolve(wrongSchema)).rejects.toThrow(/acceptance_bar_approval_invalid_receipt/);
    await expect(resolve(wrongSchema)).rejects.not.toThrow(/unparseable/);
  });
});
