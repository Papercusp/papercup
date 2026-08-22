// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { composeCompanionSummary } from '@papercusp/facets';
import { createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';
import { HARNESS_FEATURES_CONSOLIDATED_DDL } from '../../test/_work-items-schema';
import {
  normalizeRetainFeedArgs,
  readRetainFeed,
  readRetainSummaryAggregateRows,
  retainFeedSummarySelection,
  type RetainFeedDeps,
  type RetainFeedOpts,
} from './learning-retain-read';

const ROWS = 620;
const DEEP = 611;
const workspaceId = 'p7-learning-retain-real-pg';
const harnessSlug = 'p7-retain-hive';
const deepId = `P7WI-${DEEP.toString().padStart(4, '0')}`;
const BASE_TS = 1_900_000_000_000;
let db: FreshPgDb;
let sql: Sql;

const deps: RetainFeedDeps = {
  listMemories: async () => [],
  listRubrics: async () => [],
  listRecipesPage: async () => [],
  countRecipes: async () => 0,
  summarizeRecipes: async () => ({ total: 0, matched: 0 }),
  listRunbooksPage: async () => [],
  countRunbooks: async () => 0,
  summarizeRunbooks: async () => ({ total: 0, matched: 0 }),
};

const scoped = (opts: RetainFeedOpts): RetainFeedOpts => ({
  ...opts,
  harnessScopes: [`harness:${harnessSlug}`],
});

beforeAll(async () => {
  db = await createFreshPgDb('learning-retain-query');
  sql = db.sql;
  await sql.unsafe('CREATE SCHEMA IF NOT EXISTS harness_shared');
  await sql.unsafe(HARNESS_FEATURES_CONSOLIDATED_DDL);
  await sql.unsafe(`
    CREATE TABLE harness_shared.scout_routed_ideas (
      idea_id text PRIMARY KEY,
      workspace_id text NOT NULL,
      harness_slug text NOT NULL,
      lens text NOT NULL,
      rail text NOT NULL,
      routed_ref text NOT NULL,
      title text,
      routed_at bigint NOT NULL
    )`);
  await sql`
    INSERT INTO harness_shared.work_items
      (workspace_id, harness_slug, feature_id, title, summary, status,
       item_kind, payload, created_ts, updated_ts, origin)
    SELECT ${workspaceId},
           ${harnessSlug},
           'P7WI-' || lpad(g::text, 4, '0'),
           CASE WHEN g = ${DEEP} THEN 'deep-only-retain-match'
                ELSE 'ordinary retained work item ' || g END,
           '',
           CASE WHEN g % 2 = 0 THEN 'done' ELSE 'open' END,
           'bug',
           '{}',
           ${BASE_TS}::bigint - g,
           ${BASE_TS}::bigint - g,
           'local'
      FROM generate_series(1, ${ROWS}) AS g`;
  await sql`
    INSERT INTO harness_shared.scout_routed_ideas
      (idea_id, workspace_id, harness_slug, lens, rail, routed_ref, title, routed_at)
    SELECT 'p7-idea-' || lpad(g::text, 4, '0'),
           ${workspaceId},
           ${harnessSlug},
           CASE WHEN g % 3 = 0 THEN 'risk-first' ELSE 'user-value' END,
           'improvement',
           'wi:P7WI-' || lpad(g::text, 4, '0'),
           'idea ' || g,
           ${BASE_TS}::bigint - g
      FROM generate_series(1, ${ROWS}) AS g`;
}, 60_000);

afterAll(async () => {
  await db?.cleanup();
  // EI-10571: cleanup closes this fixture's client, then DROP DATABASE ...
  // WITH (FORCE) runs against the shared reusable test container. PostgreSQL
  // may spend 6s-267s+ draining concurrent backends and deleting database files
  // on the fleet host, so the ordinary 60s Vitest hook budget produces a false
  // red after every assertion has passed. Keep cleanup strict, but give the
  // canonical teardown path the same 300s budget as the other real-PG suites.
}, 300_000);

describe('learning.retainFeed + summary — real Postgres P-007 contract', () => {
  it('finds the only match beyond the first 500 unfiltered rows and returns exact scoped facets', async () => {
    const opts = scoped({
      tab: 'wi',
      q: 'deep-only-retain-match',
      filters: { statuses: ['open'], lenses: ['user-value', 'risk-first'] },
      limit: 75,
    });
    const started = performance.now();
    const [page, aggregate] = await Promise.all([
      readRetainFeed(sql, workspaceId, deps, opts),
      readRetainSummaryAggregateRows(sql, workspaceId, deps, opts),
    ]);
    const normalized = normalizeRetainFeedArgs(opts);
    const summary = composeCompanionSummary(aggregate, {
      selection: retainFeedSummarySelection(normalized),
    });
    expect(page.rows.map((row) => row.id)).toEqual([deepId]);
    expect(summary).toMatchObject({ total: ROWS, matched: 1 });
    expect(summary.facets.find((facet) => facet.key === 'status')?.values).toContainEqual(
      expect.objectContaining({ value: 'open', count: 1 }),
    );
    expect(performance.now() - started).toBeLessThan(6_000);
  });

  it('terminates an active-filter cursor without skipping or duplicating rows', async () => {
    const base = scoped({
      tab: 'wi',
      filters: { statuses: ['done'], lenses: ['risk-first'] },
      limit: 100,
    });
    const ids: string[] = [];
    let cursor: string | null = null;
    for (let pageNo = 0; pageNo < 20; pageNo += 1) {
      const page = await readRetainFeed(sql, workspaceId, deps, { ...base, cursor });
      ids.push(...page.rows.map((row) => row.id));
      cursor = page.nextCursor;
      if (!cursor) break;
    }
    const expected = Array.from({ length: ROWS }, (_, index) => index + 1)
      .filter((g) => g % 2 === 0 && g % 3 === 0)
      .map((g) => `P7WI-${g.toString().padStart(4, '0')}`);
    expect(cursor).toBeNull();
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.slice().sort()).toEqual(expected.sort());
  });
});
