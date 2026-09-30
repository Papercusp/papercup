/**
 * WI-10004146 / endgame D-093 option B — a federated receiver re-derives the
 * machine-local acceptance-BAR state (the subject plan's acceptance_bar_* columns
 * and its spec clauses) from the federated rubric, in EITHER arrival order, and
 * never mints a competing rubric row of its own.
 *
 * Two workspaces in one real Postgres stand in for two nodes: workspace A runs
 * the author's activation seed; its plan + rubric rows are then replayed into
 * workspace B through the real harness-plans projection with remote provenance.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import type { OrgTestDb } from '../../../../test/_org-test-db';
import type { ProvenanceContext } from '../projection';
import type { HarnessPlanRow } from './harness-plans';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql, workspace: 'unset' }));
// The launch-readiness evaluator scopes by the process's active workspace; point it
// at whichever "node" (workspace) an assertion is asking about.
vi.mock('../../../workspace-registry', async () => {
  const actual = await vi.importActual<typeof import('../../../workspace-registry')>('../../../workspace-registry');
  return { ...actual, activeWorkspaceId: () => h.workspace };
});
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

const { createOrgTestDb } = await import('../../../../test/_org-test-db');
const { hashPlanContent } = await import('../../../agent-tools/plans/content-hash');
const { seedAcceptanceBarsInTransaction } = await import('../../../acceptance-bar-seed');
const { buildHarnessPlansProjection } = await import('./harness-plans');
const { readAndEvaluateAcceptanceBarLifecycle } = await import('../../../acceptance-bar-lifecycle-evaluator');
const { deriveIndexFromContent } = await import('../../../agent-tools/plans/derive-index');
const { writePlanIndexRows } = await import('../../../agent-tools/plans/plan-index-rows');
import type { SpecClauseSql } from '../../../agent-tools/plans/spec-clauses-store';

const AUTHOR_WS = 'acceptance-bar-receiver-author';
const RECEIVER_WS = 'acceptance-bar-receiver-peer';
const HARNESS = 'papercusp';
// Deliberately NOT the receiver's values: a receiver's local plan `version` and its
// trigger-stamped epoch (1) must never be what the rebuild uses.
const AUTHOR_PLAN_VERSION = 3;
const AUTHOR_EPOCH = 2;

const contentFor = (slug: string, extraBar = false) => `---
title: ${slug}
slug: ${slug}
status: active
---

## Requirements

**R-1 — Canonical outcome.** The first outcome holds.

**R-2 — Runtime truth.** Runtime reports the current truth.
${extraBar ? '\n**R-3 — Late addition.** A BAR the rubric has never seen.\n' : ''}
## Design

### Bar-to-work map for this plan

| bar | implementing plan items | evidence plane |
|---|---|---|
| R-1 | P-001 | tree |
| R-2 | P-002 | live |
${extraBar ? '| R-3 | P-002 | tree |\n' : ''}
## Work

- **P-001** \`done\` implement the canonical outcome
- **P-002** \`done\` expose runtime truth
`;

let db: OrgTestDb;
let hlc = 1000;

beforeAll(async () => {
  db = await createOrgTestDb();
  h.sql = db.adminSql;
}, 120_000);

afterAll(async () => {
  await db?.cleanup();
});

async function authorSeed(planSlug: string): Promise<{ plan: HarnessPlanRow; rubric: HarnessPlanRow }> {
  const content = contentFor(planSlug);
  await db.adminSql`
    INSERT INTO harness_shared.harness_plans
      (workspace_id, harness_slug, plan_slug, content, content_hash, version, title, status, owner,
       acceptance_bar_epoch, acceptance_bar_cohort)
    VALUES (${AUTHOR_WS}, ${HARNESS}, ${planSlug}, ${content}, ${hashPlanContent(content)}, ${AUTHOR_PLAN_VERSION},
            ${planSlug}, 'active', 'su-author', ${AUTHOR_EPOCH}, 'post-epoch')`;
  // A real plan write derives its plan_items index in the same tx; the seed's work
  // contracts bind to those items (the receiver gets them from the projection apply).
  await writePlanIndexRows(
    db.adminSql as unknown as Parameters<typeof writePlanIndexRows>[0],
    { workspaceId: AUTHOR_WS, harnessSlug: HARNESS, planSlug },
    deriveIndexFromContent(content),
  );
  const seeded = await db.adminSql.begin((tx) => seedAcceptanceBarsInTransaction({
    executor: tx as unknown as SpecClauseSql,
    workspaceId: AUTHOR_WS,
    harnessSlug: HARNESS,
    planSlug,
    planContent: content,
    planTitle: planSlug,
    planStatus: 'active',
    planVersion: AUTHOR_PLAN_VERSION,
    adoptionEpoch: AUTHOR_EPOCH,
    cohort: 'post-epoch',
    actorId: 'su-author',
    now: new Date('2026-09-30T00:00:00Z'),
  }));
  expect(seeded).toMatchObject({ ok: true, rubricChanged: true });
  return {
    plan: await wireRow(AUTHOR_WS, planSlug),
    rubric: await wireRow(AUTHOR_WS, `acceptance-${planSlug}`),
  };
}

/** The federated wire shape of a stored row (machine-local columns omitted). */
async function wireRow(workspaceId: string, planSlug: string): Promise<HarnessPlanRow> {
  const [row] = await db.adminSql<HarnessPlanRow[]>`
    SELECT harness_slug, plan_slug, content, content_hash, title, status, created::text AS created,
           updated::text AS updated, owner, initiative, template, template_data, supersedes,
           superseded_by, archived, is_legacy
      FROM harness_shared.harness_plans
     WHERE workspace_id = ${workspaceId} AND harness_slug = ${HARNESS} AND plan_slug = ${planSlug}`;
  expect(row, `${workspaceId}/${planSlug} exists`).toBeDefined();
  return { ...row!, supersedes: row!.supersedes ?? [] };
}

async function applyRemote(row: HarnessPlanRow): Promise<void> {
  hlc += 1000;
  const provenance: ProvenanceContext = {
    authorPubkey: 'srclog-A', origin: 'remote', ts: hlc, fedHlc: `h${hlc}`,
  };
  const projection = buildHarnessPlansProjection({
    sql: db.adminSql,
    workspaceId: RECEIVER_WS,
    harnessSlug: HARNESS, // own-slug: the membership guard applies, isolating the seed
    isFlagOn: async () => false, // PLAN_PART_FEDERATION is dark: the live whole-blob path
    resolveAuthorDevice: (key: string) => (key === 'srclog-A' ? 'DEV-A' : null),
    resolveWriteMode: async () => 'member',
  } as never);
  await projection.writeToPg(row, provenance);
}

interface BarColumns {
  acceptance_bar_epoch: number | null;
  acceptance_bar_cohort: string | null;
  acceptance_bar_set_hash: string | null;
  acceptance_bar_rubric_slug: string | null;
  acceptance_bar_rubric_revision: number | null;
  acceptance_bar_seeded_by: string | null;
}

async function barColumns(workspaceId: string, planSlug: string): Promise<BarColumns> {
  const [row] = await db.adminSql<BarColumns[]>`
    SELECT acceptance_bar_epoch, acceptance_bar_cohort, acceptance_bar_set_hash,
           acceptance_bar_rubric_slug, acceptance_bar_rubric_revision, acceptance_bar_seeded_by
      FROM harness_shared.harness_plans
     WHERE workspace_id = ${workspaceId} AND harness_slug = ${HARNESS} AND plan_slug = ${planSlug}`;
  return row!;
}

async function rubricRows(workspaceId: string, planSlug: string) {
  return db.adminSql<Array<{ plan_slug: string; version: number; template_data: unknown }>>`
    SELECT plan_slug, version, template_data
      FROM harness_shared.harness_plans
     WHERE workspace_id = ${workspaceId}
       AND template = 'rubric'
       AND template_data->>'subjectPlan' = ${planSlug}`;
}

async function clauseIds(workspaceId: string, planSlug: string): Promise<string[]> {
  const rows = await db.adminSql<Array<{ spec_id: string }>>`
    SELECT spec_id FROM harness_shared.plan_spec_clauses
     WHERE workspace_id = ${workspaceId} AND harness_slug = ${HARNESS} AND plan_slug = ${planSlug}
     ORDER BY spec_id`;
  return rows.map((row) => row.spec_id);
}

/**
 * The WI-10004146 symptom itself: the acceptance-BAR lifecycle verdict that
 * checkPlanStartable (plans:launch) refuses on as `acceptance_bar_contract_not_ready`.
 */
async function launchVerdict(workspaceId: string, planSlug: string) {
  h.workspace = workspaceId;
  const verdict = await readAndEvaluateAcceptanceBarLifecycle(planSlug, 'pre-start', { harnessSlug: HARNESS });
  return { satisfied: verdict.satisfied, codes: [...verdict.codes].sort() };
}

async function expectConvergedWithAuthor(planSlug: string): Promise<void> {
  // Node B now answers the launch gate exactly as node A does.
  const authorVerdict = await launchVerdict(AUTHOR_WS, planSlug);
  expect(authorVerdict).toEqual({ satisfied: true, codes: [] });
  expect(await launchVerdict(RECEIVER_WS, planSlug)).toEqual(authorVerdict);

  const author = await barColumns(AUTHOR_WS, planSlug);
  const receiver = await barColumns(RECEIVER_WS, planSlug);
  expect(author.acceptance_bar_set_hash).toBeTruthy();
  expect(receiver).toMatchObject({
    acceptance_bar_set_hash: author.acceptance_bar_set_hash,
    acceptance_bar_rubric_slug: author.acceptance_bar_rubric_slug,
    // The receiver's trigger stamped epoch 1; the rubric's contract pins the author's.
    acceptance_bar_epoch: AUTHOR_EPOCH,
    acceptance_bar_cohort: 'post-epoch',
    acceptance_bar_seeded_by: 'su-author',
  });

  // Exactly ONE rubric row on the receiver, byte-identical to the author's: the
  // receiver seed re-derived from it and never authored or revised its own.
  const [authorRubric] = await rubricRows(AUTHOR_WS, planSlug);
  const receiverRubrics = await rubricRows(RECEIVER_WS, planSlug);
  expect(receiverRubrics).toHaveLength(1);
  expect(receiverRubrics[0]!.template_data).toEqual(authorRubric!.template_data);
  // Revision numbers are local CAS counters: the plan column must name the LOCAL rubric's.
  expect(Number(receiver.acceptance_bar_rubric_revision)).toBe(Number(receiverRubrics[0]!.version));

  // Spec clauses are machine-local; the receiver derives the same identities locally.
  const authorClauses = await clauseIds(AUTHOR_WS, planSlug);
  expect(authorClauses.length).toBeGreaterThan(0);
  expect(await clauseIds(RECEIVER_WS, planSlug)).toEqual(authorClauses);
}

describe('federated receiver acceptance-BAR seed (D-093 option B)', () => {
  it('plan-then-rubric: the plan apply mints no rubric; the rubric apply seeds the plan', async () => {
    const planSlug = 'receiver-plan-first';
    const { plan, rubric } = await authorSeed(planSlug);

    await applyRemote(plan);
    // The falsifier for the design hazard: an unguarded seed would INSERT an
    // `acceptance-<slug>` rubric here, which would then federate and compete.
    expect(await rubricRows(RECEIVER_WS, planSlug)).toHaveLength(0);
    expect((await barColumns(RECEIVER_WS, planSlug)).acceptance_bar_set_hash).toBeNull();
    expect(await clauseIds(RECEIVER_WS, planSlug)).toEqual([]);
    // ...and B still refuses to launch it, as it did before this fix in every order.
    expect((await launchVerdict(RECEIVER_WS, planSlug)).satisfied).toBe(false);

    await applyRemote(rubric);
    await expectConvergedWithAuthor(planSlug);
  });

  it('rubric-then-plan: the rubric waits for its subject; the plan apply seeds it', async () => {
    const planSlug = 'receiver-rubric-first';
    const { plan, rubric } = await authorSeed(planSlug);

    await applyRemote(rubric);
    expect(await rubricRows(RECEIVER_WS, planSlug)).toHaveLength(1);

    await applyRemote(plan);
    await expectConvergedWithAuthor(planSlug);
  });

  it('is idempotent: re-applying both rows changes no rubric, clause, or column', async () => {
    const planSlug = 'receiver-reapply';
    const { plan, rubric } = await authorSeed(planSlug);
    await applyRemote(plan);
    await applyRemote(rubric);
    const before = {
      columns: await barColumns(RECEIVER_WS, planSlug),
      clauses: await clauseIds(RECEIVER_WS, planSlug),
      rubric: (await rubricRows(RECEIVER_WS, planSlug))[0]!.template_data,
    };

    await applyRemote(plan);
    await applyRemote(rubric);

    const afterColumns = await barColumns(RECEIVER_WS, planSlug);
    expect(afterColumns.acceptance_bar_set_hash).toBe(before.columns.acceptance_bar_set_hash);
    expect(afterColumns.acceptance_bar_epoch).toBe(before.columns.acceptance_bar_epoch);
    expect(await clauseIds(RECEIVER_WS, planSlug)).toEqual(before.clauses);
    const rubrics = await rubricRows(RECEIVER_WS, planSlug);
    expect(rubrics).toHaveLength(1);
    expect(rubrics[0]!.template_data).toEqual(before.rubric);
  });

  it('defers without writing when the local plan disagrees with the federated rubric', async () => {
    const planSlug = 'receiver-mismatch';
    const { plan, rubric } = await authorSeed(planSlug);
    await applyRemote(rubric);

    // A plan revision carrying a BAR the rubric has never seen (its amendment is
    // still in flight). The receiver must neither seed nor rewrite the rubric.
    const drifted = contentFor(planSlug, true);
    await applyRemote({ ...plan, content: drifted, content_hash: hashPlanContent(drifted) });

    const columns = await barColumns(RECEIVER_WS, planSlug);
    expect(columns.acceptance_bar_set_hash).toBeNull();
    expect(columns.acceptance_bar_rubric_slug).toBeNull();
    expect(await clauseIds(RECEIVER_WS, planSlug)).toEqual([]);
    const [authorRubric] = await rubricRows(AUTHOR_WS, planSlug);
    const receiverRubrics = await rubricRows(RECEIVER_WS, planSlug);
    expect(receiverRubrics).toHaveLength(1);
    expect(receiverRubrics[0]!.template_data).toEqual(authorRubric!.template_data);
  });

  it('a local-origin apply does not run the receiver seed', async () => {
    const planSlug = 'receiver-local-origin';
    const { plan, rubric } = await authorSeed(planSlug);
    const projection = buildHarnessPlansProjection({
      sql: db.adminSql,
      workspaceId: RECEIVER_WS,
      harnessSlug: HARNESS,
      isFlagOn: async () => false,
      resolveWriteMode: async () => 'member',
    } as never);
    hlc += 1000;
    await projection.writeToPg(rubric, { authorPubkey: 'self', origin: 'local', ts: hlc, fedHlc: `h${hlc}` });
    hlc += 1000;
    await projection.writeToPg(plan, { authorPubkey: 'self', origin: 'local', ts: hlc, fedHlc: `h${hlc}` });
    expect((await barColumns(RECEIVER_WS, planSlug)).acceptance_bar_set_hash).toBeNull();
  });
});
