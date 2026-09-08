/**
 * rubrics.integration.test.ts — the PLANS-BACKED rubrics store end-to-end against the
 * real migrated Postgres (plan-templates-and-rubric-v2-2026-06-20 P-006/P-007).
 *
 * v2: a RUBRIC IS A PLAN. The store reads/writes `template: rubric` plans
 * (harness_shared.harness_plans), NOT the dropped v1 standalone table. This suite drives
 * the full surface over the real schema (createOrgTestDb applies the whole migration set,
 * so withPlanLock's content + template_data writes hit the production column layout):
 *   • READS — a rubric-template plan resolves as a Rubric; template_data (incl. a
 *     per-criterion ratingScale override) round-trips; plan status → rubric status; an
 *     instance plan (template_slug) is excluded; a malformed plan degrades (skipped);
 *   • WRITES — proposeRubric authors a draft (proposed) rubric-template plan; ratifyRubric
 *     promotes it active; status:'active' authors a ratified rubric directly; re-propose
 *     is an idempotent upsert (no duplicate PK row);
 *   • list/get/search over the plan rows (active-first ordering, status/characteristic
 *     filters, in-process token search).
 *
 * Docker-gated (`*.integration.test.ts`).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import type { OrgTestDb } from '../test/_org-test-db';
import { runWithWorkspace } from './workspace-als';
import { activeWorkspaceId } from './workspace-registry';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));

// The re-pointed writes go through withPlanLock → withWorkspace; the reads through
// getOrgPg. Mock BOTH onto the migrated throwaway DB's admin (RLS-bypass) client — the
// withPlanLock advisory xact-lock needs a real transaction, which `.begin` provides.
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return {
    ...(await orig<typeof import('@papercusp/db-org')>()),
    ...actual,
    getOrgPg: () => ({ sql: h.sql }),
    withWorkspace: async <T>(ws: string, cb: (tx: postgres.Sql) => Promise<T> | T): Promise<T> =>
      h.sql.begin(async (tx) => {
        await tx`SELECT set_config('app.workspace_id', ${ws}, true)`;
        return cb(tx as unknown as postgres.Sql);
      }) as Promise<T>,
  };
});

const rubrics = await import('./rubrics');
const { createOrgTestDb } = await import('../test/_org-test-db');

let db: OrgTestDb;

const sampleCriteria = [
  {
    key: 'placement-health',
    title: 'Placement health',
    model: 'The Queen places every ready, unblocked frontier item onto a live bee within a cadence.',
    method: 'Count ready work_items with no claim older than the cadence; check fleet:assignments load balance.',
    driftMarkers: 'A growing backlog of ready-but-unplaced items; bees idle while the frontier is non-empty.',
  },
  {
    key: 'ideation-diversity',
    title: 'Ideation diversity',
    model: 'Scout lens weights drift away from uniform as grades steer ideation.',
    method: 'Inspect lens_weights; off-uniform 0.25 means grades are steering.',
    ratingScale: ['healthy', 'degraded', 'broken', 'unknown', 'n/a'], // per-criterion override
    driftMarkers: 'Lens weights stuck uniform; repeated near-identical ideas.',
  },
];

// Permanent tier-1 mutation control (CLAUDE.md): this is the deliberately WRONG,
// pre-EI-21296891484659125 status resolver. It calibrates against a brand-new acceptance
// rubric below, then stays `active` after retirement so the real writer's preservation
// assertion demonstrably distinguishes the guarded path without mutating production code.
const deliberatelyUnguardedAcceptanceProposeStatus = (
  explicit?: 'proposed' | 'active' | 'retired',
): 'proposed' | 'active' | 'retired' => explicit ?? 'active';

const rubricData = {
  characteristic: 'hive-coordination',
  criteria: [
    {
      key: 'placement-health',
      title: 'Placement health',
      model: 'The Queen places ready frontier items onto live bees within a cadence.',
      method: 'Count ready work_items with no claim older than the cadence.',
      driftMarkers: 'A growing backlog of ready-but-unplaced items.',
      ratingScale: ['healthy', 'degraded', 'broken', 'unknown', 'n/a'],
    },
  ],
  ratingScale: ['healthy', 'degraded', 'broken', 'unknown'],
  methodRef: 'pot-coordination-health-runbook',
  description: 'How well the loop is turning.',
};

/** Insert a rubric-template plan row directly (admin/bypass) — the read leg's input,
 *  for read-path edge cases that the write path can't author (malformed data, an
 *  instance plan, a specific status). Provides the NOT-NULL plan columns minimally.
 *  Defaults the workspace to activeWorkspaceId() — the SAME scope the store reads from
 *  (rubricsScopeWorkspace, WI-976) — so seed + read stay symmetric on any env (a
 *  hardcoded 'default' here would mismatch the store's active-workspace scope). Pass an
 *  explicit workspaceId to exercise cross-workspace scoping. */
async function insertRubricPlan(
  slug: string,
  opts: {
    status?: string;
    data?: unknown;
    title?: string;
    templateSlug?: string | null;
    archived?: boolean;
    workspaceId?: string;
    version?: number;
  } = {},
) {
  await db.adminSql`
    INSERT INTO harness_shared.harness_plans
      (workspace_id, harness_slug, plan_slug, content, content_hash, version, title, status,
       created, updated, owner, archived, template, template_data, template_slug, origin)
    VALUES (${opts.workspaceId ?? activeWorkspaceId()}, 'papercusp', ${slug}, '', md5(${slug}), ${opts.version ?? 1}, ${opts.title ?? slug},
            ${opts.status ?? 'active'}, '2026-06-20', '2026-06-20', 'queen-1', ${opts.archived ?? false},
            'rubric', ${JSON.stringify(opts.data ?? rubricData)}::text::jsonb, ${opts.templateSlug ?? null}, 'local')`;
}

beforeAll(async () => {
  db = await createOrgTestDb();
  h.sql = db.adminSql;
}, 120_000);

afterAll(async () => {
  await db?.cleanup();
});

beforeEach(async () => {
  // Wipe the migration-seeded rubric plan (mig 338) + any prior test rows so each
  // case asserts against a clean rubric set. CASCADE: plan_items/plan_decisions
  // (and any future table) hold FKs into harness_plans, and a bare TRUNCATE of a
  // referenced table is refused by Postgres (WI-39618).
  await db.adminSql`TRUNCATE harness_shared.harness_plans CASCADE`;
});

describe('reads — a rubric-template plan resolves as a Rubric', () => {
  it('getRubric resolves a rubric-template plan; template_data + per-criterion scale round-trip', async () => {
    await insertRubricPlan('queen-placement-health');
    const r = await rubrics.getRubric('queen-placement-health');
    expect(r).not.toBeNull();
    expect(r!.rubricId).toBe('queen-placement-health');
    expect(r!.characteristic).toBe('hive-coordination');
    expect(r!.status).toBe('active'); // plan status 'active' → rubric 'active'
    expect(r!.criteria).toHaveLength(1);
    expect(r!.criteria[0].key).toBe('placement-health');
    expect(r!.criteria[0].ratingScale).toContain('n/a');
    expect(r!.methodRef).toBe('pot-coordination-health-runbook');
  });

  it('projects harness_plans.version as revision across every rubric read path', async () => {
    await insertRubricPlan('versioned-standard', { version: 7 });
    await insertRubricPlan('versioned-plan-acceptance', {
      version: 11,
      data: {
        ...rubricData,
        kind: 'acceptance',
        subjectPlan: 'subject-plan-for-versioned-acceptance',
      },
    });
    await insertRubricPlan('versioned-goal-acceptance', {
      version: 13,
      data: {
        ...rubricData,
        kind: 'acceptance',
        subjectGoal: 'goal-for-versioned-acceptance',
      },
    });

    expect((await rubrics.listRubrics({})).find((r) => r.rubricId === 'versioned-standard')?.revision).toBe(7);
    expect((await rubrics.getRubric('versioned-standard'))?.revision).toBe(7);
    expect((await rubrics.getRubric('versioned-plan-acceptance'))?.revision).toBe(11);
    expect((await rubrics.getAcceptanceRubricsForPlan('subject-plan-for-versioned-acceptance'))[0]?.revision).toBe(11);
    expect((await rubrics.getAcceptanceRubricForGoal('goal-for-versioned-acceptance'))?.revision).toBe(13);
  });

  it('class-only acceptance rubrics inherit the class scale and hash the live class revision', async () => {
    const subjectPlan = 'class-only-acceptance-subject';
    const classRef = 'class-only-acceptance-class';
    const classScale = ['pass', 'partial', 'fail', 'unknown'];

    await db.adminSql`
      INSERT INTO harness_shared.harness_plans
        (workspace_id, harness_slug, plan_slug, content, content_hash, version, title, status,
         created, updated, owner, archived, template, origin)
      VALUES (${activeWorkspaceId()}, 'papercusp', ${subjectPlan}, '# Subject plan', md5('# Subject plan'), 1,
              'Class-only acceptance subject', 'active', '2026-09-04', '2026-09-04', 'su-test', false, NULL, 'local')`;
    await insertRubricPlan(classRef, {
      version: 7,
      data: { ...rubricData, ratingScale: classScale },
      title: 'Class-only acceptance class',
    });

    const acceptance = await rubrics.proposeRubric({
      rubricId: 'class-only-acceptance',
      kind: 'acceptance',
      subjectPlan,
      classRef,
      characteristic: 'plan-acceptance',
      title: 'Class-only acceptance',
      criteria: [],
      by: 'author-a',
    });

    expect(acceptance.ratingScale).toEqual(classScale);
    expect(acceptance.criteria).toEqual([]);
    const [stored] = await db.adminSql<{ template_data: { ratingScale: string[] } }[]>`
      SELECT template_data
        FROM harness_shared.harness_plans
       WHERE plan_slug = 'class-only-acceptance'
         AND template = 'rubric'`;
    expect(stored.template_data.ratingScale).toEqual(classScale);

    const hashAtClassRevision7 = acceptance.criteriaHash;
    expect(hashAtClassRevision7).toEqual((await rubrics.getRubric('class-only-acceptance'))?.criteriaHash);

    await db.adminSql`
      UPDATE harness_shared.harness_plans
         SET version = 8, updated_at = now()
       WHERE plan_slug = ${classRef}
         AND template = 'rubric'`;
    const reread = await rubrics.getRubric('class-only-acceptance');
    expect(reread?.ratingScale).toEqual(classScale);
    expect(reread?.criteriaHash).not.toBe(hashAtClassRevision7);
  });

  it('does not fabricate a ratifier for active acceptance rubrics while preserving the standard legacy fallback', async () => {
    await insertRubricPlan('legacy-standard-rubric');
    await insertRubricPlan('plan-acceptance-rubric', {
      data: {
        ...rubricData,
        kind: 'acceptance',
        subjectPlan: 'subject-plan-for-acceptance',
      },
    });

    const standard = await rubrics.getRubric('legacy-standard-rubric');
    expect(standard?.kind).toBe('standard');
    expect(standard?.ratifiedBy).toBe('queen-1'); // legacy active standard row fallback

    const acceptance = await rubrics.getRubric('plan-acceptance-rubric');
    expect(acceptance?.kind).toBe('acceptance');
    expect(acceptance?.status).toBe('active');
    expect(acceptance?.ratifiedBy).toBeNull(); // acceptance rubrics are never ratified
  });

  it('listRubrics includes it; a draft plan maps to a proposed rubric', async () => {
    await insertRubricPlan('active-r', { status: 'active' });
    await insertRubricPlan('draft-r', { status: 'draft' });
    const all = await rubrics.listRubrics({});
    expect(all.map((r) => r.rubricId).sort()).toEqual(['active-r', 'draft-r']);
    expect((await rubrics.listRubrics({ status: 'active' })).map((r) => r.rubricId)).toEqual(['active-r']);
    expect((await rubrics.listRubrics({ status: 'proposed' })).map((r) => r.rubricId)).toEqual(['draft-r']);
  });

  it('searchRubrics finds a rubric-template plan by characteristic / title', async () => {
    await insertRubricPlan('queen-placement-health');
    expect((await rubrics.searchRubrics('coordination')).map((r) => r.rubricId)).toContain('queen-placement-health');
    expect(await rubrics.searchRubrics('zzznotarubric')).toEqual([]);
  });

  it('excludes per-run INSTANCE plans (template_slug IS NOT NULL)', async () => {
    await insertRubricPlan('an-instance', { templateSlug: 'some-template' });
    expect(await rubrics.getRubric('an-instance')).toBeNull();
    expect(await rubrics.listRubrics({})).toEqual([]);
  });

  it('degrades a malformed rubric-template plan to null (skipped, not surfaced broken)', async () => {
    await insertRubricPlan('broken-r', { data: { characteristic: 'x', criteria: [], ratingScale: [] } });
    expect(await rubrics.getRubric('broken-r')).toBeNull();
    expect(await rubrics.listRubrics({})).toEqual([]);
  });
});

describe('writes — propose / ratify author + promote a rubric-template plan', () => {
  it('refuses to overwrite an ordinary plan whose slug collides with rubricId', async () => {
    const body = `---
title: Existing work plan
status: draft
created: 2026-08-26
updated: 2026-08-26
---

# Existing work plan

## Now

Preserve this plan body.
`;
    await db.adminSql`
      INSERT INTO harness_shared.harness_plans
        (workspace_id, harness_slug, plan_slug, content, content_hash, version, title, status,
         created, updated, owner, archived, template, origin)
      VALUES (${activeWorkspaceId()}, 'papercusp', 'colliding-work-plan', ${body}, md5(${body}), 1,
              'Existing work plan', 'draft', '2026-08-26', '2026-08-26', 'su-test', false, null, 'local')`;

    await expect(
      rubrics.proposeRubric({
        rubricId: 'colliding-work-plan',
        characteristic: 'acceptance',
        title: 'Would overwrite the plan',
        criteria: sampleCriteria,
        by: 'su-test',
      }),
    ).rejects.toThrow(/collides with an existing non-rubric plan/);

    const [preserved] = await db.adminSql<{ content: string; template: string | null; version: number }[]>`
      SELECT content, template, version
        FROM harness_shared.harness_plans
       WHERE workspace_id = ${activeWorkspaceId()}
         AND harness_slug = 'papercusp'
         AND plan_slug = 'colliding-work-plan'`;
    expect(preserved).toEqual({ content: body, template: null, version: 1 });
  });

  it('propose creates a PROPOSED rubric (draft plan) with criteria + default rating scale', async () => {
    const r = await rubrics.proposeRubric({
      rubricId: 'pot-coordination-health',
      characteristic: 'hive-coordination',
      title: 'Hive coordination health',
      description: 'How well the placement/ideation/observation loop is turning.',
      criteria: sampleCriteria,
      methodRef: 'pot-coordination-health-runbook',
      by: 'su-test',
    });
    expect(r.status).toBe('proposed');
    expect(r.ratingScale).toEqual(['healthy', 'degraded', 'broken', 'unknown']);
    expect(r.criteria).toHaveLength(2);
    expect(r.criteria[0].key).toBe('placement-health');
    expect(r.criteria[1].ratingScale).toContain('n/a'); // per-criterion override round-trips
    expect(r.proposedBy).toBe('su-test'); // the plan owner
    expect(r.ratifiedBy).toBeNull(); // not yet active
    expect(r.methodRef).toBe('pot-coordination-health-runbook');
    // it lands as a queryable rubric-template plan, not a duplicate
    expect((await rubrics.listRubrics({})).map((x) => x.rubricId)).toEqual(['pot-coordination-health']);
  });

  it('persists and reads normalized unpinned standard-rubric composition refs', async () => {
    const parent = await rubrics.proposeRubric({
      rubricId: 'composition-parent',
      characteristic: 'composition',
      title: 'Composition parent',
      criteria: sampleCriteria,
      status: 'active',
      by: 'parent-author',
    });
    expect(parent.status).toBe('active');

    const composed = await rubrics.proposeRubric({
      rubricId: 'composition-child',
      characteristic: 'composition',
      title: 'Composition child',
      criteria: sampleCriteria,
      composes: [' composition-parent ', 'composition-parent'],
      by: 'child-author',
    });
    expect(composed.composes).toEqual(['composition-parent']);

    const [stored] = await db.adminSql<{ template_data: { composes?: string[] } }[]>`
      SELECT template_data
        FROM harness_shared.harness_plans
       WHERE workspace_id = ${activeWorkspaceId()}
         AND harness_slug = 'papercusp'
         AND plan_slug = 'composition-child'
         AND template = 'rubric'`;
    expect(stored.template_data.composes).toEqual(['composition-parent']);
    expect((await rubrics.getRubric('composition-child'))?.composes).toEqual(['composition-parent']);
  });

  it('validates composition targets live on propose and amend, preserving the prior edge on refusal', async () => {
    const validInput = {
      characteristic: 'composition-validation',
      title: 'Composition validation',
      criteria: sampleCriteria,
      by: 'composition-author',
    } as const;

    await expect(
      rubrics.proposeRubric({ rubricId: 'composition-dangling', ...validInput, composes: ['does-not-exist'] }),
    ).rejects.toThrow(/composes unknown rubric/i);
    expect(await rubrics.getRubric('composition-dangling')).toBeNull();

    await expect(
      rubrics.proposeRubric({ rubricId: 'composition-self', ...validInput, composes: ['composition-self'] }),
    ).rejects.toThrow(/cannot compose itself/i);
    expect(await rubrics.getRubric('composition-self')).toBeNull();

    const subjectPlan = 'composition-acceptance-subject';
    await db.adminSql`
      INSERT INTO harness_shared.harness_plans
        (workspace_id, harness_slug, plan_slug, content, content_hash, version, title, status,
         created, updated, owner, archived, template, template_data, template_slug, origin)
      VALUES (${activeWorkspaceId()}, 'papercusp', ${subjectPlan}, '', md5(${subjectPlan}), 1,
              'Composition acceptance subject', 'active', '2026-09-04', '2026-09-04', 'su-test',
              false, NULL, '{}'::text::jsonb, NULL, 'local')`;
    await rubrics.proposeRubric({
      rubricId: 'composition-acceptance-parent',
      kind: 'acceptance',
      subjectPlan,
      characteristic: 'composition-validation',
      title: 'Composition acceptance parent',
      criteria: [{
        key: 'outcome',
        title: 'Outcome',
        driftMarkers: 'the outcome regresses',
        check: { kind: 'instrument', instrumentKey: 'none' },
      }],
      by: 'acceptance-author',
    });

    await expect(
      rubrics.proposeRubric({ rubricId: 'composition-non-standard', ...validInput, composes: ['composition-acceptance-parent'] }),
    ).rejects.toThrow(/composes non-standard rubric/i);
    expect(await rubrics.getRubric('composition-non-standard')).toBeNull();

    await rubrics.proposeRubric({
      rubricId: 'composition-parent',
      characteristic: 'composition-validation',
      title: 'Composition parent',
      criteria: sampleCriteria,
      status: 'active',
      by: 'parent-author',
    });
    await rubrics.proposeRubric({
      rubricId: 'composition-amendment',
      ...validInput,
      composes: ['composition-parent'],
    });
    await expect(
      rubrics.amendRubric({
        rubricId: 'composition-amendment',
        composes: ['does-not-exist'],
        by: 'composition-author',
      }),
    ).rejects.toThrow(/composes unknown rubric/i);
    expect((await rubrics.getRubric('composition-amendment'))?.composes).toEqual(['composition-parent']);

    const amended = await rubrics.amendRubric({
      rubricId: 'composition-amendment',
      composes: [' composition-parent ', 'composition-parent'],
      by: 'composition-author',
    });
    expect(amended?.composes).toEqual(['composition-parent']);
  });

  it('ratify flips proposed → active and records the TRUE ratifier, not the author (EI-10751)', async () => {
    await rubrics.proposeRubric({ rubricId: 'x', characteristic: 'c', title: 'X', criteria: sampleCriteria, by: 'author-a' });
    const active = await rubrics.ratifyRubric('x', 'queen-1');
    expect(active?.status).toBe('active');
    // The old projection collapsed ratifiedBy onto the plan owner — a fabricated
    // self-ratification record that made D-012 (author ≠ ratifier) unrecordable.
    expect(active?.ratifiedBy).toBe('queen-1');
    expect(active?.proposedBy).toBe('author-a');
    expect(active?.createdBy).toBe('author-a');
  });

  it('propose + ratify EACH record a plan_revisions audit row (EI-10443 — rubric writes were unauditable)', async () => {
    // Before EI-10443 the rubric write path went through withPlanLock with NO afterWrite,
    // so the plan revision spine had ZERO rows for every rubric plan — the destructive
    // loss-guard strip that filed this bug left no audit trail (couldn't be detected or
    // recovered via plans:revisions). propose then ratify must EACH append one revision,
    // attributed to the right actor, with the flip captured in the snapshot.
    await rubrics.proposeRubric({
      rubricId: 'audited-rubric',
      characteristic: 'hive-coordination',
      title: 'Audited',
      criteria: sampleCriteria,
      by: 'author-a',
    });
    const afterPropose = await db.adminSql<
      { seq: number; content_hash: string; author_id: string; author_kind: string; rationale: string | null; content_snapshot: string }[]
    >`
      SELECT seq, content_hash, author_id, author_kind, rationale, content_snapshot
        FROM harness_shared.plan_revisions
       WHERE plan_slug = 'audited-rubric' ORDER BY seq ASC`;
    expect(afterPropose).toHaveLength(1); // the bug: this was 0
    expect(afterPropose[0].author_id).toBe('author-a'); // the proposer of record
    expect(afterPropose[0].author_kind).toBe('agent'); // a rubric write is an agent/Queen action
    expect(afterPropose[0].rationale).toContain('propose');
    expect(afterPropose[0].content_snapshot).toMatch(/status:\s*draft/); // proposed → draft plan
    // The markdown plan body intentionally keeps rubric fields in template_data;
    // the revision snapshot must nevertheless remain self-contained and retain
    // the criterion's grading prose for forensic comparison/recovery.
    expect(afterPropose[0].content_snapshot).toContain('Structured rubric data (`template_data`)');
    expect(afterPropose[0].content_snapshot).toContain(sampleCriteria[0].model);
    expect(afterPropose[0].content_snapshot).toContain(sampleCriteria[0].method);
    expect(afterPropose[0].content_snapshot).toContain(sampleCriteria[0].driftMarkers);
    expect(afterPropose[0].content_snapshot).toContain('"ratingScale"');
    const snapshotJson = afterPropose[0].content_snapshot.match(/~~~json\s*\n([\s\S]*?)\n~~~/)?.[1];
    expect(snapshotJson).toBeTruthy();
    const snapshot = JSON.parse(snapshotJson!) as {
      schemaVersion: number;
      templateData: { characteristic: string };
      criteriaHash: string;
    };
    expect(snapshot.schemaVersion).toBe(2);
    expect(snapshot.templateData.characteristic).toBe('hive-coordination');
    expect(snapshot.criteriaHash).toMatch(/^[a-f0-9]{64}$/);
    const [proposedPlan] = await db.adminSql<{ content_hash: string }[]>`
      SELECT content_hash FROM harness_shared.harness_plans WHERE plan_slug = 'audited-rubric'`;
    expect(afterPropose[0].content_hash).toBe(proposedPlan.content_hash); // canonical body hash, not enriched snapshot hash

    await rubrics.ratifyRubric('audited-rubric', 'queen-1');
    const afterRatify = await db.adminSql<
      { seq: number; content_hash: string; author_id: string; rationale: string | null; content_snapshot: string }[]
    >`
      SELECT seq, content_hash, author_id, rationale, content_snapshot
        FROM harness_shared.plan_revisions
       WHERE plan_slug = 'audited-rubric' ORDER BY seq ASC`;
    expect(afterRatify).toHaveLength(2); // a SECOND revision — the status-flip is now audited
    const ratifyRev = afterRatify[1];
    expect(ratifyRev.author_id).toBe('queen-1'); // the ratifier, not the author
    expect(ratifyRev.rationale).toContain('ratify');
    expect(ratifyRev.content_snapshot).toMatch(/status:\s*active/); // the destructive-class flip is captured
    expect(ratifyRev.content_snapshot).toContain(sampleCriteria[0].model); // structured prose survives the status flip
    const [activePlan] = await db.adminSql<{ content_hash: string }[]>`
      SELECT content_hash FROM harness_shared.harness_plans WHERE plan_slug = 'audited-rubric'`;
    expect(ratifyRev.content_hash).toBe(activePlan.content_hash);
  });

  it('reads an immutable historical rubric revision without falling back to current template_data', async () => {
    const rubricId = 'revision-addressed-rubric';
    await rubrics.proposeRubric({
      rubricId,
      characteristic: 'hive-coordination',
      title: 'Revision v1',
      criteria: sampleCriteria,
      status: 'active',
      by: 'author-a',
    });
    const v2Criteria = [
      ...sampleCriteria,
      {
        key: 'new-criterion',
        title: 'New criterion',
        model: 'The second revision carries an additional measurable contract.',
        method: 'Read the second revision snapshot and count this criterion.',
        driftMarkers: 'The criterion disappears from the current rubric.',
      },
    ];
    const current = await rubrics.proposeRubric({
      rubricId,
      characteristic: 'hive-coordination',
      title: 'Revision v2',
      criteria: v2Criteria,
      status: 'active',
      by: 'author-a',
    });

    expect(current.revision).toBe(2);
    const historical = await rubrics.getRubric(rubricId, 1);
    expect(historical).not.toBeNull();
    expect(historical!.revision).toBe(1);
    expect(historical!.title).toBe('Revision v2'); // current plan-row metadata is preserved
    expect(historical!.criteria).toHaveLength(sampleCriteria.length);
    expect(historical!.criteria.some((criterion) => criterion.key === 'new-criterion')).toBe(false);
    expect(historical!.criteriaHash).toBeTruthy();
    expect(historical!.criteriaHash).not.toBe(current.criteriaHash);
    expect(await rubrics.getRubric(rubricId, 99)).toBeNull();

    const [firstRevision] = await db.adminSql<{ content_snapshot: string }[]>`
      SELECT content_snapshot FROM harness_shared.plan_revisions
       WHERE plan_slug = ${rubricId} AND seq = 1`;
    const firstSnapshotJson = firstRevision.content_snapshot.match(/~~~json\s*\n([\s\S]*?)\n~~~/)?.[1];
    expect(firstSnapshotJson).toBeTruthy();
    const firstSnapshot = JSON.parse(firstSnapshotJson!) as { schemaVersion: number; criteriaHash: string };
    expect(firstSnapshot.schemaVersion).toBe(2);
    expect(historical!.criteriaHash).toBe(firstSnapshot.criteriaHash);

    // Simulate a revision written under an older hash algorithm: the structured
    // rubric is valid, but its pinned hash is deliberately different from the
    // current computation. Historical reads must honor the stored attestation.
    const [currentPlanRow] = await db.adminSql<{ template_data: Record<string, unknown> }[]>`
      SELECT template_data FROM harness_shared.harness_plans WHERE plan_slug = ${rubricId}`;
    const pinnedHash = '86b552e2de1bee03a65047056f772438998264572eb06b98983623178303ea5d';
    const pinnedSnapshot =
      '# pinned historical rubric\n\n' +
      '## Structured rubric data (`template_data`)\n\n' +
      '~~~json\n' +
      JSON.stringify(
        { schemaVersion: 2, templateData: currentPlanRow.template_data, criteriaHash: pinnedHash },
        null,
        2,
      ) +
      '\n~~~\n';
    await db.adminSql`
      INSERT INTO harness_shared.plan_revisions
        (workspace_id, harness_slug, plan_slug, seq, content_hash, content_snapshot,
         rationale, author_kind, author_id, created_at)
      VALUES (${activeWorkspaceId()}, 'papercusp', ${rubricId}, 3, md5('pinned'),
              ${pinnedSnapshot}, 'test', 'agent', 'test', 1)`;
    expect((await rubrics.getRubric(rubricId, 3))?.criteriaHash).toBe(pinnedHash);

    // A revision row without the enriched structured snapshot is not safe to grade:
    // the historical read must fail closed instead of using the current row.
    await db.adminSql`
      INSERT INTO harness_shared.plan_revisions
        (workspace_id, harness_slug, plan_slug, seq, content_hash, content_snapshot,
         rationale, author_kind, author_id, created_at)
      VALUES (${activeWorkspaceId()}, 'papercusp', ${rubricId}, 4, md5('malformed'),
              '# malformed historical rubric', 'test', 'agent', 'test', 1)`;
    expect(await rubrics.getRubric(rubricId, 4)).toBeNull();
  });

  it('ratify PRESERVES every criterion replication drill in template_data (EI-10443 — the status-flip must not strip them)', async () => {
    // The reported bug: rubrics:ratify's status-flip write DESTROYED criterion.replication
    // drills from template_data — whole-document revalidation silently dropped the then-
    // unknown key. WI-4287 made `replication` a first-class schema field, and ratifyRubric
    // now merges the RAW stored template_data through verbatim (only stamping ratifiedBy)
    // while the body write leaves template_data untouched on conflict — so the drills
    // survive. This pins that exact regression: a ratify must not lose a single drill.
    const criteriaWithDrills = [
      {
        key: 'placement-health',
        title: 'Placement health',
        model: 'The Queen places ready frontier items onto live bees within a cadence.',
        method: 'Count ready work_items with no claim older than the cadence.',
        driftMarkers: 'A growing backlog of ready-but-unplaced items.',
        replication:
          'DRILL A: seed 3 ready work_items → run placement → assert each lands on a live bee within the cadence → cleanup the seeded rows.',
      },
      {
        key: 'ideation-diversity',
        title: 'Ideation diversity',
        model: 'Scout lens weights drift away from uniform as grades steer ideation.',
        method: 'Inspect lens_weights; off-uniform 0.25 means grades are steering.',
        driftMarkers: 'Lens weights stuck uniform; repeated near-identical ideas.',
        replication:
          'DRILL B: propose N ideas → grade one lens up → assert lens_weights move off 0.25 → reset the weights.',
      },
    ];
    const expectedDrills = criteriaWithDrills.map((c) => c.replication);
    await rubrics.proposeRubric({
      rubricId: 'drills-rubric',
      characteristic: 'hive-coordination',
      title: 'Drills',
      criteria: criteriaWithDrills,
      by: 'author-a',
    });
    // Sanity: propose persisted every drill into the RAW template_data.
    const readDrills = async () => {
      const [row] = await db.adminSql<{ template_data: { criteria: { key: string; replication?: string }[] } }[]>`
        SELECT template_data FROM harness_shared.harness_plans
         WHERE plan_slug = 'drills-rubric' AND template = 'rubric'`;
      return row.template_data.criteria.map((c) => c.replication);
    };
    expect(await readDrills()).toEqual(expectedDrills);

    // Ratify with a DIFFERENT identity (D-012 author ≠ ratifier).
    const active = await rubrics.ratifyRubric('drills-rubric', 'queen-1');
    expect(active?.status).toBe('active');

    // The exact EI-10443 regression: every drill SURVIVES the status-flip write in the
    // RAW stored template_data (not silently stripped by the write pipeline)…
    expect(await readDrills()).toEqual(expectedDrills);
    // …and the projected rubric carries them too.
    expect(active?.criteria.map((c) => c.replication)).toEqual(expectedDrills);
  });

  it('D-012 enforced on persisted provenance: the proposer cannot ratify their own proposal', async () => {
    await rubrics.proposeRubric({ rubricId: 'selfy', characteristic: 'c', title: 'S', criteria: sampleCriteria, by: 'author-a' });
    await expect(rubrics.ratifyRubric('selfy', 'author-a')).rejects.toThrow(/author ≠ ratifier|cannot ratify their own/i);
    expect((await rubrics.getRubric('selfy'))?.status).toBe('proposed'); // nothing flipped
  });

  it('a re-propose moves the proposer of record to the reviser and DROPS the old ratification', async () => {
    await rubrics.proposeRubric({ rubricId: 'rev', characteristic: 'c', title: 'v1', criteria: sampleCriteria, by: 'author-a' });
    await rubrics.ratifyRubric('rev', 'queen-1');
    const revised = await rubrics.proposeRubric({ rubricId: 'rev', characteristic: 'c', title: 'v2', criteria: sampleCriteria, by: 'reviewer-b' });
    expect(revised.proposedBy).toBe('reviewer-b'); // NOT the plan owner (author-a)
    expect(revised.status).toBe('proposed'); // a revision needs re-ratification…
    expect(revised.ratifiedBy).toBeNull(); // …and the stale ratification is gone
    // The cross-party ratify then records honestly.
    const active = await rubrics.ratifyRubric('rev', 'author-a'); // a ≠ b, allowed
    expect(active?.ratifiedBy).toBe('author-a');
    expect(active?.proposedBy).toBe('reviewer-b');
  });

  it('amendRubric on an ACTIVE rubric preserves the ratifier of record (status is preserved, so provenance must be too)', async () => {
    await rubrics.proposeRubric({ rubricId: 'amendee', characteristic: 'c', title: 'A', criteria: sampleCriteria, by: 'author-a' });
    await rubrics.ratifyRubric('amendee', 'queen-1');
    const amended = await rubrics.amendRubric({
      rubricId: 'amendee',
      criterion: { key: 'placement-health', field: 'title', mode: 'replace', text: 'Placement health (amended)' },
      by: 'author-a',
    });
    expect(amended?.status).toBe('active');
    expect(amended?.ratifiedBy).toBe('queen-1'); // not dropped, not the amender
    expect(amended?.proposedBy).toBe('author-a');
  });

  it('amendRubric preserves hand-authored plan requirements, items, and decisions', async () => {
    const rubricId = 'amend-preserves-plan-narrative';
    await rubrics.proposeRubric({
      rubricId,
      characteristic: 'narrative-preservation',
      title: 'Narrative preservation',
      criteria: sampleCriteria,
      by: 'author-a',
    });

    const [before] = await db.adminSql<{ content: string; created: string }[]>`
      SELECT content, created::text AS created
        FROM harness_shared.harness_plans
       WHERE workspace_id = ${activeWorkspaceId()}
         AND harness_slug = 'papercusp'
         AND plan_slug = ${rubricId}`;
    expect(before).toBeDefined();
    const enriched = `${before.content}\n## Requirements\n- Preserve P-003 evidence.\n\n## Decisions\n### D-001 — Keep the acceptance context\n`;
    await db.adminSql`
      UPDATE harness_shared.harness_plans
         SET content = ${enriched}, content_hash = md5(${enriched}), version = version + 1
       WHERE workspace_id = ${activeWorkspaceId()}
         AND harness_slug = 'papercusp'
         AND plan_slug = ${rubricId}`;

    const amended = await rubrics.amendRubric({
      rubricId,
      criterion: { key: 'placement-health', field: 'title', mode: 'replace', text: 'Placement health (amended)' },
      by: 'author-a',
    });
    expect(amended?.rubricId).toBe(rubricId);

    const [after] = await db.adminSql<{ content: string; created: string }[]>`
      SELECT content, created::text AS created
        FROM harness_shared.harness_plans
       WHERE workspace_id = ${activeWorkspaceId()}
         AND harness_slug = 'papercusp'
         AND plan_slug = ${rubricId}`;
    expect(after.content).toContain('## Requirements');
    expect(after.content).toContain('Preserve P-003 evidence.');
    expect(after.content).toContain('### D-001 — Keep the acceptance context');
    expect(after.created).toBe(before.created);
    // Plan frontmatter uses `draft` for the rubric status `proposed`.
    expect(after.content).toMatch(/status:\s*draft/);
  });

  it('serializes concurrent amendments from the locked current snapshot (EI-21395928602431222)', async () => {
    const rubricId = 'concurrent-amendments';
    const criteria = Array.from({ length: 5 }, (_, index) => ({
      key: `criterion-${index}`,
      title: `Criterion ${index}`,
      model: `Model ${index}`,
      method: `Method ${index}`,
      driftMarkers: `Drift ${index}`,
    }));
    await rubrics.proposeRubric({
      rubricId,
      characteristic: 'concurrency',
      title: 'Concurrent amendments',
      criteria,
      by: 'seed-author',
    });

    await Promise.all(
      criteria.map((criterion, index) =>
        rubrics.amendRubric({
          rubricId,
          criterion: {
            key: criterion.key,
            field: 'replication',
            mode: 'replace',
            text: `REPLICATION DRILL ${index}: amend criterion ${index} and verify the persisted field.`,
          },
          ...(index === 0 ? { methodRef: 'concurrent-amendments-runbook' } : {}),
          by: `amender-${index}`,
        }),
      ),
    );

    const [row] = await db.adminSql<{
      template_data: { methodRef?: string; criteria: { key: string; replication?: string }[] };
    }[]>`
      SELECT template_data
        FROM harness_shared.harness_plans
       WHERE workspace_id = ${activeWorkspaceId()}
         AND harness_slug = 'papercusp'
         AND plan_slug = ${rubricId}`;
    expect(row.template_data.methodRef).toBe('concurrent-amendments-runbook');
    expect(row.template_data.criteria).toEqual(
      criteria.map((criterion, index) => ({
        ...criterion,
        replication: `REPLICATION DRILL ${index}: amend criterion ${index} and verify the persisted field.`,
      })),
    );
  });

  it('ratify of an unknown rubric returns null', async () => {
    expect(await rubrics.ratifyRubric('nope', 'q')).toBeNull();
  });

  it('status:active authors a ratified rubric directly', async () => {
    const r = await rubrics.proposeRubric({
      rubricId: 'seeded',
      characteristic: 'c',
      title: 'Seeded',
      criteria: sampleCriteria,
      status: 'active',
      by: 'seed',
    });
    expect(r.status).toBe('active');
    expect(r.ratifiedBy).toBe('seed');
  });

  it('acceptance re-propose tolerates blank optional prose from the legacy projection', async () => {
    const subjectPlan = 'acceptance-roundtrip-subject';
    await db.adminSql`
      INSERT INTO harness_shared.harness_plans
        (workspace_id, harness_slug, plan_slug, content, content_hash, version, title, status,
         created, updated, owner, archived, template, template_data, template_slug, origin)
      VALUES (${activeWorkspaceId()}, 'papercusp', ${subjectPlan}, '', md5(${subjectPlan}), 1,
              'Acceptance round-trip subject', 'active', '2026-08-22', '2026-08-22', 'su-test',
              false, NULL, '{}'::text::jsonb, NULL, 'local')`;

    const first = await rubrics.proposeRubric({
      rubricId: 'acceptance-empty-prose',
      kind: 'acceptance',
      subjectPlan,
      characteristic: 'acceptance-roundtrip',
      title: 'Acceptance round-trip',
      // Acceptance criteria may omit model/method, but the authoring contract
      // requires a concrete drift marker so the outcome remains falsifiable.
      criteria: [{
        key: 'outcome',
        title: 'Outcome',
        model: '',
        method: '',
        driftMarkers: 'the outcome regresses',
        check: { kind: 'instrument', instrumentKey: 'none' },
      }],
      by: 'su-test',
    });
    expect(first.status).toBe('active');

    const [stored] = await db.adminSql<{ template_data: { criteria: Record<string, unknown>[] } }[]>`
      SELECT template_data FROM harness_shared.harness_plans
       WHERE plan_slug = 'acceptance-empty-prose' AND template = 'rubric'`;
    expect(stored.template_data.criteria[0]).toEqual({
      key: 'outcome',
      title: 'Outcome',
      driftMarkers: 'the outcome regresses',
      check: { kind: 'instrument', instrumentKey: 'none' },
    });

    // getRubric maps the optional fields back to '' for the legacy Rubric shape. A
    // read → re-propose must accept that projection instead of rejecting the revision.
    const fromRead = await rubrics.getRubric('acceptance-empty-prose');
    const revised = await rubrics.proposeRubric({
      rubricId: fromRead!.rubricId,
      kind: fromRead!.kind,
      subjectPlan: fromRead!.subjectPlan!,
      characteristic: fromRead!.characteristic,
      title: fromRead!.title,
      criteria: fromRead!.criteria,
      by: 'su-reviser',
    });
    expect(revised.status).toBe('active');
  });

  it('canonicalizes BAR alias metadata and persists only the server-derived hash', async () => {
    const subjectPlan = 'canonical-bar-subject';
    await db.adminSql`
      INSERT INTO harness_shared.harness_plans
        (workspace_id, harness_slug, plan_slug, content, content_hash, version, title, status,
         created, updated, owner, archived, template, template_data, template_slug, origin)
      VALUES (${activeWorkspaceId()}, 'papercusp', ${subjectPlan}, '', md5(${subjectPlan}), 1,
              'Canonical BAR subject', 'draft', '2026-09-04', '2026-09-04', 'su-test',
              false, NULL, '{}'::text::jsonb, NULL, 'local')`;

    const bar = 'The activation path produces coverage-evidence rows.';
    const proposed = await rubrics.proposeRubric({
      rubricId: 'canonical-bar-rubric',
      kind: 'acceptance',
      subjectPlan,
      characteristic: 'plan-acceptance',
      title: 'Canonical BAR rubric',
      criteria: [
        {
          key: 'activation-outcome',
          title: 'Coverage activation exists',
          bar,
          barKey: 'R-7',
          barHash: '0'.repeat(64), // caller value must never become authority
          role: 'outcome',
          mandatory: true,
          requiredScope: ['surface:coverage-row', 'cohort:post-epoch', 'surface:coverage-row'],
          evidencePlane: 'tree',
          passRatings: ['PASS', 'pass'],
          driftMarkers: 'No coverage-evidence row exists for the activation path.',
          check: { kind: 'instrument', instrumentKey: 'none' },
          barProvenance: {
            lifecycle: 'pre-implementation',
            declaredAt: '2026-09-04T12:00:00.000Z',
            declaredBy: 'su-test',
          },
        },
      ],
      ratingScale: ['pass', 'fail', 'unknown'],
      by: 'su-test',
    });

    const criterion = proposed.criteria[0]!;
    expect(criterion.model).toBe(bar);
    expect(criterion.bar).toBe(bar);
    expect(criterion.barHash).toMatch(/^[a-f0-9]{64}$/);
    expect(criterion.barHash).not.toBe('0'.repeat(64));
    expect(criterion.requiredScope).toEqual(['cohort:post-epoch', 'surface:coverage-row']);
    expect(criterion.passRatings).toEqual(['pass']);

    const [stored] = await db.adminSql<{ template_data: { criteria: Record<string, unknown>[] } }[]>`
      SELECT template_data FROM harness_shared.harness_plans
       WHERE workspace_id = ${activeWorkspaceId()} AND harness_slug = 'papercusp'
         AND plan_slug = 'canonical-bar-rubric'`;
    expect(stored.template_data.criteria[0]).not.toHaveProperty('bar');
    expect(stored.template_data.criteria[0]).toMatchObject({
      model: bar,
      barKey: 'R-7',
      barHash: criterion.barHash,
      role: 'outcome',
      mandatory: true,
    });
  });

  it('refuses a second active acceptance rubric for the same subject plan', async () => {
    const subjectPlan = 'acceptance-unique-subject';
    await db.adminSql`
      INSERT INTO harness_shared.harness_plans
        (workspace_id, harness_slug, plan_slug, content, content_hash, version, title, status,
         created, updated, owner, archived, template, template_data, template_slug, origin)
      VALUES (${activeWorkspaceId()}, 'papercusp', ${subjectPlan}, '', md5(${subjectPlan}), 1,
              'Acceptance uniqueness subject', 'active', '2026-08-22', '2026-08-22', 'su-test',
              false, NULL, '{}'::text::jsonb, NULL, 'local')`;

    await rubrics.proposeRubric({
      rubricId: 'acceptance-unique-first',
      kind: 'acceptance',
      subjectPlan,
      characteristic: 'acceptance-uniqueness',
      title: 'Acceptance uniqueness first',
      criteria: [{
        key: 'outcome',
        title: 'Outcome',
        driftMarkers: 'the outcome regresses',
        check: { kind: 'instrument', instrumentKey: 'none' },
      }],
      by: 'su-first',
    });

    await expect(
      rubrics.proposeRubric({
        rubricId: 'acceptance-unique-second',
        kind: 'acceptance',
        subjectPlan,
        characteristic: 'acceptance-uniqueness',
        title: 'Acceptance uniqueness second',
        criteria: [{
          key: 'outcome',
          title: 'Outcome',
          driftMarkers: 'the outcome regresses',
          check: { kind: 'instrument', instrumentKey: 'none' },
        }],
        by: 'su-second',
      }),
    ).rejects.toThrow(/already has an active acceptance rubric.*acceptance-unique-first/i);

    const rows = await db.adminSql<{ count: string }[]>`
      SELECT count(*)::text AS count
        FROM harness_shared.harness_plans
       WHERE workspace_id = ${activeWorkspaceId()}
         AND template = 'rubric'
         AND template_data->>'kind' = 'acceptance'
         AND template_data->>'subjectPlan' = ${subjectPlan}`;
    expect(rows[0]?.count).toBe('1');
  });

  it('acceptance amend tolerates omitted optional prose from the legacy projection', async () => {
    const subjectPlan = 'acceptance-amend-subject';
    const rubricId = 'acceptance-amend-empty-prose';
    await db.adminSql`
      INSERT INTO harness_shared.harness_plans
        (workspace_id, harness_slug, plan_slug, content, content_hash, version, title, status,
         created, updated, owner, archived, template, template_data, template_slug, origin)
      VALUES (${activeWorkspaceId()}, 'papercusp', ${subjectPlan}, '', md5(${subjectPlan}), 1,
              'Acceptance amend subject', 'active', '2026-08-22', '2026-08-22', 'su-test',
              false, NULL, '{}'::text::jsonb, NULL, 'local')`;

    const first = await rubrics.proposeRubric({
      rubricId,
      kind: 'acceptance',
      subjectPlan,
      characteristic: 'acceptance-amend',
      title: 'Acceptance amend',
      criteria: [
        {
          key: 'outcome-a',
          title: 'Outcome A',
          driftMarkers: 'outcome A regresses',
          check: { kind: 'instrument', instrumentKey: 'none' },
        },
        { key: 'outcome-b', title: 'Outcome B', driftMarkers: 'outcome B regresses' },
      ],
      by: 'su-test',
    });
    expect(first.status).toBe('active');

    // amendRubric reads the legacy Rubric projection, where omitted acceptance prose
    // comes back as empty strings, then delegates the whole-document write to propose.
    // The write must normalize those blanks back to omissions instead of applying the
    // standard rubric's required model/method/driftMarkers validation.
    const amended = await rubrics.amendRubric({
      rubricId,
      methodRef: '/internal/docs/testing/agent-e2e',
      by: 'su-amender',
    });
    expect(amended).toMatchObject({
      rubricId,
      kind: 'acceptance',
      subjectPlan,
      status: 'active',
      methodRef: '/internal/docs/testing/agent-e2e',
    });
    // amendRubric returns `Rubric | null`; assert the non-null contract explicitly
    // rather than leaning on `!`, so a null return fails HERE with a readable
    // message instead of as a downstream property access on null.
    expect(amended).not.toBeNull();
    expect(amended!.criteria.map((criterion) => criterion.key)).toEqual(['outcome-a', 'outcome-b']);

    const [stored] = await db.adminSql<{ template_data: { criteria: Record<string, unknown>[]; methodRef: string } }[]>`
      SELECT template_data FROM harness_shared.harness_plans
       WHERE plan_slug = ${rubricId} AND template = 'rubric'`;
    expect(stored.template_data.methodRef).toBe('/internal/docs/testing/agent-e2e');
    expect(stored.template_data.criteria).toEqual([
      {
        key: 'outcome-a',
        title: 'Outcome A',
        driftMarkers: 'outcome A regresses',
        check: { kind: 'instrument', instrumentKey: 'none' },
      },
      { key: 'outcome-b', title: 'Outcome B', driftMarkers: 'outcome B regresses' },
    ]);
  });

  it('acceptance re-propose preserves a retired contract and its superseded rubric plan (EI-21296891484659125)', async () => {
    const subjectPlan = 'retired-acceptance-subject';
    const rubricId = 'retired-acceptance-contract';
    await db.adminSql`
      INSERT INTO harness_shared.harness_plans
        (workspace_id, harness_slug, plan_slug, content, content_hash, version, title, status,
         created, updated, owner, archived, template, template_data, template_slug, origin)
      VALUES (${activeWorkspaceId()}, 'papercusp', ${subjectPlan}, '', md5(${subjectPlan}), 1,
              'Retired acceptance subject', 'active', '2026-08-22', '2026-08-22', 'su-test',
              false, NULL, '{}'::text::jsonb, NULL, 'local')`;

    const initialCriteria = [{
      key: 'original-outcome',
      title: 'Original outcome',
      driftMarkers: 'the original outcome regresses',
      check: { kind: 'instrument' as const, instrumentKey: 'none' },
    }];
    const first = await rubrics.proposeRubric({
      rubricId,
      kind: 'acceptance',
      subjectPlan,
      characteristic: 'retired-acceptance-contract',
      title: 'Retired acceptance contract',
      criteria: initialCriteria,
      by: 'su-author',
    });
    // Calibration: the real writer and permanent wrong control agree for a NEW acceptance
    // rubric. The distinguishing case begins only after the lifecycle retirement below.
    expect(first.status).toBe(deliberatelyUnguardedAcceptanceProposeStatus());

    await db.adminSql`
      UPDATE harness_shared.harness_plans
         SET status = 'shipped'
       WHERE workspace_id = ${activeWorkspaceId()} AND harness_slug = 'papercusp'
         AND plan_slug = ${subjectPlan}`;
    expect(await rubrics.retireAcceptanceRubricForPlan(subjectPlan, 'su-shipper')).toBe(rubricId);
    expect((await rubrics.getRubric(rubricId))?.status).toBe('retired');

    // The unguarded implementation silently chooses active because the agent-facing path
    // has no status argument. Keep this wrong control permanently: if the production guard
    // disappears, the assertions below fail on the exact pre-fix behavior.
    expect(deliberatelyUnguardedAcceptanceProposeStatus()).toBe('active');
    const revised = await rubrics.proposeRubric({
      rubricId,
      kind: 'acceptance',
      subjectPlan,
      characteristic: 'retired-acceptance-contract',
      title: 'Retired acceptance contract',
      criteria: [
        ...initialCriteria,
        { key: 'added-after-ship', title: 'Added after ship', driftMarkers: 'the added-after-ship outcome regresses' },
      ],
      by: 'su-reviser',
    });

    expect(revised.status).toBe('retired');
    expect(revised.criteria.map((criterion) => criterion.key)).toEqual([
      'original-outcome',
      'added-after-ship',
    ]);
    const [rubricPlan] = await db.adminSql<{ status: string }[]>`
      SELECT status
        FROM harness_shared.harness_plans
       WHERE workspace_id = ${activeWorkspaceId()} AND harness_slug = 'papercusp'
         AND plan_slug = ${rubricId}`;
    expect(rubricPlan.status).toBe('superseded');
  });

  it('re-propose is an idempotent upsert — updates content, never a duplicate row', async () => {
    await rubrics.proposeRubric({ rubricId: 'seed', characteristic: 'c', title: 'v1', criteria: sampleCriteria, status: 'active', by: 'seed' });
    const r2 = await rubrics.proposeRubric({ rubricId: 'seed', characteristic: 'c', title: 'v2', criteria: sampleCriteria, status: 'active', by: 'seed' });
    expect(r2.title).toBe('v2');
    expect(r2.status).toBe('active');
    const all = await rubrics.listRubrics({});
    expect(all.filter((x) => x.rubricId === 'seed')).toHaveLength(1); // ON CONFLICT, not a second row
  });

  it('re-propose PERSISTS changed template_data — criteria/scale/description, not just the body (EI-11070 regression)', async () => {
    // v1: 2 criteria, 4-value scale, short description.
    await rubrics.proposeRubric({
      rubricId: 'drift-check',
      characteristic: 'c',
      title: 'Drift v1',
      description: 'short v1 description',
      criteria: sampleCriteria,
      ratingScale: ['healthy', 'degraded', 'broken', 'unknown'],
      status: 'active',
      by: 'seed',
    });
    // ATOMICITY (EI-11070): body + template_data land in ONE version bump. A fresh propose
    // is version 1 — the former two-transaction split bumped it to 2 (body, then a separate
    // template_data write), which is exactly the non-atomic seam the combined write closes.
    const [afterV1] = await db.adminSql<{ version: number }[]>`
      SELECT version FROM harness_shared.harness_plans WHERE plan_slug = 'drift-check' AND template = 'rubric'`;
    expect(Number(afterV1.version)).toBe(1);
    // v2: 3 criteria, a DIFFERENT 6-value scale, a longer description — the whole
    // template_data document changes. The pre-EI-11070 bug landed the body write
    // (title/status/updated_at) but SILENTLY skipped this template_data write, so the
    // row kept v1's 2 criteria / 4-value scale / short description while reporting ok.
    const threeCriteria = [
      ...sampleCriteria,
      { key: 'third-criterion', title: 'Third', model: 'a third model', method: 'a third method', driftMarkers: 'third drift' },
    ];
    const sixValueScale = ['exemplary', 'pass', 'partial', 'fail', 'severe', 'unknown'];
    const r2 = await rubrics.proposeRubric({
      rubricId: 'drift-check',
      characteristic: 'c',
      title: 'Drift v2',
      description: 'a substantially longer v2 description that differs from v1',
      criteria: threeCriteria,
      ratingScale: sixValueScale,
      status: 'active',
      by: 'seed',
    });
    // The returned projection reflects the new content…
    expect(r2.criteria).toHaveLength(3);
    expect(r2.ratingScale).toEqual(sixValueScale);
    expect(r2.description).toContain('longer v2');
    // …AND the RAW template_data jsonb in the DB actually changed (the bug left it at v1).
    const [row] = await db.adminSql<{ version: number; template_data: { criteria: unknown[]; ratingScale: string[]; description: string } }[]>`
      SELECT version, template_data FROM harness_shared.harness_plans
       WHERE plan_slug = 'drift-check' AND template = 'rubric'`;
    expect(row.template_data.criteria).toHaveLength(3);
    expect(row.template_data.ratingScale).toEqual(sixValueScale);
    expect(row.template_data.description).toContain('longer v2');
    // One more atomic bump: the re-propose is a single version increment (1 → 2), not two.
    expect(Number(row.version)).toBe(2);
    // …and the read projection resolves the new document too.
    const got = await rubrics.getRubric('drift-check');
    expect(got?.criteria).toHaveLength(3);
    expect(got?.ratingScale).toEqual(sixValueScale);
  });

  it('re-propose preserves the stored ratingScale when the whole-document input omits it', async () => {
    const storedScale = ['pass', 'partial', 'fail', 'not-measured'];
    await rubrics.proposeRubric({
      rubricId: 'preserve-omitted-scale',
      characteristic: 'c',
      title: 'Scale v1',
      criteria: sampleCriteria,
      ratingScale: storedScale,
      status: 'active',
      by: 'author-a',
    });

    const revised = await rubrics.proposeRubric({
      rubricId: 'preserve-omitted-scale',
      characteristic: 'c',
      title: 'Scale v2',
      criteria: sampleCriteria,
      status: 'active',
      by: 'reviewer-b',
    });

    expect(revised.ratingScale).toEqual(storedScale);
    const [row] = await db.adminSql<{ template_data: { ratingScale: string[] } }[]>`
      SELECT template_data
        FROM harness_shared.harness_plans
       WHERE plan_slug = 'preserve-omitted-scale'
         AND template = 'rubric'`;
    expect(row.template_data.ratingScale).toEqual(storedScale);
  });

  it('a malformed propose is rejected fail-loud, never persisting a half-state', async () => {
    await expect(
      rubrics.proposeRubric({ rubricId: 'bad', characteristic: '', title: 'Bad', criteria: [], by: 'x' }),
    ).rejects.toThrow(/invalid rubric data/i);
    expect(await rubrics.getRubric('bad')).toBeNull(); // nothing written
  });
});

describe('autoRatifyRubricOnFirstScorecard — grading a proposed rubric IS adoption (WI-5415)', () => {
  it('ratifies a PROPOSED rubric the first time a DIFFERENT agent grades it', async () => {
    await rubrics.proposeRubric({ rubricId: 'gr', characteristic: 'c', title: 'Gr', criteria: sampleCriteria, by: 'author-a' });
    const result = await rubrics.autoRatifyRubricOnFirstScorecard('gr', 'grader-b');
    expect(result?.status).toBe('active');
    expect(result?.ratifiedBy).toBe('grader-b');
    expect(result?.proposedBy).toBe('author-a');
    const stored = await rubrics.getRubric('gr');
    expect(stored?.status).toBe('active'); // durably persisted, not just returned
  });

  it('D-012: is a no-op when the grader IS the rubric proposer — stays proposed', async () => {
    await rubrics.proposeRubric({ rubricId: 'self', characteristic: 'c', title: 'Self', criteria: sampleCriteria, by: 'author-a' });
    const result = await rubrics.autoRatifyRubricOnFirstScorecard('self', 'author-a');
    expect(result).toBeNull();
    const stored = await rubrics.getRubric('self');
    expect(stored?.status).toBe('proposed'); // left untouched, awaiting a different ratifier
  });

  it('is a no-op on an already-ACTIVE rubric (nothing to adopt)', async () => {
    await rubrics.proposeRubric({ rubricId: 'already', characteristic: 'c', title: 'Already', criteria: sampleCriteria, status: 'active', by: 'author-a' });
    const result = await rubrics.autoRatifyRubricOnFirstScorecard('already', 'grader-b');
    expect(result).toBeNull();
    const stored = await rubrics.getRubric('already');
    expect(stored?.ratifiedBy).toBe('author-a'); // the original ratification is untouched
  });

  it('returns null (never throws) for an unknown rubricId', async () => {
    await expect(rubrics.autoRatifyRubricOnFirstScorecard('nope', 'grader-b')).resolves.toBeNull();
  });
});

describe('list / get / search over written rubrics', () => {
  beforeEach(async () => {
    await rubrics.proposeRubric({ rubricId: 'active-a', characteristic: 'hive-coordination', title: 'Active A', criteria: sampleCriteria, status: 'active', by: 's' });
    await rubrics.proposeRubric({ rubricId: 'proposed-b', characteristic: 'memory-recall', title: 'Proposed B', criteria: sampleCriteria, by: 's' });
  });

  it('list orders active-first, then proposed', async () => {
    const all = await rubrics.listRubrics({});
    expect(all.map((r) => r.rubricId)).toEqual(['active-a', 'proposed-b']);
  });

  it('list filters by status and by characteristic', async () => {
    expect((await rubrics.listRubrics({ status: 'active' })).map((r) => r.rubricId)).toEqual(['active-a']);
    expect((await rubrics.listRubrics({ characteristic: 'memory-recall' })).map((r) => r.rubricId)).toEqual(['proposed-b']);
  });

  it('get returns the full criteria; unknown id → null', async () => {
    const got = await rubrics.getRubric('active-a');
    expect(got?.criteria).toHaveLength(2);
    expect(got?.criteria[0].model).toContain('Queen places');
    expect(await rubrics.getRubric('missing')).toBeNull();
  });

  it('search matches over title / characteristic, and misses cleanly', async () => {
    expect((await rubrics.searchRubrics('coordination')).map((r) => r.rubricId)).toContain('active-a');
    expect((await rubrics.searchRubrics('memory')).map((r) => r.rubricId)).toContain('proposed-b');
    expect(await rubrics.searchRubrics('zzzznotarubric')).toEqual([]);
  });
});

// WI-976 regression — the store must scope reads/writes to the ACTIVE workspace
// (activeWorkspaceId()), NOT a hardcoded literal. The live bug (rubrics:list returned 0 so
// the Overwatch could not emit its required scorecard) was INVISIBLE to every other case
// in this suite: the test env's activeWorkspaceId() is 'default' — the same literal the
// buggy rubricsScopeWorkspace() hardcoded — so the read scope + the seed workspace always
// coincided and no mismatch could arise. In production the active workspace is
// 'papercusp-workspace' (where all plans + coord live), so the hardcoded 'default' scope
// missed the real rubric plan. This case pins a NON-'default' workspace to prove the scope
// FOLLOWS activeWorkspaceId(): a regression back to a hardcoded scope makes the reads below
// return [] / null and fails here.
describe('workspace scope follows activeWorkspaceId (WI-976 regression)', () => {
  it('resolves the rubric from the active workspace and isolates other workspaces', async () => {
    await insertRubricPlan('alpha-rubric', { workspaceId: 'ws-alpha' });
    await insertRubricPlan('beta-rubric', { workspaceId: 'ws-beta' });
    // Read pinned to ws-alpha → only ws-alpha's rubric (never ws-beta's; never []).
    const alpha = await runWithWorkspace('ws-alpha', () => rubrics.listRubrics({}));
    expect(alpha.map((r) => r.rubricId)).toEqual(['alpha-rubric']);
    const beta = await runWithWorkspace('ws-beta', () => rubrics.listRubrics({}));
    expect(beta.map((r) => r.rubricId)).toEqual(['beta-rubric']);
    // getRubric follows the same scope — ws-alpha cannot see ws-beta's rubric.
    expect(await runWithWorkspace('ws-alpha', () => rubrics.getRubric('beta-rubric'))).toBeNull();
    expect((await runWithWorkspace('ws-alpha', () => rubrics.getRubric('alpha-rubric')))?.rubricId).toBe(
      'alpha-rubric',
    );
  });
});

// ─── EI-21972673091438558: the template_data PERSISTENCE BOUNDARY ────────────────────
// A rubric IS a plan row and its criteria live in `template_data`. TWO doors write that
// column; only `rubrics:propose` used to be guarded. `plans:set-template-data` validates
// STRUCTURE ONLY — a criteria array of length 1 satisfies its zod schema exactly as well
// as one of length 27 — so a live rubric could be gutted through it without a word.
//
// The rules are unit-pinned in agent-tools/plans/rubric-loss-guard.test.ts. THESE cases
// pin the WIRING: that the guard actually runs on the generic door, against the row the
// transaction is replacing, and that a refusal leaves the stored rubric intact. Driving
// the SAME withPlanLock + evaluateSetTemplateData pair the tool handler uses is the point
// — asserting on the guard function alone would pass even if nothing called it.
describe('template_data persistence boundary — the set-template-data door', () => {
  // `authorMethods` performs the authoring step a real caller performs after
  // seeding (see the note at the end of this helper). It is OPT-IN because it
  // writes template_data, which advances clause revisions — cases that assert
  // exact revision numbers or history counts want the bare seed.
  async function seedBarContract(subject: string, opts: { authorMethods?: boolean } = {}) {
    const { seedAcceptanceBarsInTransaction } = await import('./acceptance-bar-seed');
    const { hashPlanContent } = await import('./agent-tools/plans/content-hash');
    const workspaceId = activeWorkspaceId();
    const content = `---\ntitle: METHOD pins\nslug: ${subject}\nstatus: active\n---\n\n## Requirements\n\n**R-1 — First outcome.** The first outcome holds.\n\n**R-2 — Second outcome.** The second outcome holds.\n\n## Design\n\n### Bar-to-work map for this plan\n\n| bar | implementing plan items | evidence plane |\n|---|---|---|\n| R-1 | P-001 | tree |\n| R-2 | P-002 | tree |\n\n## Work\n\n- **P-001** \`done\` first outcome\n- **P-002** \`done\` second outcome\n`;
    await db.adminSql`
      INSERT INTO harness_shared.harness_plans
        (workspace_id,harness_slug,plan_slug,content,content_hash,version,title,status,owner,acceptance_bar_epoch,acceptance_bar_cohort)
      VALUES (${workspaceId},'papercusp',${subject},${content},${hashPlanContent(content)},1,'METHOD pins','active','su-test',1,'post-epoch')`;
    for (const [index, item] of ['P-001', 'P-002'].entries()) {
      await db.adminSql`INSERT INTO harness_shared.plan_items
        (workspace_id,harness_slug,plan_slug,item_id,seq,status,item_text)
        VALUES (${workspaceId},'papercusp',${subject},${item},${index},'done',${item})`;
    }
    // The acceptance rubric this seed writes links to a STANDARD-kind class
    // rubric, and `assertAcceptanceLinksResolve` refuses a dangling classRef.
    // Nothing else in this file seeds one, so seed it here (idempotently — the
    // suite reuses one database across these cases).
    const [classRubricSeeded] = await db.adminSql`
      SELECT 1 FROM harness_shared.harness_plans
       WHERE workspace_id=${workspaceId} AND harness_slug='papercusp'
         AND plan_slug='plan-class-feature-ship'`;
    if (!classRubricSeeded) {
      await insertRubricPlan('plan-class-feature-ship', { workspaceId, title: 'Plan class — feature ship' });
    }
    const seeded = await db.adminSql.begin((tx) => seedAcceptanceBarsInTransaction({
      executor: tx as never, workspaceId, harnessSlug: 'papercusp', planSlug: subject,
      planContent: content, planTitle: 'METHOD pins', planStatus: 'active', planVersion: 1,
      adoptionEpoch: 1, cohort: 'post-epoch', classRef: 'plan-class-feature-ship', actorId: 'su-test',
      now: new Date('2026-09-05T00:00:00Z'),
    }));
    expect(seeded.ok).toBe(true);
    if (!seeded.ok) throw new Error(seeded.message);
    // acceptance-bar-seed deliberately leaves METHOD/checks blank for the author
    // to fill against as-built work — it seeds the literal placeholder "Fill
    // METHOD/checks against as-built work before grading". Real callers perform
    // that authoring step; this fixture did not, so once the pre-amendment
    // readiness gate landed every amendment path here refused with
    // bar_snapshot_method_missing / bar_snapshot_check_missing. Author them so
    // the fixture represents a contract that is actually ready to amend.
    if (opts.authorMethods) {
      const seededData = await storedTemplateData(seeded.rubricSlug);
      await setTemplateDataDoor(seeded.rubricSlug, {
        ...seededData,
        criteria: seededData.criteria.map((criterion) => ({
          ...criterion,
          method: 'Execute the seeded acceptance fixture.',
          check: { kind: 'tests', files: ['packages/operator-core/lib/acceptance-bar-seed.test.ts'] },
        })),
      });
    }
    return { ...seeded, workspaceId, subject };
  }

  it.each(['active', 'accepted', 'exempt'] as const)(
    'activation re-audit preserves an unchanged %s clause and its exact evidence revision',
    async (lifecycleStatus) => {
      const { workspaceId, subject, rubricSlug } = await seedBarContract(`reaudit-${lifecycleStatus}`);
      const { listSpecClauses, setSpecClause, specClauseContentHash } = await import('./agent-tools/plans/spec-clauses-store');
      const { recordCurrentActivationAudit } = await import('./plan-audits');
      const scope = { harnessSlug: 'papercusp', planSlug: subject };
      const initial = await listSpecClauses(scope);
      expect(initial).toHaveLength(2);
      expect(initial.map((clause) => clause.lifecycleStatus)).toEqual(['draft', 'draft']);
      const draft = initial[0]!;
      const exemption = lifecycleStatus === 'exempt'
        ? { reason: 'This clause requires a non-automated review.' }
        : undefined;
      const write = {
        ...draft,
        ...scope,
        expectedRevision: draft.revision,
        lifecycleStatus,
        ...(exemption ? { exemption } : {}),
        actorId: 'clause-reviewer',
      };
      expect(await setSpecClause(write)).toMatchObject({ status: 'revised', revision: 2 });
      const before = await listSpecClauses(scope);
      const reviewed = before[0]!;
      expect(reviewed).toMatchObject({ lifecycleStatus, revision: 2, exemption: exemption ?? null });
      if (lifecycleStatus === 'exempt') {
        expect(reviewed).toMatchObject({ acceptedBy: null, acceptedAt: null });
      } else {
        expect(reviewed).toMatchObject({ acceptedBy: 'clause-reviewer' });
        expect(reviewed.acceptedAt).not.toBeNull();
      }
      // Permanent pre-fix control: the old re-audit projection either demoted
      // a reviewed clause or preserved `exempt` while dropping its paired
      // exemption payload. Both change the current evidence revision.
      const preFixReplay = lifecycleStatus === 'exempt'
        ? { ...write, exemption: undefined }
        : { ...write, lifecycleStatus: 'draft' as const };
      expect(specClauseContentHash(preFixReplay)).not.toBe(reviewed.contentHash);

      await db.adminSql`
        INSERT INTO harness_shared.plan_revisions
          (workspace_id, harness_slug, plan_slug, seq, content_hash, content_snapshot,
           rationale, author_kind, author_id, created_at)
        SELECT workspace_id, harness_slug, plan_slug, 1, content_hash, content,
               'activation fixture', 'agent', 'su-test', 1
          FROM harness_shared.harness_plans
         WHERE workspace_id=${workspaceId} AND harness_slug='papercusp' AND plan_slug=${subject}`;
      const rubricBefore = await rubrics.getRubric(rubricSlug);
      const audit = await recordCurrentActivationAudit({
        workspaceId, harnessSlug: 'papercusp', planSlug: subject, createdBy: 'audit-reviewer',
        classRef: 'plan-class-feature-ship',
        activation: {
          sourceRanges: [{ sourceKind: 'codex', sessionId: 'reaudit-fixture', fromTurn: 0, toTurn: 0 }],
          mappings: ['P-001', 'P-002'].map((item, index) => ({
            id: `M-00${index + 1}`, sourceRefs: ['session_turn:codex:reaudit-fixture:0'],
            requirement: `Preserve outcome ${index + 1}`, planTargets: [item], disposition: 'covered' as const,
          })),
          repairedOmissions: [], rejectedOrSuperseded: [], unresolvedBlockers: [],
        },
      });
      expect(audit.ok).toBe(true);
      // Exact equality includes the revision, content hash, acceptance author,
      // acceptance time, and the untouched sibling's draft lifecycle.
      expect(await listSpecClauses(scope)).toEqual(before);
      expect((await listSpecClauses({ ...scope, includeHistory: true }))).toHaveLength(3);
      expect((await rubrics.getRubric(rubricSlug))?.revision).toBe(rubricBefore?.revision);
    },
  );

  it.each(['class', 'method'] as const)('preserves authored atomic clauses across a %s-only rubric revision', async (change) => {
    const seeded = await seedBarContract(`atomic-preservation-${change}`);
    const { listSpecClauses, setSpecClause } = await import('./agent-tools/plans/spec-clauses-store');
    const scope = { harnessSlug: 'papercusp', planSlug: seeded.subject };
    const draft = (await listSpecClauses(scope))[0]!;
    const authored = {
      behavior: 'The selected task remains complete after restarting the application.',
      behaviorClass: 'lifecycle' as const,
      requiredEvidence: ['Restart the application and read the selected task.'],
      requiredTestLayers: ['e2e', 'integration'],
      falsifier: { observation: 'The completed task reopens after restart.', probeMethod: 'Restart after completing one task.' },
      lifecycleStatus: 'accepted' as const,
    };
    await setSpecClause({ ...draft, ...scope, ...authored, expectedRevision: draft.revision, actorId: 'atomic-author' });
    const before = (await listSpecClauses(scope))[0]!;
    const rubricBefore = await rubrics.getRubric(seeded.rubricSlug);
    if (change === 'class') {
      // Re-affirm the SEEDED class, do not swap to a different one. amendRubric
      // deliberately refuses to REPLACE an existing acceptance class (rubrics.ts
      // — "an existing acceptance class cannot be replaced through this
      // amendment"): the class defines the bar-set the rubric inherits, so
      // swapping it mid-flight would invalidate the BAR contract. That guard
      // landed 2026-09-06 and this fixture predates it, which is why it began
      // refusing. A class-only revision is legal as an initial assignment or a
      // re-affirmation, and the re-affirmation still writes a full revision
      // (only an all-fields-undefined patch is "nothing to amend"), so this
      // keeps exercising what the test is named for: authored atomic clauses
      // surviving a rubric revision whose ONLY input is classRef.
      await rubrics.amendRubric({ rubricId: seeded.rubricSlug, classRef: 'plan-class-feature-ship' });
    } else {
      await rubrics.amendRubric({ rubricId: seeded.rubricSlug, criterion: {
        key: rubricBefore!.criteria[0]!.key, field: 'method', mode: 'append', text: 'Inspect the restart evidence.',
      } });
    }
    const rubricAfter = await rubrics.getRubric(seeded.rubricSlug);
    const after = (await listSpecClauses(scope))[0]!;
    expect(rubricAfter!.barSetHash).toBe(rubricBefore!.barSetHash);
    expect(after).toMatchObject(authored);
    expect(after.revision).toBe(before.revision + 1);
    expect(after.sourceBar).toEqual({ ...before.sourceBar, rubricRevision: rubricAfter!.revision });
    expect(after.acceptanceRef).toBe(`${seeded.rubricSlug}@${rubricAfter!.revision}:${before.sourceBar!.barKey}`);
  });

  it('previews a missing class bind without vetting an incomplete started BAR contract', async () => {
    const seeded = await seedBarContract('class-bind-preview-subject');
    const before = await rubrics.getRubric(seeded.rubricSlug);
    expect(before?.classRef).toBe('plan-class-feature-ship');

    // Model the repair this lane exists for: the acceptance contract has started,
    // but its class metadata was never persisted. The seeded fixture deliberately
    // leaves METHOD/check fields unfinished, as a draft plan does in production.
    await db.adminSql`
      UPDATE harness_shared.harness_plans
         SET template_data = template_data - 'classRef'
       WHERE workspace_id = ${seeded.workspaceId}
         AND harness_slug = 'papercusp'
         AND plan_slug = ${seeded.rubricSlug}`;
    await db.adminSql`
      UPDATE harness_shared.harness_plans
         SET status = 'draft'
       WHERE workspace_id = ${seeded.workspaceId}
         AND harness_slug = 'papercusp'
         AND plan_slug = ${seeded.subject}`;
    const [subject] = await db.adminSql<{ version: number }[]>`
      SELECT version
        FROM harness_shared.harness_plans
       WHERE workspace_id = ${seeded.workspaceId}
         AND harness_slug = 'papercusp'
         AND plan_slug = ${seeded.subject}`;

    const preview = await rubrics.previewAcceptanceBarAmendment({
      rubricId: seeded.rubricSlug,
      actorId: 'class-bind-preview-actor',
      reason: 'Bind the plan class before spec-quality evaluation.',
      classRef: 'plan-class-feature-ship',
      expectedRubricRevision: before!.revision,
      expectedSubjectPlanRevision: Number(subject!.version),
    });

    expect(preview).toMatchObject({
      changedBars: [],
      approvalRequired: false,
      priorBarSetHash: before!.barSetHash,
      nextBarSetHash: before!.barSetHash,
      revisionMovement: {
        rubric: { from: before!.revision, to: before!.revision! + 1 },
        subject: { from: Number(subject!.version), to: Number(subject!.version) },
      },
    });
    expect(preview!.changes).not.toContainEqual(expect.objectContaining({ kind: 'meaning' }));
    expect((await rubrics.getRubric(seeded.rubricSlug))?.classRef).toBeUndefined();

    const applied = await rubrics.amendRubric({
      rubricId: seeded.rubricSlug,
      actorId: 'class-bind-preview-actor',
      classRef: 'plan-class-feature-ship',
      expectedRubricRevision: before!.revision,
    });
    expect(applied?.classRef).toBe('plan-class-feature-ship');
  });

  it('rebinds terminal work items from superseded BAR revisions without rewriting history', async () => {
    const seeded = await seedBarContract('terminal-rebind-subject', { authorMethods: true });
    const { workspaceId, subject } = seeded;
    const before = (await rubrics.getRubric(seeded.rubricSlug))!;
    const explicitWorkItemId = 'WI-rubrics-terminal-rebind-explicit';
    const provenanceWorkItemId = 'WI-rubrics-terminal-rebind-provenance';

    // One terminal item is discoverable only through its existing historical edge;
    // the other is discoverable through canonical plan provenance. Both must be
    // carried forward when the BAR revision changes, even though neither item is
    // claimable anymore.
    await db.adminSql`
      DELETE FROM harness_shared.work_item_spec_revision_edges
       WHERE workspace_id=${workspaceId} AND harness_slug='papercusp'
         AND work_item_id = ANY(${[explicitWorkItemId, provenanceWorkItemId]}::text[])`;
    await db.adminSql`
      DELETE FROM harness_shared.work_items
       WHERE workspace_id=${workspaceId} AND harness_slug='papercusp'
         AND feature_id = ANY(${[explicitWorkItemId, provenanceWorkItemId]}::text[])`;
    await db.adminSql`
      INSERT INTO harness_shared.work_items
        (workspace_id, harness_slug, feature_id, item_kind, title, status,
         source_plan_slug, source_plan_item_ids, payload)
      VALUES
        (${workspaceId}, 'papercusp', ${explicitWorkItemId}, 'feature', 'Terminal explicit coverage', 'done',
         NULL, NULL, '{}'::jsonb),
        (${workspaceId}, 'papercusp', ${provenanceWorkItemId}, 'feature', 'Terminal provenance coverage', 'done',
         ${subject}, ARRAY['P-002'], ${JSON.stringify({ plan_item: { slug: subject, item: 'P-002' } })}::jsonb)`;
    await db.adminSql`
      INSERT INTO harness_shared.work_item_spec_revision_edges
        (workspace_id, harness_slug, work_item_id, plan_slug, spec_id,
         spec_revision, spec_fingerprint, created_by)
      SELECT c.workspace_id, c.harness_slug, ${explicitWorkItemId}, c.plan_slug,
             c.spec_id, c.current_revision, r.content_hash, 'terminal-rebind-fixture'
        FROM harness_shared.plan_spec_clauses c
        JOIN harness_shared.plan_spec_clause_revisions r
          ON r.workspace_id=c.workspace_id AND r.harness_slug=c.harness_slug
         AND r.plan_slug=c.plan_slug AND r.spec_id=c.spec_id AND r.revision=c.current_revision
       WHERE c.workspace_id=${workspaceId} AND c.harness_slug='papercusp'
         AND c.plan_slug=${subject} AND r.source_bar_key='R-1'`;
    await db.adminSql`
      INSERT INTO harness_shared.work_item_spec_revision_edges
        (workspace_id, harness_slug, work_item_id, plan_slug, spec_id,
         spec_revision, spec_fingerprint, created_by)
      SELECT c.workspace_id, c.harness_slug, ${provenanceWorkItemId}, c.plan_slug,
             c.spec_id, c.current_revision, r.content_hash, 'terminal-rebind-fixture'
        FROM harness_shared.plan_spec_clauses c
        JOIN harness_shared.plan_spec_clause_revisions r
          ON r.workspace_id=c.workspace_id AND r.harness_slug=c.harness_slug
         AND r.plan_slug=c.plan_slug AND r.spec_id=c.spec_id AND r.revision=c.current_revision
       WHERE c.workspace_id=${workspaceId} AND c.harness_slug='papercusp'
         AND c.plan_slug=${subject} AND r.source_bar_key='R-2'`;

    const priorEdges = await db.adminSql<{ work_item_id: string; spec_id: string; spec_revision: number }[]>`
      SELECT work_item_id, spec_id, spec_revision
        FROM harness_shared.work_item_spec_revision_edges
       WHERE workspace_id=${workspaceId} AND harness_slug='papercusp' AND plan_slug=${subject}
       ORDER BY work_item_id, spec_id`;
    expect(priorEdges).toHaveLength(2);

    const amendment = {
      rubricId: seeded.rubricSlug,
      actorId: 'terminal-rebind-actor',
      reason: 'Refresh terminal work-item coverage after a BAR meaning change.',
      criterion: {
        key: before.criteria[0]!.key,
        field: 'driftMarkers',
        mode: 'replace',
        text: 'The terminal coverage edge still points at a superseded BAR revision.',
      },
    };
    const after = await rubrics.amendRubric({
      ...amendment,
      approvalRef: await postApproval(amendment),
    });
    expect(after!.revision).toBe(before.revision! + 1);

    const edges = await db.adminSql<{
      work_item_id: string;
      spec_id: string;
      spec_revision: number;
      current_revision: number;
    }[]>`
      SELECT e.work_item_id, e.spec_id, e.spec_revision, c.current_revision
        FROM harness_shared.work_item_spec_revision_edges e
        JOIN harness_shared.plan_spec_clauses c
          ON c.workspace_id=e.workspace_id AND c.harness_slug=e.harness_slug
         AND c.plan_slug=e.plan_slug AND c.spec_id=e.spec_id
       WHERE e.workspace_id=${workspaceId} AND e.harness_slug='papercusp'
         AND e.plan_slug=${subject}
         AND e.work_item_id = ANY(${[explicitWorkItemId, provenanceWorkItemId]}::text[])
       ORDER BY e.work_item_id, e.spec_id, e.spec_revision`;
    expect(edges).toHaveLength(4);
    expect(edges.filter((edge) => edge.spec_revision === edge.current_revision)).toEqual([
      expect.objectContaining({ work_item_id: explicitWorkItemId, spec_id: 'AUTO-BAR-R-1-P-001' }),
      expect.objectContaining({ work_item_id: provenanceWorkItemId, spec_id: 'AUTO-BAR-R-2-P-002' }),
    ]);
    expect(edges.filter((edge) => edge.spec_revision !== edge.current_revision)).toEqual([
      expect.objectContaining({ work_item_id: explicitWorkItemId, spec_id: 'AUTO-BAR-R-1-P-001' }),
      expect.objectContaining({ work_item_id: provenanceWorkItemId, spec_id: 'AUTO-BAR-R-2-P-002' }),
    ]);
  });

  it('advances all BAR revision pins with a METHOD edit and rolls back a late projection refusal', async () => {
    const seeded = await seedBarContract('method-pin-subject', { authorMethods: true });
    const { workspaceId, subject } = seeded;
    const before = await rubrics.getRubric(seeded.rubricSlug);
    const data = await storedTemplateData(seeded.rubricSlug);
    const preview = await rubrics.previewAcceptanceBarAmendment({
      rubricId: seeded.rubricSlug, actorId: 'method-author',
      criterion: { key: before!.criteria[0]!.key, field: 'method', mode: 'replace', text: 'Run the current fixture.' },
    });
    expect(preview).toMatchObject({ approvalRequired: false, priorBarSetHash: before!.barSetHash,
      nextBarSetHash: before!.barSetHash, cohortDisposition: { cohort: 'post-epoch', action: 'preserve' } });
    expect(preview!.changes).toContainEqual(expect.objectContaining({ barKey: 'R-1', kinds: ['method-only'] }));
    expect(preview!.sourceSnapshotHash).toMatch(/^[a-f0-9]{64}$/);
    expect((await rubrics.getRubric(seeded.rubricSlug))!.revision).toBe(before!.revision);
    const next = { ...data, criteria: data.criteria.map((criterion) => ({
      ...criterion, method: 'Execute the current integration fixture.',
      check: { kind: 'tests', files: ['packages/operator-core/lib/acceptance-bar-seed.test.ts'] },
    })) };
    const written = await setTemplateDataDoor(seeded.rubricSlug, next);
    expect(written.kind).toBe('applied');
    const after = await rubrics.getRubric(seeded.rubricSlug);
    expect(after!.barSetHash).toBe(before!.barSetHash);
    expect(after!.criteria.map((criterion) => criterion.barHash)).toEqual(before!.criteria.map((criterion) => criterion.barHash));
    const [pin] = await db.adminSql`SELECT acceptance_bar_rubric_revision FROM harness_shared.harness_plans
      WHERE workspace_id=${workspaceId} AND harness_slug='papercusp' AND plan_slug=${subject}`;
    expect(Number(pin.acceptance_bar_rubric_revision)).toBe(after!.revision);
    const projections = await db.adminSql`SELECT r.source_rubric_revision FROM harness_shared.plan_spec_clauses c
      JOIN harness_shared.plan_spec_clause_revisions r USING (workspace_id,harness_slug,plan_slug,spec_id)
      WHERE c.workspace_id=${workspaceId} AND c.harness_slug='papercusp' AND c.plan_slug=${subject}
        AND r.revision=c.current_revision`;
    expect(projections).toHaveLength(2);
    expect(projections.map((row) => Number(row.source_rubric_revision))).toEqual([after!.revision, after!.revision]);
    const [history] = await db.adminSql`SELECT count(*)::int AS n FROM harness_shared.plan_spec_clause_revisions
      WHERE workspace_id=${workspaceId} AND harness_slug='papercusp' AND plan_slug=${subject}`;
    // 6, not 4: seedBarContract({ authorMethods: true }) now performs the
    // authoring write a real caller performs (2 seed + 2 author + 2 amend).
    // The assertion still pins that the amendment advanced BOTH clause pins.
    expect(history.n).toBe(6);

    // Append a divergent projection in this isolated database to trigger a
    // refusal AFTER the rubric UPDATE, preserving the immutable prior rows.
    const { setSpecClause } = await import('./agent-tools/plans/spec-clauses-store');
    // DERIVE the CAS baseline rather than hardcoding it. This was `2`, which was
    // correct only while seeding wrote exactly one clause revision; once
    // seedBarContract({ authorMethods: true }) added the authoring write a real
    // caller performs, the clause sits at 3 (seed + author + amend) and the
    // hardcoded baseline failed as a CAS 'conflict' — a stale fixture, not a
    // defect in the store. Reading it keeps the next fixture change from
    // re-stranding this the same way.
    const [clauseRow] = await db.adminSql`SELECT current_revision FROM harness_shared.plan_spec_clauses
      WHERE workspace_id=${workspaceId} AND harness_slug='papercusp'
        AND plan_slug=${subject} AND spec_id='AUTO-BAR-R-1-P-001'`;
    const divergent = await db.adminSql.begin((tx) => setSpecClause({
      planSlug: subject, specId: 'AUTO-BAR-R-1-P-001', expectedRevision: Number(clauseRow!.current_revision),
      planItemId: 'P-001', behavior: after!.criteria[0]!.model,
      behaviorClass: 'happy-path', lifecycleStatus: 'draft', actorId: 'fixture',
      sourceBar: { barKey: 'R-999', barHash: after!.criteria[0]!.barHash!,
        barSetHash: after!.barSetHash!, rubricSlug: seeded.rubricSlug,
        rubricRevision: after!.revision!, evidencePlane: 'tree' },
    }, { executor: tx as never, workspaceId, harnessSlug: 'papercusp' }));
    expect(divergent.status).toBe('revised');
    await expect(setTemplateDataDoor(seeded.rubricSlug, next)).rejects.toThrow(/acceptance_bar_revision_/);
    expect((await rubrics.getRubric(seeded.rubricSlug))!.revision).toBe(after!.revision);
  });

  it('advances unchanged BAR projections on a semantic amendment and rolls back both plans on a late failure', async () => {
    const seeded = await seedBarContract('semantic-pin-subject', { authorMethods: true });
    const { workspaceId, subject } = seeded;
    const before = await rubrics.getRubric(seeded.rubricSlug);
    const amendment = {
      rubricId: seeded.rubricSlug,
      criterion: { key: before!.criteria[0]!.key, field: 'driftMarkers' as const,
        mode: 'replace' as const, text: 'The first outcome is absent after the transaction commits.' },
      actorId: 'amendment-actor', reason: 'Make the falsifier observable.',
      approvedBy: 'outside-reviewer',
    };
    await expect(rubrics.amendRubric({ ...amendment, approvalRef: 'fixture:outside-approval' }))
      .rejects.toThrow('acceptance_bar_approval_required');
    const approvalRef = await postApproval(amendment);
    await expect(rubrics.amendRubric({ ...amendment, approvalRef, approvedBy: 'spoofed-reviewer' }))
      .rejects.toThrow('acceptance_bar_approval_author_mismatch');
    const accepted = { ...amendment, approvalRef, approvedAt: '2000-01-01T00:00:00Z',
      idempotencyKey: 'semantic-amendment-replay', expectedRubricRevision: before!.revision };
    const after = await rubrics.amendRubric(accepted);
    expect(after).not.toBeNull();
    const current = await rubrics.getRubric(seeded.rubricSlug);
    expect(current!.barSetHash).not.toBe(before!.barSetHash);
    expect(current!.criteria[1]!.barHash).toBe(before!.criteria[1]!.barHash);
    const replayed = await rubrics.amendRubric(accepted);
    expect(replayed!.barSetHash).toBe(current!.barSetHash);
    expect((await rubrics.getRubric(seeded.rubricSlug))!.revision).toBe(current!.revision);
    await expect(rubrics.amendRubric({ ...accepted, reason: 'Reuse the token for a different request.' }))
      .rejects.toThrow('acceptance_bar_amendment_replay_conflict');
    const projections = await db.adminSql`SELECT r.source_rubric_revision, r.source_bar_set_hash
      FROM harness_shared.plan_spec_clauses c
      JOIN harness_shared.plan_spec_clause_revisions r USING (workspace_id,harness_slug,plan_slug,spec_id)
      WHERE c.workspace_id=${workspaceId} AND c.harness_slug='papercusp' AND c.plan_slug=${subject}
        AND r.revision=c.current_revision ORDER BY c.spec_id`;
    expect(projections).toHaveLength(2);
    expect(projections.map((row) => Number(row.source_rubric_revision))).toEqual([current!.revision, current!.revision]);
    expect(projections.map((row) => row.source_bar_set_hash)).toEqual([current!.barSetHash, current!.barSetHash]);
    const [subjectBeforeFailure] = await db.adminSql`SELECT content, version, acceptance_bar_rubric_revision
      FROM harness_shared.harness_plans WHERE workspace_id=${workspaceId}
        AND harness_slug='papercusp' AND plan_slug=${subject}`;
    expect(Number(subjectBeforeFailure.acceptance_bar_rubric_revision)).toBe(current!.revision);
    expect(subjectBeforeFailure.content).toContain('Approved-By: outside-reviewer');
    expect(subjectBeforeFailure.content).not.toContain('Approved-At: 2000-01-01');
    const nextAmendment = { ...amendment,
      criterion: { ...amendment.criterion, text: 'The first outcome is absent or has the wrong value.' },
    };
    await expect(rubrics.amendRubric({ ...nextAmendment, approvalRef }))
      .rejects.toThrow('acceptance_bar_approval_stale_or_mismatched');
    await expect(rubrics.amendRubric({ ...nextAmendment,
      approvalRef: await postApproval(nextAmendment),
      faultInjection: 'after-projection',
    })).rejects.toThrow('acceptance_bar_amendment_fault_injected:after-projection');
    expect((await rubrics.getRubric(seeded.rubricSlug))!.revision).toBe(current!.revision);
    const [subjectAfterFailure] = await db.adminSql`SELECT content, version, acceptance_bar_rubric_revision
      FROM harness_shared.harness_plans WHERE workspace_id=${workspaceId}
        AND harness_slug='papercusp' AND plan_slug=${subject}`;
    expect(subjectAfterFailure).toEqual(subjectBeforeFailure);
    const [history] = await db.adminSql`SELECT count(*)::int AS n FROM harness_shared.plan_spec_clause_revisions
      WHERE workspace_id=${workspaceId} AND harness_slug='papercusp' AND plan_slug=${subject}`;
    // 6, not 4: seedBarContract({ authorMethods: true }) now performs the
    // authoring write a real caller performs (2 seed + 2 author + 2 amend).
    // The assertion still pins that the amendment advanced BOTH clause pins.
    expect(history.n).toBe(6);
  });

  it('adds a declared BAR with structured checks through the existing atomic amendment path', async () => {
    const seeded = await seedBarContract('criteria-set-addition-subject', { authorMethods: true });
    const before = await rubrics.getRubric(seeded.rubricSlug);
    const [subject] = await db.adminSql<{ content: string; version: number }[]>`
      SELECT content, version FROM harness_shared.harness_plans
       WHERE workspace_id=${seeded.workspaceId} AND harness_slug='papercusp'
         AND plan_slug=${seeded.subject}`;
    const nextContent = subject!.content
      .replace('\n\n## Design', '\n\n**R-3 — Third outcome.** The third outcome holds.\n\n## Design')
      .replace('| R-2 | P-002 | tree |', '| R-2 | P-002 | tree |\n| R-3 | P-003 | tree |')
      .replace(
        '- **P-002** `done` second outcome',
        '- **P-002** `done` second outcome\n- **P-003** `todo` third outcome',
      );
    await db.adminSql`
      UPDATE harness_shared.harness_plans
         SET content=${nextContent}, content_hash=md5(${nextContent}), version=version+1
       WHERE workspace_id=${seeded.workspaceId} AND harness_slug='papercusp'
         AND plan_slug=${seeded.subject}`;
    await db.adminSql`
      INSERT INTO harness_shared.plan_items
        (workspace_id,harness_slug,plan_slug,item_id,seq,status,item_text)
      VALUES (${seeded.workspaceId},'papercusp',${seeded.subject},'P-003',3,'todo','third outcome')`;
    // Advance the rubric's subject-plan pin to match the version bumped above.
    // The readiness gate refuses when `barContract.subjectPlanRevision !==
    // plan.revision` (acceptance-bar-contract-snapshot.ts, third clause of
    // bar_snapshot_rubric_revision_mismatch). Real callers never hit that,
    // because every plan write goes through the door that re-pins it — this
    // fixture edits harness_plans with raw SQL, so it has to re-pin too. Mirror
    // the production writer exactly (acceptance-bar-amendment.ts:130) rather
    // than inventing a fixture-only re-pin that could drift from it.
    await db.adminSql`
      UPDATE harness_shared.harness_plans
         SET template_data = jsonb_set(template_data, '{barContract,subjectPlanRevision}',
               to_jsonb(${Number(subject!.version) + 1}::int))
       WHERE workspace_id=${seeded.workspaceId} AND harness_slug='papercusp'
         AND plan_slug=${seeded.rubricSlug}`;

    const check = {
      kind: 'tests' as const,
      files: ['packages/operator-core/lib/acceptance-bar-amendment.test.ts'],
    };
    const criteria = [
      ...before!.criteria.map((criterion) => ({
        ...criterion,
        method: `Run the focused test for ${criterion.barKey}.`,
        check,
      })),
      rubrics.normalizeAcceptanceBarCriterion({
        key: 'r-3',
        title: 'Third outcome',
        model: 'Third outcome. The third outcome holds.',
        method: 'Run the focused test for R-3.',
        driftMarkers: 'R-3 is falsified when the third outcome is absent.',
        barKey: 'R-3',
        role: 'outcome',
        mandatory: true,
        requiredScope: ['tree'],
        evidencePlane: 'tree',
        passRatings: ['healthy'],
        barProvenance: {
          lifecycle: 'legacy-backfilled',
          declaredAt: '2026-09-05T12:00:00.000Z',
          declaredBy: 'amendment-actor',
        },
        check,
      }),
    ];
    const amendment = {
      rubricId: seeded.rubricSlug,
      actorId: 'amendment-actor',
      reason: 'Add the newly declared R-3 and bind runnable checks across the complete set.',
      expectedRubricRevision: before!.revision,
      expectedSubjectPlanRevision: Number(subject!.version) + 1,
      criteria,
    };
    const preview = await rubrics.previewAcceptanceBarAmendment(amendment);
    expect(preview).toMatchObject({
      changedBars: ['R-3'],
      approvalRequired: true,
      projectionCount: 3,
      // rubric starts at 2, not 1: seeding now authors METHOD/check first.
      revisionMovement: { rubric: { from: 2, to: 3 }, subject: { from: 2, to: 3 } },
    });
    expect(preview!.approval.bars).toEqual([expect.objectContaining({ barKey: 'R-3', priorBarHash: null })]);
    expect(preview!.changes).toContainEqual(expect.objectContaining({ barKey: 'R-3', kinds: ['added'] }));

    const approvalRef = await postApproval(amendment);
    const after = await rubrics.amendRubric({ ...amendment, approvalRef });
    expect(after!.criteria).toHaveLength(3);
    expect(after!.criteria.every((criterion) => criterion.method && criterion.check?.kind === 'tests')).toBe(true);
    const projections = await db.adminSql<
      Array<{
        spec_id: string;
        source_bar_key: string;
        plan_item_id: string;
        source_rubric_revision: number;
      }>
    >`
      SELECT c.spec_id, r.source_bar_key, r.plan_item_id, r.source_rubric_revision
        FROM harness_shared.plan_spec_clauses c
        JOIN harness_shared.plan_spec_clause_revisions r USING (workspace_id,harness_slug,plan_slug,spec_id)
       WHERE c.workspace_id=${seeded.workspaceId} AND c.harness_slug='papercusp'
         AND c.plan_slug=${seeded.subject} AND r.revision=c.current_revision
       ORDER BY c.spec_id`;
    expect(projections).toHaveLength(3);
    expect(projections).toContainEqual(
      expect.objectContaining({
        spec_id: 'AUTO-BAR-R-3-P-003',
        source_bar_key: 'R-3',
        plan_item_id: 'P-003',
        // DERIVED, not hardcoded: the projection is stamped with the rubric revision the
        // amendment produced. The concrete arithmetic is already asserted above by
        // revisionMovement { rubric: { from: 2, to: 3 } }, so deriving here loses no coverage
        // and survives the next seedBarContract() fixture change (same pattern as the
        // source_rubric_revision assertions at the atomic-author and semantic-replay tests).
        source_rubric_revision: after!.revision,
      }),
    );
    const [pinned] = await db.adminSql<
      Array<{
        version: number;
        acceptance_bar_rubric_revision: number;
        acceptance_bar_set_hash: string;
      }>
    >`
      SELECT version, acceptance_bar_rubric_revision, acceptance_bar_set_hash
        FROM harness_shared.harness_plans
       WHERE workspace_id=${seeded.workspaceId} AND harness_slug='papercusp'
         AND plan_slug=${seeded.subject}`;
    expect(Number(pinned!.version)).toBe(3);
    // DERIVED, matching this file's own convention for this exact property (the atomic-author
    // test asserts it as after!.revision, the replay test as current!.revision) and the
    // barSetHash line directly below. The concrete arithmetic stays pinned by revisionMovement
    // above; hardcoding it here only re-encoded how many times the fixture authored first.
    expect(Number(pinned!.acceptance_bar_rubric_revision)).toBe(after!.revision);
    expect(pinned!.acceptance_bar_set_hash).toBe(after!.barSetHash);
  });

  async function postApproval(input: Parameters<typeof rubrics.amendRubric>[0], author = 'outside-reviewer') {
    const preview = await rubrics.previewAcceptanceBarAmendment(input);
    expect(preview).not.toBeNull();
    const workspaceId = activeWorkspaceId();
    const thread = `approval-${preview!.approval.subjectPlan}`;
    await db.adminSql`INSERT INTO harness_shared.coord_threads (workspace_id,thread_id,parent_kind,parent_ref)
      VALUES (${workspaceId},${thread},'plan',${preview!.approval.subjectPlan}) ON CONFLICT DO NOTHING`;
    const [post] = await db.adminSql`INSERT INTO harness_shared.coord_thread_posts
      (workspace_id,thread_id,author_id,body) VALUES
      (${workspaceId},${thread},${author},${JSON.stringify(preview!.approval)}) RETURNING id`;
    return `thread-post:${post.id}`;
  }

  it('authors unified sections through proposal preflight and stores only canonical promise and method fields', async () => {
    const workspaceId = activeWorkspaceId();
    const subject = 'unified-proposal-subject';
    await db.adminSql`INSERT INTO harness_shared.harness_plans
      (workspace_id,harness_slug,plan_slug,content,content_hash,version,title,status,owner)
      VALUES (${workspaceId},'papercusp',${subject},'# Export',md5('# Export'),1,'Export','active','su-test')`;
    const proposed = await rubrics.proposeRubric({
      rubricId: 'unified-proposal-acceptance', kind: 'acceptance', subjectPlan: subject,
      characteristic: 'plan-acceptance', title: 'Complete export', by: 'requirement-author',
      criteria: [{
        key: 'complete-export', title: 'Complete export',
        intent: { request: 'Export every record.', sourceRefs: ['request:export'] },
        acceptance: { condition: 'The export contains every selected record.',
          falsifier: 'A selected record is missing.', requiredScope: ['tree'],
          requiredTestLayers: ['integration'], evidencePlane: 'tree',
          role: 'outcome', mandatory: true, passRatings: ['healthy'] },
        verification: { method: 'Run the export fixture.',
          check: { kind: 'tests', files: ['packages/operator-core/lib/acceptance-bar-seed.test.ts'] } },
      }],
    });
    expect(proposed.criteria[0]).toMatchObject({
      key: 'complete-export', intent: { request: 'Export every record.', sourceRefs: ['request:export'] },
      model: 'The export contains every selected record.', driftMarkers: 'A selected record is missing.',
      method: 'Run the export fixture.', requiredTestLayers: ['integration'],
      check: { kind: 'tests', files: ['packages/operator-core/lib/acceptance-bar-seed.test.ts'] },
    });
    const stored = await storedTemplateData(proposed.rubricId);
    expect(stored.criteria[0]).not.toHaveProperty('acceptance');
    expect(stored.criteria[0]).not.toHaveProperty('verification');
  });

  it('amends unified proof depth with approval, preserves BAR identity for methods, and retains projection history', async () => {
    const seeded = await seedBarContract('unified-amendment-subject', { authorMethods: true });
    const before = (await rubrics.getRubric(seeded.rubricSlug))!;
    const key = before.criteria[0]!.key;
    const amendment = {
      rubricId: seeded.rubricSlug, actorId: 'amendment-actor', reason: 'Require integration proof of the outcome.',
      requirement: { key, acceptance: { requiredTestLayers: ['integration'] } },
    };
    const proofDepthPreview = await rubrics.previewAcceptanceBarAmendment(amendment);
    expect(proofDepthPreview!.changes).toContainEqual(expect.objectContaining({
      barKey: 'R-1', kinds: ['bar-meaning'], fields: ['requiredTestLayers'],
    }));
    await expect(rubrics.amendRubric(amendment)).rejects.toThrow('acceptance_bar_approval_required');
    expect((await rubrics.getRubric(seeded.rubricSlug))!.revision).toBe(before.revision);
    const changed = (await rubrics.amendRubric({ ...amendment, approvalRef: await postApproval(amendment) }))!;
    expect(changed.revision).toBe(before.revision! + 1);
    expect(changed.criteria[0]!.barKey).toBe(before.criteria[0]!.barKey);
    expect(changed.criteria[0]!.barHash).not.toBe(before.criteria[0]!.barHash);
    expect(changed.criteria[1]).toEqual(before.criteria[1]);

    const method = { method: 'Run the integration fixture and compare every output record.',
      check: { kind: 'tests' as const, files: ['packages/operator-core/lib/acceptance-bar-seed.test.ts'] } };
    const preview = await rubrics.previewAcceptanceBarAmendment({ rubricId: seeded.rubricSlug,
      actorId: 'method-author', requirement: { key, verification: method } });
    expect(preview).toMatchObject({ approvalRequired: false, nextBarSetHash: changed.barSetHash });
    const verified = (await rubrics.amendRubric({ rubricId: seeded.rubricSlug,
      actorId: 'method-author', requirement: { key, verification: method } }))!;
    expect(verified.barSetHash).toBe(changed.barSetHash);
    expect(verified.criteria[0]).toMatchObject({ ...method, barHash: changed.criteria[0]!.barHash });
    expect(verified.criteria[1]).toEqual(changed.criteria[1]);

    // The complete-set door must normalize before its transaction's check/path
    // preflight too; no flat method/check is supplied by this caller.
    const replaced = (await rubrics.amendRubric({ rubricId: seeded.rubricSlug, actorId: 'method-author',
      criteria: verified.criteria.map(({ model, bar: _bar, driftMarkers, method: oldMethod,
        check, replication, ...criterion }) => ({ ...criterion,
        acceptance: { condition: model, falsifier: driftMarkers },
        verification: { method: oldMethod, ...(check ? { check } : {}), ...(replication ? { replication } : {}) },
      })),
    }))!;
    expect(replaced.barSetHash).toBe(verified.barSetHash);
    expect(replaced.criteria[0]).toMatchObject(method);
    expect(replaced.revision).toBeGreaterThan(changed.revision!);
    const revisions = await db.adminSql`SELECT r.source_bar_key, r.required_test_layers, r.revision,
      r.source_rubric_revision FROM harness_shared.plan_spec_clauses c
      JOIN harness_shared.plan_spec_clause_revisions r USING (workspace_id,harness_slug,plan_slug,spec_id)
      WHERE c.workspace_id=${seeded.workspaceId} AND c.harness_slug='papercusp' AND c.plan_slug=${seeded.subject}
      ORDER BY c.spec_id,r.revision`;
    const first = revisions.filter((row) => row.source_bar_key === 'R-1');
    expect(first[0]!.required_test_layers).toEqual([]);
    expect(first.at(-1)!.required_test_layers).toEqual(['integration']);
    expect(Number(first.at(-1)!.source_rubric_revision)).toBe(replaced.revision);
    expect(first.length).toBeGreaterThan(2);
    expect(revisions.filter((row) => row.source_bar_key === 'R-2').at(-1)!.required_test_layers).toEqual([]);
  });

  it('previews structural plane amendments without writes and requires an actual outside-lineage approval', async () => {
    const seeded = await seedBarContract('plane-approval-subject', { authorMethods: true });
    const before = await rubrics.getRubric(seeded.rubricSlug);
    const amendment = {
      rubricId: seeded.rubricSlug, actorId: 'amendment-actor', reason: 'Require observed live behavior.',
      criterionEvidencePlane: { key: before!.criteria[0]!.key, evidencePlane: 'live' as const },
    };
    const preview = await rubrics.previewAcceptanceBarAmendment(amendment);
    expect(preview!.changedBars).toEqual(['R-1']);
    expect(preview!.projectionCount).toBe(2);
    expect(preview!.changes).toContainEqual(expect.objectContaining({ barKey: 'R-1', kinds: ['bar-meaning', 'evidence-plane'] }));
    // rubric starts at 2, not 1: seeding now authors METHOD/check first.
    expect(preview!.revisionMovement).toMatchObject({ rubric: { from: 2, to: 3 }, subject: { from: 1, to: 2 } });
    expect(preview!.approval.bars[0]!.priorBarHash).toBe(before!.criteria[0]!.barHash);
    expect(preview!.approval.bars[0]!.nextBarHash).not.toBe(before!.criteria[0]!.barHash);
    expect((await rubrics.getRubric(seeded.rubricSlug))!.revision).toBe(before!.revision);
    await expect(rubrics.amendRubric({ ...amendment,
      approvalRef: await postApproval(amendment, 'amendment-actor'),
    })).rejects.toThrow('acceptance_bar_approval_in_implementer_lineage');
    const approvalRef = await postApproval(amendment);
    const after = await rubrics.amendRubric({ ...amendment, approvalRef });
    expect(after!.criteria[0]!.evidencePlane).toBe('live');
    const projections = await db.adminSql`SELECT r.source_bar_key, r.evidence_plane, r.required_evidence
      FROM harness_shared.plan_spec_clauses c
      JOIN harness_shared.plan_spec_clause_revisions r USING (workspace_id,harness_slug,plan_slug,spec_id)
      WHERE c.workspace_id=${seeded.workspaceId} AND c.harness_slug='papercusp' AND c.plan_slug=${seeded.subject}
        AND r.revision=c.current_revision ORDER BY c.spec_id`;
    expect(projections[0]!.evidence_plane).toBe('live');
    expect(projections[0]!.required_evidence).toContain('live');
    expect(projections[1]!.evidence_plane).toBe('tree');
  });

  it('serializes competing BAR amendments and refuses the stale CAS without partial writes', async () => {
    const seeded = await seedBarContract('concurrent-bar-subject', { authorMethods: true });
    const before = await rubrics.getRubric(seeded.rubricSlug);
    const inputs = ['live', 'deployed'].map((evidencePlane) => ({
      rubricId: seeded.rubricSlug, actorId: 'amendment-actor', reason: `Require ${evidencePlane} evidence.`,
      expectedRubricRevision: before!.revision,
      criterionEvidencePlane: { key: before!.criteria[0]!.key, evidencePlane: evidencePlane as 'live' | 'deployed' },
    }));
    const first = { ...inputs[0]!, approvalRef: await postApproval(inputs[0]!) };
    const second = { ...inputs[1]!, approvalRef: await postApproval(inputs[1]!) };
    const results = await Promise.allSettled([rubrics.amendRubric(first), rubrics.amendRubric(second)]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const refusal = results.find((result) => result.status === 'rejected') as PromiseRejectedResult;
    // The loser is refused by whichever serialization mechanism reaches it
    // first, and BOTH are correct outcomes of this path: the revision CAS when
    // it gets far enough to compare, or the row lock while the winner still
    // holds it. amendRubric takes a BLOCKING `SELECT ... FOR UPDATE`
    // (acceptance-bar-amendment.ts:97) under a 5s lock_timeout
    // (txn-timeouts-config.ts), so when the winning transaction outlives that
    // window the lock refuses first and the CAS branch is unreachable — which
    // made this assertion fail for an environment reason while the system did
    // exactly what the test is named for (serialize, admit one, write nothing
    // partial). Those invariants are still asserted, above and below.
    // This is NOT a loosening: the stale-CAS refusal is now pinned
    // DETERMINISTICALLY by the sequential test immediately below, where no
    // competing lock holder exists, so the specific code is still covered.
    // That the lock path surfaces a RAW PostgresError instead of the typed
    // OrgTxnTimeoutError the rest of operator-core maps 55P03 onto is a real
    // gap, filed as EI-22629595262565099 rather than absorbed here.
    expect(String(refusal.reason)).toMatch(/acceptance_bar_amendment_revision_conflict|lock timeout/);
    expect((await rubrics.getRubric(seeded.rubricSlug))!.revision).toBe(before!.revision! + 1);
    const [history] = await db.adminSql`SELECT count(*)::int AS n FROM harness_shared.plan_spec_clause_revisions
      WHERE workspace_id=${seeded.workspaceId} AND harness_slug='papercusp' AND plan_slug=${seeded.subject}`;
    // 6, not 4: seedBarContract({ authorMethods: true }) now performs the
    // authoring write a real caller performs (2 seed + 2 author + 2 amend).
    // The assertion still pins that the amendment advanced BOTH clause pins.
    expect(history.n).toBe(6);
  });

  it('refuses a stale expectedRubricRevision with the revision-conflict code when no lock competes', async () => {
    const seeded = await seedBarContract('sequential-stale-cas-subject', { authorMethods: true });
    const before = await rubrics.getRubric(seeded.rubricSlug);
    const inputs = ['live', 'deployed'].map((evidencePlane) => ({
      rubricId: seeded.rubricSlug, actorId: 'amendment-actor', reason: `Require ${evidencePlane} evidence.`,
      expectedRubricRevision: before!.revision,
      criterionEvidencePlane: { key: before!.criteria[0]!.key, evidencePlane: evidencePlane as 'live' | 'deployed' },
    }));
    // Both approvals are minted against the PRE-amendment state, so once the
    // first amendment lands the second carries a genuinely stale
    // expectedRubricRevision.
    const first = { ...inputs[0]!, approvalRef: await postApproval(inputs[0]!) };
    const second = { ...inputs[1]!, approvalRef: await postApproval(inputs[1]!) };
    await rubrics.amendRubric(first);
    // Sequential, so no competing row lock exists and the revision CAS is
    // always REACHED. This is the deterministic home of the specific-code
    // assertion that the concurrent test above cannot make reliably: there the
    // 5s lock_timeout can refuse the loser first (see the comment there), here
    // nothing holds the lock, so the conflict code is the only possible refusal.
    await expect(rubrics.amendRubric(second)).rejects.toThrow(/acceptance_bar_amendment_revision_conflict/);
    expect((await rubrics.getRubric(seeded.rubricSlug))!.revision).toBe(before!.revision! + 1);
  });

  /** Read the rubric's stored template_data straight off the row, so a resubmission is
   *  schema-valid by construction rather than by a hand-written fixture that can drift. */
  async function storedTemplateData(slug: string): Promise<{ criteria: { key: string }[] }> {
    const rows = await db.adminSql<{ template_data: { criteria: { key: string }[] } }[]>`
      SELECT template_data FROM harness_shared.harness_plans
       WHERE workspace_id = ${activeWorkspaceId()} AND harness_slug = 'papercusp'
         AND plan_slug = ${slug}`;
    return rows[0]!.template_data;
  }

  /** The exact pair `plans:set-template-data`'s handler runs (set-template-data.ts). */
  async function setTemplateDataDoor(slug: string, data: unknown) {
    const { withPlanLock } = await import('./agent-tools/plans/with-plan-lock');
    const { evaluateSetTemplateData } = await import('./agent-tools/plans/set-template-data');
    return withPlanLock(null as never, { slug, intent: 'plans:set-template-data' }, async (current, meta) =>
      evaluateSetTemplateData(current, data, slug, meta?.inputSchema ?? null),
    );
  }

  async function seedRubric(slug: string) {
    await rubrics.proposeRubric({
      rubricId: slug,
      characteristic: 'queen-coordination',
      title: 'Guarded rubric',
      criteria: sampleCriteria,
      by: 'author-a',
    });
  }

  it('REFUSES a set-template-data write that would silently delete a stored criterion', async () => {
    await seedRubric('guarded-rubric');
    const before = await storedTemplateData('guarded-rubric');
    expect(before.criteria.length).toBeGreaterThan(1);

    // The whole bug in one object: structurally valid, one criterion shorter.
    const gutted = { ...before, criteria: before.criteria.slice(0, 1) };
    const droppedKey = before.criteria[1]!.key;

    await expect(setTemplateDataDoor('guarded-rubric', gutted)).rejects.toThrow(
      new RegExp(`SILENTLY LOSE[\\s\\S]*${droppedKey}`),
    );

    // The refusal rolls back inside the lock — the stored rubric is untouched.
    const after = await storedTemplateData('guarded-rubric');
    expect(after.criteria.map((c) => c.key)).toEqual(before.criteria.map((c) => c.key));
    expect((await rubrics.getRubric('guarded-rubric'))?.criteria).toHaveLength(
      before.criteria.length,
    );
  });

  it('cannot CLEAR a rubric\'s template_data through this door either', async () => {
    await seedRubric('clearable-rubric');
    // A clear erases every criterion at once, so it must never reach the column. This
    // door stops it one step EARLIER than the loss-guard — the registry schema refuses
    // `null` where an object is required — which is why the assertion is on the door's
    // structured rejection, not on a throw. The boundary's own clear-refusal (for any
    // future door that does hand `data: null` down) is unit-pinned in
    // agent-tools/plans/rubric-loss-guard.test.ts.
    const result = await setTemplateDataDoor('clearable-rubric', null);
    expect(result.kind).toBe('applied');
    expect((result as { value: { ok: boolean } }).value.ok).toBe(false);
    expect((await storedTemplateData('clearable-rubric')).criteria.length).toBeGreaterThan(1);
  });

  it('still ACCEPTS an additive write — how P-001 added its criterion through this door', async () => {
    await seedRubric('growable-rubric');
    const before = await storedTemplateData('growable-rubric');
    const added = {
      ...before,
      criteria: [
        ...before.criteria,
        {
          key: 'portfolio-activity-floor',
          title: 'Portfolio activity floor',
          model: 'A standing goal with zero portfolio acts in its graded window is FAILING, not unknown.',
          method: 'Count portfolio acts by the holder inside the graded window; zero over >=60min scores fail.',
          driftMarkers: 'A window scored `unknown` while the ledger was available and returned zero acts.',
        },
      ],
    };
    const result = await setTemplateDataDoor('growable-rubric', added);
    expect(result.kind).toBe('applied');
    expect((result as { value: { ok: boolean } }).value.ok).toBe(true);
    expect((await storedTemplateData('growable-rubric')).criteria.map((c) => c.key)).toContain(
      'portfolio-activity-floor',
    );
  });

  it('leaves a NON-rubric plan\'s structured data alone (the guard is scoped, not global)', async () => {
    // A parameterized plan writes template_data too, and its input VALUES may perfectly
    // well contain a shrinking `criteria` array. The guard keys off the plan being a
    // rubric, not off the data merely looking like one — otherwise every plan-input
    // write becomes collateral damage. This plan declares its own JSON Schema (mig 714)
    // so the write genuinely APPLIES rather than bouncing off a missing-schema refusal,
    // which would prove nothing about the guard.
    await db.adminSql`
      INSERT INTO harness_shared.harness_plans
        (workspace_id, harness_slug, plan_slug, content, content_hash, version, title, status,
         created, updated, owner, archived, template, template_data, input_schema, origin)
      VALUES (${activeWorkspaceId()}, 'papercusp', 'plain-plan',
              ${'---\nslug: plain-plan\ntitle: Plain\nstatus: active\ncreated: 2026-06-20\nupdated: 2026-06-20\n---\n\n## Now\n\nwork\n'},
              md5('plain-plan'), 1, 'Plain', 'active', '2026-06-20', '2026-06-20', 'queen-1', false,
              NULL, ${JSON.stringify({ criteria: [{ key: 'a' }, { key: 'b' }] })}::text::jsonb,
              ${JSON.stringify({ type: 'object' })}::text::jsonb, 'local')`;
    const result = await setTemplateDataDoor('plain-plan', { criteria: [] });
    expect(result.kind).toBe('applied');
    expect((result as { value: { ok: boolean } }).value.ok).toBe(true);
    const after = await storedTemplateData('plain-plan');
    expect(after.criteria).toEqual([]);
  });
});
