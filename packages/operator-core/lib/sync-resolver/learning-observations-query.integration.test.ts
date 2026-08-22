// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { randomBytes } from 'node:crypto';
import { composeCompanionSummary, type CompanionListSummary, type FacetDef } from '@papercusp/facets';
import { createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';
import { HARNESS_FEATURES_CONSOLIDATED_DDL } from '../../test/_work-items-schema';
import { assertCompanionPredicateParity } from './count-contract-testkit';
import { LIST_READ_BUDGET_MS } from './bounded-list-read';
import { PAYLOAD_BUDGET_BYTES } from './sync-read-audit';
import {
  buildLearningObservationsPredicate,
  learningObservationsSummarySelection,
  normalizeLearningObservationsArgs,
  readLearningObservationsPageFromStore,
  readLearningObservationsSummaryFromStore,
  type LearningObservationRow,
  type LearningObservationsWireArgs,
} from './learning-observations-read';

// Above the 46,964-row live raw-observation corpus measured 2026-08-22 and the
// retired 2,000-row cap. The distinguished match is deep in newest-first order.
const ROWS = 50_205;
const DEEP = 50_153;
const token = randomBytes(5).toString('hex');
const workspaceId = `p5-observations-${token}`;
const harnessSlug = `p5-harness-${token}`;
const BASE_TS = 1_900_000_000_000;
let db: FreshPgDb;
let sql: Sql;

interface FixtureRow extends LearningObservationRow {
  kind: string;
  scope: string;
  confidence: string;
  sourceRole: string;
}

const rowFor = (g: number): FixtureRow => ({
  id: `P5OBS-${g.toString().padStart(5, '0')}`,
  title: g === DEEP ? 'deep-only-match' : `ordinary observation ${g}`,
  body: `body ${g}`,
  kind: ['friction', 'workaround', 'gap', 'surprise', 'reinforce', 'other'][g % 6]!,
  scope: `scope-${g % 10}`,
  confidence: ['low', 'med', 'high', 'unknown'][g % 4]!,
  sourceRole: `role-${g % 5}`,
  refs: g === DEEP ? ['context:plan-deep/P-005'] : [`plan-${g % 7}`],
  createdAt: new Date(BASE_TS - g).toISOString(),
});

const corpus = Array.from({ length: ROWS }, (_, index) => rowFor(index + 1));

const planMatches = (row: FixtureRow, plans: readonly string[]): boolean => {
  if (plans.length === 0) return true;
  return plans.some((plan) => {
    const slug = plan.toLowerCase();
    const tokenPattern = new RegExp(`(^|[^a-z0-9_-])${slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9_-])`);
    return row.refs.some((ref) => {
      const lowered = ref.toLowerCase();
      return lowered === slug || lowered === `plan:${slug}` || tokenPattern.test(lowered);
    });
  });
};

const facetBasePredicate = (row: FixtureRow, wire: LearningObservationsWireArgs): boolean => {
  const args = normalizeLearningObservationsArgs(wire);
  const q = args.q?.toLowerCase() ?? null;
  const haystack = `${row.title} ${row.body ?? ''} ${row.kind} ${row.refs.join(' ')}`.toLowerCase();
  return (!q || haystack.includes(q)) && planMatches(row, args.filters.plans);
};

const matches = (row: FixtureRow, wire: LearningObservationsWireArgs): boolean => {
  const args = normalizeLearningObservationsArgs(wire);
  const f = args.filters;
  return (
    facetBasePredicate(row, wire) &&
    (f.scopes.length === 0 || f.scopes.includes(row.scope)) &&
    (f.sourceRoles.length === 0 || f.sourceRoles.includes(row.sourceRole)) &&
    (f.confidences.length === 0 || f.confidences.includes(row.confidence)) &&
    (f.kinds.length === 0 || f.kinds.includes(row.kind))
  );
};

const facetDefs: readonly FacetDef<FixtureRow>[] = [
  { key: 'kind', extract: (row) => row.kind },
  { key: 'scope', extract: (row) => row.scope },
  { key: 'sourceRole', extract: (row) => row.sourceRole },
  { key: 'confidence', extract: (row) => row.confidence },
];

const pageFor = async (args: LearningObservationsWireArgs, cursor: string | null) => {
  const normalized = normalizeLearningObservationsArgs({ ...args, cursor });
  return readLearningObservationsPageFromStore(
    sql,
    workspaceId,
    buildLearningObservationsPredicate(normalized),
  ) as Promise<{ rows: FixtureRow[]; nextCursor: string | null; hasMore: boolean }>;
};

const summaryFor = async (args: LearningObservationsWireArgs): Promise<CompanionListSummary> => {
  const normalized = normalizeLearningObservationsArgs(args);
  const aggregate = await readLearningObservationsSummaryFromStore(
    sql,
    workspaceId,
    buildLearningObservationsPredicate(normalized),
  );
  return composeCompanionSummary(aggregate, {
    selection: learningObservationsSummarySelection(normalized),
  });
};

beforeAll(async () => {
  db = await createFreshPgDb('learning-observations-query');
  sql = db.sql;
  await sql.unsafe('CREATE SCHEMA IF NOT EXISTS harness_shared');
  await sql.unsafe(HARNESS_FEATURES_CONSOLIDATED_DDL);
  await sql`
    INSERT INTO harness_shared.work_items
      (workspace_id, harness_slug, feature_id, title, summary, status,
       item_kind, payload, created_ts, updated_ts, origin)
    SELECT ${workspaceId},
           ${harnessSlug},
           'P5OBS-' || lpad(g::text, 5, '0'),
           CASE WHEN g = ${DEEP} THEN 'deep-only-match'
                ELSE 'ordinary observation ' || g END,
           'body ' || g,
           'open',
           'bug',
           jsonb_build_object(
             'lane', 'observation',
             'filedByRole', 'role-' || (g % 5),
             'observation', jsonb_build_object(
               'kind', (ARRAY['friction','workaround','gap','surprise','reinforce','other'])[1 + (g % 6)],
               'scope', 'scope-' || (g % 10),
               'confidence', (ARRAY['low','med','high','unknown'])[1 + (g % 4)],
               'refs', CASE WHEN g = ${DEEP}
                            THEN jsonb_build_array('context:plan-deep/P-005')
                            ELSE jsonb_build_array('plan-' || (g % 7)) END
             )
           ),
           ${BASE_TS}::bigint - g,
           ${BASE_TS}::bigint - g,
           'local'
      FROM generate_series(1, ${ROWS}) AS g`;
}, 60_000);

afterAll(async () => {
  await db?.cleanup();
});

describe('learning.observations + summary real-PG contract', () => {
  it('proves OR-within/AND-across parity, exact zero, facets, and cursor termination above live size', async () => {
    const deep = rowFor(DEEP);
    const args: LearningObservationsWireArgs = {
      filters: {
        scopes: [deep.scope, 'scope-9'],
        sourceRoles: [deep.sourceRole, 'role-4'],
        confidences: [deep.confidence, 'unknown'],
        kinds: [deep.kind, 'gap'],
      },
      limit: 200,
    };
    await assertCompanionPredicateParity({
      corpus,
      pageCap: 200,
      args,
      zeroMatchArgs: { q: 'no-such-p5-observation', limit: 200 },
      beyondPageRowId: deep.id,
      rowId: (row) => row.id,
      predicate: matches,
      facetBasePredicate,
      facetDefs,
      selection: (wire) => learningObservationsSummarySelection(normalizeLearningObservationsArgs(wire)),
      readPage: pageFor,
      readSummary: summaryFor,
    });
  }, 60_000);

  it('finds the only text and selected-plan match beyond page one', async () => {
    const textRows = await pageFor({ q: 'deep-only-match', limit: 200 }, null);
    expect(textRows.rows.map((row) => row.id)).toEqual([rowFor(DEEP).id]);
    const planRows = await pageFor({ filters: { plans: ['plan-deep'] }, limit: 200 }, null);
    expect(planRows.rows.map((row) => row.id)).toEqual([rowFor(DEEP).id]);
  });

  it('keeps the paired response bounded and under the shared six-second budget', async () => {
    const started = performance.now();
    const [page, summary] = await Promise.all([pageFor({ limit: 200 }, null), summaryFor({ limit: 200 })]);
    const elapsedMs = performance.now() - started;
    expect(page.rows).toHaveLength(200);
    expect(page.hasMore).toBe(true);
    expect(summary).toMatchObject({ total: ROWS, matched: ROWS });
    expect(Buffer.byteLength(JSON.stringify({ page, summary }), 'utf8')).toBeLessThan(PAYLOAD_BUDGET_BYTES);
    expect(elapsedMs).toBeLessThan(LIST_READ_BUDGET_MS);
  }, 30_000);
});
