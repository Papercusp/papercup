// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { composeCompanionSummary, type CompanionListSummary } from '@papercusp/facets';
import { createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';
import {
  buildDesignFeaturesPredicate,
  designFeaturesSummarySelection,
  normalizeDesignFeaturesListArgs,
  readDesignFeaturesPageFromStore,
  readDesignFeaturesSummaryFromStore,
  type DesignFeatureStatus,
  type DesignFeaturesListWireArgs,
} from './design-features-list-query';

const ROWS = 625;
const workspaceId = 'p11-design-ws';
const foreignWorkspaceId = 'p11-design-foreign';
const harnessSlug = 'p11-design-harness';
const deepFeatureId = 'DF-0575';
const BASE_TS = 2_000_000_000_000;
let db: FreshPgDb;
let sql: Sql;

const statusFor = (g: number): DesignFeatureStatus => {
  if (g % 5 === 0) return 'pending'; // NULL is normalized to pending by SQL.
  if (g % 3 === 0) return 'accepted';
  if (g % 3 === 1) return 'ignored';
  return 'pending';
};

const expectedStatusCounts = (): Record<DesignFeatureStatus, number> => {
  const counts = { pending: 0, accepted: 0, ignored: 0 };
  for (let g = 1; g <= ROWS; g += 1) counts[statusFor(g)] += 1;
  return counts;
};

const pageFor = async (args: DesignFeaturesListWireArgs, cursor: string | null = null) => {
  const normalized = normalizeDesignFeaturesListArgs({ ...args, cursor });
  return readDesignFeaturesPageFromStore(sql, buildDesignFeaturesPredicate(normalized));
};

const summaryFor = async (args: DesignFeaturesListWireArgs): Promise<CompanionListSummary> => {
  const normalized = normalizeDesignFeaturesListArgs(args);
  const aggregate = await readDesignFeaturesSummaryFromStore(sql, buildDesignFeaturesPredicate(normalized));
  return composeCompanionSummary(aggregate, {
    selection: designFeaturesSummarySelection(normalized),
  });
};

const statusCounts = (summary: CompanionListSummary): Record<DesignFeatureStatus, number> => {
  const values = summary.facets.find((facet) => facet.key === 'status')?.values ?? [];
  const count = (status: DesignFeatureStatus) => values.find((value) => value.value === status)?.count ?? -1;
  return {
    pending: count('pending'),
    accepted: count('accepted'),
    ignored: count('ignored'),
  };
};

beforeAll(async () => {
  db = await createFreshPgDb('design-features-list-query');
  sql = db.sql;
  await sql.unsafe('CREATE SCHEMA IF NOT EXISTS harness_shared');
  await sql.unsafe(`
    CREATE TABLE harness_shared.work_items (
      workspace_id text NOT NULL,
      harness_slug text NOT NULL,
      feature_id text NOT NULL,
      title text,
      summary text,
      notes text,
      item_kind text NOT NULL,
      needs_design boolean NOT NULL DEFAULT false,
      design_status text,
      created_ts bigint,
      updated_ts bigint,
      _search tsvector GENERATED ALWAYS AS (
        setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
        setweight(to_tsvector('english', coalesce(summary, '')), 'B') ||
        setweight(to_tsvector('english', coalesce(notes, '')), 'C')
      ) STORED,
      admission text, admitted_at timestamptz, admitted_by text,
      PRIMARY KEY (harness_slug, feature_id)
    )`);
  await sql.unsafe(`
    CREATE VIEW harness_shared.harness_features_consolidated AS
      SELECT *
        FROM harness_shared.work_items
       WHERE item_kind NOT IN ('bug', 'change', 'task')`);
  await sql.unsafe(`
    CREATE INDEX work_items_design_created_keyset_idx
      ON harness_shared.work_items (
        workspace_id,
        harness_slug,
        (coalesce(created_ts, 0)) DESC,
        feature_id DESC
      )
      WHERE needs_design = TRUE
        AND item_kind NOT IN ('bug', 'change', 'task')`);
  await sql`
    INSERT INTO harness_shared.work_items
      (workspace_id, harness_slug, feature_id, title, summary, notes,
       item_kind, needs_design, design_status, created_ts, updated_ts)
    SELECT ${workspaceId},
           ${harnessSlug},
           'DF-' || lpad(g::text, 4, '0'),
           CASE WHEN g = 575 THEN 'Needle blueprint'
                ELSE 'Design feature ' || g END,
           CASE WHEN g = 575 THEN 'A singular deep-corpus target'
                ELSE 'Ordinary design work' END,
           NULL,
           'feature',
           TRUE,
           CASE WHEN g % 5 = 0 THEN NULL
                WHEN g % 3 = 0 THEN 'accepted'
                WHEN g % 3 = 1 THEN 'ignored'
                ELSE 'pending' END,
           ${BASE_TS}::bigint - g,
           ${BASE_TS}::bigint - g
      FROM generate_series(1, ${ROWS}) AS g`;

  // Controls outside the declared queue population.
  await sql`
    INSERT INTO harness_shared.work_items
      (workspace_id, harness_slug, feature_id, title, item_kind, needs_design,
       design_status, created_ts, updated_ts)
    VALUES
      (${foreignWorkspaceId}, ${harnessSlug}, 'DF-FOREIGN', 'Needle blueprint',
       'feature', TRUE, 'pending', ${BASE_TS + 2}, ${BASE_TS + 2}),
      (${workspaceId}, ${harnessSlug}, 'DF-NO-DESIGN', 'Needle blueprint',
       'feature', FALSE, 'pending', ${BASE_TS + 1}, ${BASE_TS + 1}),
      (${workspaceId}, ${harnessSlug}, 'DF-ISSUE', 'Needle blueprint',
       'bug', TRUE, 'pending', ${BASE_TS + 3}, ${BASE_TS + 3})`;
}, 60_000);

afterAll(async () => {
  await db?.cleanup();
}, 300_000);

describe('Design feature list + summary real-PG P-011 contract', () => {
  it('finds a search/status match beyond 500 and returns every exact bucket in one companion', async () => {
    const args: DesignFeaturesListWireArgs = {
      workspaceId,
      harnessSlug,
      q: 'needle blueprint',
      statuses: ['pending'],
      limit: 25,
    };
    const started = performance.now();
    const [page, summary] = await Promise.all([pageFor(args), summaryFor(args)]);

    expect(page.rows).toEqual([
      {
        featureId: deepFeatureId,
        title: 'Needle blueprint',
        designStatus: 'pending',
      },
    ]);
    expect(summary).toMatchObject({ total: ROWS, matched: 1 });
    expect(statusCounts(summary)).toEqual({
      pending: 1,
      accepted: 0,
      ignored: 0,
    });
    expect(Buffer.byteLength(JSON.stringify(page.rows))).toBeLessThan(10_000);
    expect(performance.now() - started).toBeLessThan(6_000);
  });

  it('keeps NULL in pending, composes multi-status OR, and preserves an exact empty result', async () => {
    const expected = expectedStatusCounts();
    const unfiltered = await summaryFor({ workspaceId, harnessSlug });
    expect(unfiltered).toMatchObject({ total: ROWS, matched: ROWS });
    expect(statusCounts(unfiltered)).toEqual(expected);

    const multiArgs: DesignFeaturesListWireArgs = {
      workspaceId,
      harnessSlug,
      statuses: ['accepted', 'ignored'],
      limit: 250,
    };
    const [multiPage, multiSummary] = await Promise.all([pageFor(multiArgs), summaryFor(multiArgs)]);
    expect(multiPage.rows.every((row) => row.designStatus === 'accepted' || row.designStatus === 'ignored')).toBe(true);
    expect(multiSummary.matched).toBe(expected.accepted + expected.ignored);
    // Status facets omit their own selected dimension, so every bucket remains
    // an exact drill-down promise instead of collapsing to the selected pair.
    expect(statusCounts(multiSummary)).toEqual(expected);

    const emptyArgs: DesignFeaturesListWireArgs = {
      workspaceId,
      harnessSlug,
      q: 'definitely absent design phrase',
      statuses: ['ignored'],
      limit: 25,
    };
    const [emptyPage, emptySummary] = await Promise.all([pageFor(emptyArgs), summaryFor(emptyArgs)]);
    expect(emptyPage).toMatchObject({
      rows: [],
      nextCursor: null,
      hasMore: false,
    });
    expect(emptySummary).toMatchObject({ total: ROWS, matched: 0 });
    expect(statusCounts(emptySummary)).toEqual({
      pending: 0,
      accepted: 0,
      ignored: 0,
    });
  });

  it('walks every immutable birth boundary once while updated_ts mutates and a newer birth arrives', async () => {
    const args: DesignFeaturesListWireArgs = {
      workspaceId,
      harnessSlug,
      limit: 97,
    };
    const ids: string[] = [];
    let cursor: string | null = null;
    let pageNo = 0;
    for (;;) {
      const page = await pageFor(args, cursor);
      ids.push(...page.rows.map((row) => row.featureId));
      cursor = page.nextCursor;
      if (pageNo === 0) {
        await sql`
          UPDATE harness_shared.work_items
             SET updated_ts = ${BASE_TS + 50_000}
           WHERE workspace_id = ${workspaceId}
             AND harness_slug = ${harnessSlug}
             AND feature_id = 'DF-0600'`;
        await sql`
          INSERT INTO harness_shared.work_items
            (workspace_id, harness_slug, feature_id, title, item_kind,
             needs_design, design_status, created_ts, updated_ts)
          VALUES (${workspaceId}, ${harnessSlug}, 'DF-NEWER-AFTER-CURSOR',
                  'Newer after cursor', 'feature', TRUE, 'accepted',
                  ${BASE_TS + 60_000}, ${BASE_TS + 60_000})`;
      }
      pageNo += 1;
      if (!cursor) break;
      expect(pageNo).toBeLessThan(10);
    }

    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(ROWS);
    expect(ids).toContain('DF-0600');
    expect(ids).not.toContain('DF-NEWER-AFTER-CURSOR');
  }, 60_000);
});
