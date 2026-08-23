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
  opts: { status?: string; data?: unknown; title?: string; templateSlug?: string | null; archived?: boolean; workspaceId?: string } = {},
) {
  await db.adminSql`
    INSERT INTO harness_shared.harness_plans
      (workspace_id, harness_slug, plan_slug, content, content_hash, version, title, status,
       created, updated, owner, archived, template, template_data, template_slug, origin)
    VALUES (${opts.workspaceId ?? activeWorkspaceId()}, 'papercusp', ${slug}, '', md5(${slug}), 1, ${opts.title ?? slug},
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
      { seq: number; author_id: string; author_kind: string; rationale: string | null; content_snapshot: string }[]
    >`
      SELECT seq, author_id, author_kind, rationale, content_snapshot
        FROM harness_shared.plan_revisions
       WHERE plan_slug = 'audited-rubric' ORDER BY seq ASC`;
    expect(afterPropose).toHaveLength(1); // the bug: this was 0
    expect(afterPropose[0].author_id).toBe('author-a'); // the proposer of record
    expect(afterPropose[0].author_kind).toBe('agent'); // a rubric write is an agent/Queen action
    expect(afterPropose[0].rationale).toContain('propose');
    expect(afterPropose[0].content_snapshot).toMatch(/status:\s*draft/); // proposed → draft plan

    await rubrics.ratifyRubric('audited-rubric', 'queen-1');
    const afterRatify = await db.adminSql<
      { seq: number; author_id: string; rationale: string | null; content_snapshot: string }[]
    >`
      SELECT seq, author_id, rationale, content_snapshot
        FROM harness_shared.plan_revisions
       WHERE plan_slug = 'audited-rubric' ORDER BY seq ASC`;
    expect(afterRatify).toHaveLength(2); // a SECOND revision — the status-flip is now audited
    const ratifyRev = afterRatify[1];
    expect(ratifyRev.author_id).toBe('queen-1'); // the ratifier, not the author
    expect(ratifyRev.rationale).toContain('ratify');
    expect(ratifyRev.content_snapshot).toMatch(/status:\s*active/); // the destructive-class flip is captured
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
      criteria: [{ key: 'outcome', title: 'Outcome', model: '', method: '', driftMarkers: '' }],
      by: 'su-test',
    });
    expect(first.status).toBe('active');

    const [stored] = await db.adminSql<{ template_data: { criteria: Record<string, unknown>[] } }[]>`
      SELECT template_data FROM harness_shared.harness_plans
       WHERE plan_slug = 'acceptance-empty-prose' AND template = 'rubric'`;
    expect(stored.template_data.criteria[0]).toEqual({ key: 'outcome', title: 'Outcome' });

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
