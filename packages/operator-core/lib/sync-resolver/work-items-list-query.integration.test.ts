// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { randomBytes } from 'node:crypto';
import {
  composeCompanionSummary,
  type CompanionListSummary,
  type FacetDef,
  type FacetSelection,
} from '@papercusp/facets';
import { createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';
import { HARNESS_FEATURES_CONSOLIDATED_DDL, WORK_ITEM_DEPS_DDL } from '../../test/_work-items-schema';
import { sealImplementationAcceptance } from '../harness/improvements/agent-review-policy';
import {
  assertCompanionPredicateParity,
} from './count-contract-testkit';
import { LIST_READ_BUDGET_MS } from './bounded-list-read';
import {
  buildWorkItemsPredicate,
  normalizeWorkItemsListArgs,
  readWorkItemsPageFromStore,
  readWorkItemsSummaryFromStore,
  workItemsSummarySelection,
  type WorkItemsListRow,
  type WorkItemsListWireArgs,
} from './work-items-list-query';

const ROWS = 31_205; // above Avi's 31,133-row reproduction corpus
const DEEP = 31_153;
const token = randomBytes(5).toString('hex');
const workspaceId = `p4-ws-${token}`;
const harnessSlug = `p4-h-${token}`;
const BASE_TS = 1_900_000_000_000;
let db: FreshPgDb;
let sql: Sql;

/** Minimal production-reader projection: scopedCtes reads only these columns. */
const SPAWNED_AGENTS_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.spawned_agents (
    spawn_id text PRIMARY KEY,
    workspace_id text NOT NULL,
    harness_slug text NOT NULL,
    parent_role text,
    child_role text,
    feature_id text,
    run_id text,
    status text NOT NULL,
    started_at timestamptz
  )`;

/** The live corpus already carries hfc_updated_idx; reproduce that planner seam. */
const WORK_ITEMS_UPDATED_INDEX_DDL = `
  CREATE INDEX IF NOT EXISTS hfc_updated_idx
    ON harness_shared.work_items (updated_ts DESC)`;

interface FixtureRow {
  id: string;
  kind: string;
  state: string;
  title: string;
  assignee: string;
  severity: string | null;
  priority: number;
  rank: number;
  plan: string;
  stage: string | null;
}

const rowFor = (g: number): FixtureRow => {
  const kind = g % 3 === 0 ? 'feature' : g % 3 === 1 ? 'bug' : 'change';
  return {
    id: `P4WI-${g.toString().padStart(5, '0')}`,
    kind,
    state: ['open', 'blocked', 'wip', 'done'][g % 4]!,
    title: g === DEEP ? 'deep-only-match' : `ordinary work item ${g}`,
    assignee: `su-${g % 6}`,
    severity: kind === 'feature' ? null : g % 2 === 0 ? 'minor' : 'major',
    priority: g % 10,
    rank: g % 7,
    plan: `plan-${g % 5}`,
    stage: g === DEEP ? 'reviewer' : null,
  };
};

const corpus = Array.from({ length: ROWS }, (_, index) => rowFor(index + 1));

const selection = (args: WorkItemsListWireArgs): FacetSelection =>
  workItemsSummarySelection(normalizeWorkItemsListArgs(args));

const facetDefs: readonly FacetDef<FixtureRow>[] = [
  { key: 'kind', extract: (row) => row.kind },
  { key: 'state', extract: (row) => row.state },
  { key: 'stage', extract: (row) => row.stage },
  { key: 'assignee', extract: (row) => row.assignee },
  { key: 'severity', extract: (row) => row.severity },
  { key: 'plan', extract: (row) => row.plan },
];

const matches = (row: FixtureRow, wire: WorkItemsListWireArgs): boolean => {
  const args = normalizeWorkItemsListArgs(wire);
  const f = args.filters;
  return matchesFacetBase(row, wire)
    && (f.kinds.length === 0 || f.kinds.includes(row.kind))
    && (f.states.length === 0 || f.states.includes(row.state))
    && (f.stages.length === 0 || (row.stage != null && f.stages.includes(row.stage)))
    && (f.assignees.length === 0 || f.assignees.includes(row.assignee))
    && (f.severities.length === 0 || (row.severity != null && f.severities.includes(row.severity)))
    && (f.plans.length === 0 || f.plans.includes(row.plan));
};

const matchesFacetBase = (row: FixtureRow, wire: WorkItemsListWireArgs): boolean => {
  const args = normalizeWorkItemsListArgs(wire);
  const f = args.filters;
  const contains = (value: string | null, query: string | null) =>
    !query || (value ?? '').toLowerCase().includes(query.toLowerCase());
  return contains(`${row.id} ${row.title} ${row.state} ${row.assignee}`, args.q)
    && contains(row.id, f.id)
    && contains(row.title, f.title)
    && (f.priorityMin == null || row.priority >= f.priorityMin)
    && (f.priorityMax == null || row.priority <= f.priorityMax)
    && (f.rankMin == null || row.rank >= f.rankMin)
    && (f.rankMax == null || row.rank <= f.rankMax);
};

const fixtureFromStoredRow = (row: WorkItemsListRow): FixtureRow => ({
  id: row.id,
  kind: row.kind,
  state: row.state,
  title: row.title,
  assignee: row.assignee ?? '',
  severity: row.severity,
  priority: row.priority ?? 0,
  rank: row.rank ?? 0,
  plan: row.planSlug ?? '',
  stage: row.spineRole,
});

const pageFor = async (args: WorkItemsListWireArgs, cursor: string | null) => {
  const normalized = normalizeWorkItemsListArgs({ ...args, cursor });
  const page = await readWorkItemsPageFromStore(sql, workspaceId, buildWorkItemsPredicate(normalized));
  return { ...page, rows: page.rows.map(fixtureFromStoredRow) };
};

const summaryFor = async (args: WorkItemsListWireArgs): Promise<CompanionListSummary> => {
  const normalized = normalizeWorkItemsListArgs(args);
  const aggregate = await readWorkItemsSummaryFromStore(sql, workspaceId, buildWorkItemsPredicate(normalized));
  return composeCompanionSummary(aggregate, { selection: workItemsSummarySelection(normalized) });
};

beforeAll(async () => {
  db = await createFreshPgDb('work-items-list-query');
  sql = db.sql;
  await sql.unsafe('CREATE SCHEMA IF NOT EXISTS harness_shared');
  await sql.unsafe(HARNESS_FEATURES_CONSOLIDATED_DDL);
  await sql.unsafe(WORK_ITEM_DEPS_DDL);
  await sql.unsafe(SPAWNED_AGENTS_DDL);
  await sql.unsafe(WORK_ITEMS_UPDATED_INDEX_DDL);
  await sql`
    INSERT INTO harness_shared.work_items
      (workspace_id, harness_slug, feature_id, title, summary, status, item_kind,
       taken_by, payload, feature_order, assignee_rank, source_plan_slug,
       created_ts, updated_ts, origin)
    SELECT ${workspaceId},
           ${harnessSlug},
           'P4WI-' || lpad(g::text, 5, '0'),
           CASE WHEN g = ${DEEP} THEN 'deep-only-match' ELSE 'ordinary work item ' || g END,
           '',
           (ARRAY['open','blocked','wip','done'])[1 + (g % 4)],
           CASE WHEN g % 3 = 0 THEN 'feature' WHEN g % 3 = 1 THEN 'bug' ELSE 'change' END,
           'su-' || (g % 6),
           CASE WHEN g % 3 = 0 THEN '{}'::jsonb
                ELSE jsonb_build_object('_ei', jsonb_build_object(
                  'severity', CASE WHEN g % 2 = 0 THEN 'minor' ELSE 'major' END
                )) END,
           g % 10,
           g % 7,
           'plan-' || (g % 5),
           ${BASE_TS}::bigint - g,
           ${BASE_TS}::bigint - g,
           'local'
      FROM generate_series(1, ${ROWS}) AS g`;
  await sql`
    INSERT INTO harness_shared.spawned_agents
      (spawn_id, workspace_id, harness_slug, parent_role, child_role,
       feature_id, run_id, status, started_at)
    VALUES (${`p4-spawn-${token}`}, ${workspaceId}, ${harnessSlug}, 'su', 'reviewer',
            ${rowFor(DEEP).id}, ${`p4-run-${token}`}, 'done', now())`;
}, 60_000);

afterAll(async () => {
  await db?.cleanup();
});

describe('workItems.byHarness + workItems.summary real-PG contract', () => {
  it('carries current acceptance, stale reasons and evidence on a bounded row without leaking payload or body', async () => {
    const id = rowFor(DEEP).id;
    const source = { kind: rowFor(DEEP).kind, title: 'deep-only-match', summary: 'source content' };
    const sealed = sealImplementationAcceptance({ proposal: {
      problem: 'A measured queue defect', evidence: ['WI-10004573'], outcome: 'Queue explains acceptance',
      scope: 'selected harness', completionCheck: 'Read the selected row',
    }, source, authority: { kind: 'agent-review', reviewer: 'su-reviewer', submittedBy: 'su-filer', round: 1 },
      reason: 'Reviewed the source evidence', acceptedAt: '2026-10-01T00:00:00.000Z' });
    expect(sealed.ok).toBe(true);
    if (!sealed.ok) throw new Error('fixture acceptance must seal');
    const payload = { implementationReadiness: { schemaVersion: 'implementation-readiness-v1',
      status: 'ready', source: 'agent-review', reason: 'Evidence reviewed', updatedAt: '2026-10-01T00:00:00.000Z',
      evidence: { acceptance: sealed.contract } } };
    const previous = await sql`SELECT summary, payload FROM harness_shared.work_items WHERE workspace_id = ${workspaceId} AND harness_slug = ${harnessSlug} AND feature_id = ${id}`;
    try {
      await sql`UPDATE harness_shared.work_items SET summary = ${source.summary}, payload = ${sql.json(JSON.parse(JSON.stringify(payload)))} WHERE workspace_id = ${workspaceId} AND harness_slug = ${harnessSlug} AND feature_id = ${id}`;
      const read = () => readWorkItemsPageFromStore(sql, workspaceId, buildWorkItemsPredicate(normalizeWorkItemsListArgs({ harnessSlug, filters: { id }, limit: 1 })));
      const accepted = (await read()).rows[0]!;
      expect(accepted.presentation).toMatchObject({ stage: 'accepted-blocked', evidenceRefs: ['WI-10004573'] });
      expect(accepted).not.toHaveProperty('payload');
      expect(accepted.summary).toBe('');
      await sql`UPDATE harness_shared.work_items SET summary = 'changed source' WHERE workspace_id = ${workspaceId} AND harness_slug = ${harnessSlug} AND feature_id = ${id}`;
      const stale = (await read()).rows[0]!;
      expect(stale.presentation).toMatchObject({ stage: 'candidate' });
      expect(stale.presentation?.reason).toContain('acceptance-revision-stale');
    } finally {
      await sql`UPDATE harness_shared.work_items SET summary = ${previous[0]!.summary}, payload = ${sql.json(previous[0]!.payload)} WHERE workspace_id = ${workspaceId} AND harness_slug = ${harnessSlug} AND feature_id = ${id}`;
    }
  });
  it('proves OR-within/AND-across parity, beyond-page reachability, exact zero, and cursor termination', async () => {
    const args: WorkItemsListWireArgs = {
      harnessSlug,
      filters: {
        kinds: ['bug', 'change'],
        states: ['open', 'blocked'],
        assignees: ['su-1', 'su-2'],
        severities: ['minor', 'major'],
        plans: ['plan-3', 'plan-4'],
        priorityMin: 2,
        priorityMax: 8,
        rankMin: 1,
        rankMax: 6,
      },
      limit: 500,
    };
    expect(matches(rowFor(DEEP), args)).toBe(true);
    await assertCompanionPredicateParity({
      corpus,
      pageCap: 500,
      args,
      zeroMatchArgs: { harnessSlug, q: 'no-such-p4-row' },
      beyondPageRowId: rowFor(DEEP).id,
      rowId: (row) => row.id,
      predicate: matches,
      facetBasePredicate: matchesFacetBase,
      facetDefs,
      selection,
      readPage: pageFor,
      readSummary: summaryFor,
    });
  }, 60_000);

  it('reproduces 31,133-vs-500 without substituting workspace or page counts', async () => {
    const args = { harnessSlug, limit: 500 } satisfies WorkItemsListWireArgs;
    const started = performance.now();
    const [page, summary] = await Promise.all([pageFor(args, null), summaryFor(args)]);
    const elapsedMs = performance.now() - started;
    expect(page.rows).toHaveLength(500);
    expect(page.hasMore).toBe(true);
    expect(summary).toMatchObject({ total: ROWS, matched: ROWS });
    expect(JSON.stringify(page.rows).length).toBeLessThan(512_000);
    expect(elapsedMs).toBeLessThan(LIST_READ_BUDGET_MS);
  }, 30_000);

  it('uses an index-backed newest-first plan on the above-live-size corpus', async () => {
    const explained = await sql<{ 'QUERY PLAN': unknown }[]>`
      EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
      SELECT wi.feature_id
        FROM harness_shared.work_items wi
       WHERE wi.workspace_id = ${workspaceId}
         AND wi.harness_slug = ${harnessSlug}
         AND wi.lane IS DISTINCT FROM 'observation'
       ORDER BY wi.updated_ts DESC, wi.feature_id DESC
       LIMIT 501`;
    const plan = JSON.stringify(explained[0]?.['QUERY PLAN'] ?? explained);
    expect(plan).toMatch(/Index|Bitmap/);
  }, 30_000);
});
