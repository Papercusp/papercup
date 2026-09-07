/** Real-Postgres coverage for re-auditing a historical deterministic acceptance rubric. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import type { OrgTestDb } from '../test/_org-test-db';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return {
    ...(await orig<typeof import('@papercusp/db-org')>()),
    ...actual,
    getOrgPg: () => ({ sql: h.sql }),
    withWorkspace: async <T>(_workspaceId: string, fn: (tx: postgres.Sql) => Promise<T>): Promise<T> =>
      h.sql.begin(async (tx) => fn(tx as unknown as postgres.Sql)) as Promise<T>,
  };
});

const { createOrgTestDb } = await import('../test/_org-test-db');
const { hashPlanContent } = await import('./agent-tools/plans/content-hash');
const { seedAcceptanceBarsInTransaction } = await import('./acceptance-bar-seed');
import { setSpecClause, type SpecClauseSql } from './agent-tools/plans/spec-clauses-store';

const WORKSPACE = 'acceptance-bar-seed-historical-test';
const HARNESS = 'papercusp';

const contentFor = (slug: string) => `---
title: ${slug}
slug: ${slug}
status: active
---

## Requirements

**R-1 — Canonical outcome.** The first outcome holds.

**R-2 — Runtime truth.** Runtime reports the current truth.

## Design

### Bar-to-work map for this plan

| bar | implementing plan items | evidence plane |
|---|---|---|
| R-1 | P-001 | tree |
| R-2 | P-002 | live |

## Work

- **P-001** \`done\` implement the canonical outcome
- **P-002** \`done\` expose runtime truth
`;

let db: OrgTestDb;

beforeAll(async () => {
  db = await createOrgTestDb();
  h.sql = db.adminSql;
}, 120_000);

afterAll(async () => {
  await db?.cleanup();
});

async function insertSubject(planSlug: string, content: string) {
  await db.adminSql`
    INSERT INTO harness_shared.harness_plans
      (workspace_id, harness_slug, plan_slug, content, content_hash, version, title, status, owner,
       acceptance_bar_epoch, acceptance_bar_cohort)
    VALUES (${WORKSPACE}, ${HARNESS}, ${planSlug}, ${content}, ${hashPlanContent(content)}, 1,
            ${planSlug}, 'active', 'su-test', 1, 'post-epoch')`;
  for (const [seq, itemId] of ['P-001', 'P-002'].entries()) {
    await db.adminSql`
      INSERT INTO harness_shared.plan_items
        (workspace_id, harness_slug, plan_slug, item_id, seq, status, item_text)
      VALUES (${WORKSPACE}, ${HARNESS}, ${planSlug}, ${itemId}, ${seq + 1}, 'done', ${itemId})`;
  }
}

function seedInput(planSlug: string, planContent: string, actorId: string) {
  return {
    workspaceId: WORKSPACE,
    harnessSlug: HARNESS,
    planSlug,
    planContent,
    planTitle: planSlug,
    planStatus: 'active',
    planVersion: 1,
    adoptionEpoch: 1,
    cohort: 'post-epoch' as const,
    actorId,
    now: new Date('2026-09-05T00:00:00Z'),
  };
}

describe('historical deterministic acceptance BAR rubric collision', () => {
  it('reuses a superseded subject acceptance rubric during a later re-audit', async () => {
    const planSlug = 'historical-bar-reaudit';
    const planContent = contentFor(planSlug);
    await insertSubject(planSlug, planContent);

    const first = await db.adminSql.begin((tx) => seedAcceptanceBarsInTransaction({
      ...seedInput(planSlug, planContent, 'su-seeder'),
      executor: tx as unknown as SpecClauseSql,
    }));
    expect(first).toMatchObject({
      ok: true,
      rubricSlug: `acceptance-${planSlug}`,
      rubricRevision: 1,
      rubricChanged: true,
    });

    // The subject's one-shot acceptance rubric is no longer live after shipping.
    // The next seed must classify this exact row from its rubric identity and
    // subject link instead of treating it as an unrelated slug collision.
    await db.adminSql`
      UPDATE harness_shared.harness_plans
         SET status = 'shipped'
       WHERE workspace_id = ${WORKSPACE}
         AND harness_slug = ${HARNESS}
         AND plan_slug = ${planSlug}`;
    await db.adminSql`
      UPDATE harness_shared.harness_plans
         SET status = 'superseded'
       WHERE workspace_id = ${WORKSPACE}
         AND harness_slug = ${HARNESS}
         AND plan_slug = ${`acceptance-${planSlug}`}`;

    const reaudit = await db.adminSql.begin((tx) => seedAcceptanceBarsInTransaction({
      ...seedInput(planSlug, planContent, 'su-reauditor'),
      planStatus: 'shipped',
      executor: tx as unknown as SpecClauseSql,
    }));
    expect(reaudit, JSON.stringify(reaudit)).toMatchObject({
      ok: true,
      rubricSlug: `acceptance-${planSlug}`,
      rubricRevision: 1,
      rubricChanged: false,
    });

    await expect(db.adminSql`
      SELECT status, archived, version::int AS version
        FROM harness_shared.harness_plans
       WHERE workspace_id = ${WORKSPACE}
         AND harness_slug = ${HARNESS}
         AND plan_slug = ${`acceptance-${planSlug}`}
    `).resolves.toEqual([{ status: 'superseded', archived: false, version: 1 }]);
  });

  it('preserves additive plan-specific clauses pinned to a BAR during re-audit', async () => {
    const planSlug = 'additive-pinned-clause-reaudit';
    const planContent = contentFor(planSlug);
    await insertSubject(planSlug, planContent);

    const first = await db.adminSql.begin((tx) => seedAcceptanceBarsInTransaction({
      ...seedInput(planSlug, planContent, 'su-seeder'),
      executor: tx as unknown as SpecClauseSql,
    }));
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error(first.message);

    const [managed] = await db.adminSql<{
      source_bar_key: string;
      source_bar_hash: string;
      source_bar_set_hash: string;
      source_rubric_slug: string;
      source_rubric_revision: number;
      evidence_plane: 'tree' | 'deployed' | 'live';
    }[]>`
      SELECT r.source_bar_key, r.source_bar_hash, r.source_bar_set_hash,
             r.source_rubric_slug, r.source_rubric_revision, r.evidence_plane
        FROM harness_shared.plan_spec_clauses c
        JOIN harness_shared.plan_spec_clause_revisions r
          ON r.workspace_id = c.workspace_id AND r.harness_slug = c.harness_slug
         AND r.plan_slug = c.plan_slug AND r.spec_id = c.spec_id
         AND r.revision = c.current_revision
       WHERE c.workspace_id = ${WORKSPACE}
         AND c.harness_slug = ${HARNESS}
         AND c.plan_slug = ${planSlug}
         AND c.spec_id = 'AUTO-BAR-R-1-P-001'`;
    expect(managed).toBeDefined();

    const narrowedManaged = await db.adminSql.begin((tx) => setSpecClause({
      planSlug,
      specId: 'AUTO-BAR-R-1-P-001',
      expectedRevision: 1,
      planItemId: 'P-001',
      behavior: 'The canonical store contains the submitted outcome exactly once.',
      behaviorClass: 'happy-path',
      requiredEvidence: ['tree'],
      requiredTestLayers: ['integration'],
      mutationRequired: true,
      lifecycleStatus: 'accepted',
      falsifier: { observation: 'The submitted outcome is missing or duplicated.' },
      acceptanceRef: `${managed.source_rubric_slug}@${managed.source_rubric_revision}:${managed.source_bar_key}`,
      sourceBar: {
        barKey: managed.source_bar_key,
        barHash: managed.source_bar_hash,
        barSetHash: managed.source_bar_set_hash,
        rubricSlug: managed.source_rubric_slug,
        rubricRevision: Number(managed.source_rubric_revision),
        evidencePlane: managed.evidence_plane,
      },
      actorId: 'su-spec-reviewer',
    }, {
      executor: tx as unknown as SpecClauseSql,
      workspaceId: WORKSPACE,
      harnessSlug: HARNESS,
    }));
    expect(narrowedManaged).toMatchObject({ status: 'revised', revision: 2 });

    const custom = await db.adminSql.begin((tx) => setSpecClause({
      planSlug,
      specId: 'PUI-TASK-ADD',
      expectedRevision: 0,
      planItemId: 'P-001',
      behavior: 'The task editor adds one owner-authored task to the canonical store.',
      behaviorClass: 'happy-path',
      requiredEvidence: ['tree'],
      requiredTestLayers: ['integration'],
      mutationRequired: true,
      lifecycleStatus: 'accepted',
      falsifier: { observation: 'The submitted task is absent from the canonical store.' },
      acceptanceRef: `${managed.source_rubric_slug}@${managed.source_rubric_revision}:${managed.source_bar_key}`,
      sourceBar: {
        barKey: managed.source_bar_key,
        barHash: managed.source_bar_hash,
        barSetHash: managed.source_bar_set_hash,
        rubricSlug: managed.source_rubric_slug,
        rubricRevision: Number(managed.source_rubric_revision),
        evidencePlane: managed.evidence_plane,
      },
      actorId: 'su-spec-author',
    }, {
      executor: tx as unknown as SpecClauseSql,
      workspaceId: WORKSPACE,
      harnessSlug: HARNESS,
    }));
    expect(custom).toMatchObject({ status: 'created', revision: 1 });

    const revisedContent = `${planContent}\n## Decision log\n\nExecution moved to a successor; BAR meaning is unchanged.\n`;
    await db.adminSql`
      UPDATE harness_shared.harness_plans
         SET content = ${revisedContent}, content_hash = ${hashPlanContent(revisedContent)}, version = 2
       WHERE workspace_id = ${WORKSPACE}
         AND harness_slug = ${HARNESS}
         AND plan_slug = ${planSlug}`;
    const reaudit = await db.adminSql.begin((tx) => seedAcceptanceBarsInTransaction({
      ...seedInput(planSlug, revisedContent, 'su-reauditor'),
      planVersion: 2,
      executor: tx as unknown as SpecClauseSql,
    }));
    expect(reaudit, JSON.stringify(reaudit)).toMatchObject({
      ok: true,
      rubricSlug: `acceptance-${planSlug}`,
      rubricRevision: 2,
      rubricChanged: true,
    });

    await expect(db.adminSql`
      SELECT c.current_revision::int AS current_revision, r.lifecycle_status,
             r.source_bar_key, r.source_rubric_revision::int AS source_rubric_revision,
             r.required_test_layers, r.behavior
        FROM harness_shared.plan_spec_clauses c
        JOIN harness_shared.plan_spec_clause_revisions r
          ON r.workspace_id = c.workspace_id AND r.harness_slug = c.harness_slug
         AND r.plan_slug = c.plan_slug AND r.spec_id = c.spec_id
         AND r.revision = c.current_revision
       WHERE c.workspace_id = ${WORKSPACE}
         AND c.harness_slug = ${HARNESS}
         AND c.plan_slug = ${planSlug}
         AND c.spec_id = ANY(${['AUTO-BAR-R-1-P-001', 'PUI-TASK-ADD']}::text[])
       ORDER BY c.spec_id
    `).resolves.toEqual([{
      current_revision: 3,
      lifecycle_status: 'accepted',
      source_bar_key: 'R-1',
      source_rubric_revision: 2,
      required_test_layers: ['integration'],
      behavior: 'The canonical store contains the submitted outcome exactly once.',
    }, {
      current_revision: 2,
      lifecycle_status: 'accepted',
      source_bar_key: 'R-1',
      source_rubric_revision: 2,
      required_test_layers: ['integration'],
      behavior: 'The task editor adds one owner-authored task to the canonical store.',
    }]);
  });

  it('still refuses a deterministic slug occupied by a non-rubric plan', async () => {
    const planSlug = 'non-rubric-bar-collision';
    const planContent = contentFor(planSlug);
    await insertSubject(planSlug, planContent);
    await db.adminSql`
      INSERT INTO harness_shared.harness_plans
        (workspace_id, harness_slug, plan_slug, content, content_hash, version, title, status, owner, template, template_data)
      VALUES (${WORKSPACE}, ${HARNESS}, ${`acceptance-${planSlug}`}, 'ordinary plan', md5('ordinary plan'), 1,
              'Ordinary plan', 'active', 'su-test', NULL, '{}'::text::jsonb)`;

    const result = await db.adminSql.begin((tx) => seedAcceptanceBarsInTransaction({
      ...seedInput(planSlug, planContent, 'su-test'),
      executor: tx as unknown as SpecClauseSql,
    }));
    expect(result).toMatchObject({ ok: false, error: 'bar_rubric_conflict' });
    if (result.ok) throw new Error('expected the deterministic non-rubric collision to be refused');
    expect(result.message).toMatch(/deterministic rubric slug.*non-acceptance plan/);
  });
});
