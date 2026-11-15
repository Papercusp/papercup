/**
 * scorecards-superseder-plan-shape.integration.test.ts — listScorecards' per-row
 * superseder probe must never be served by a BitmapAnd over the rubric-wide index
 * (WI-6554700010048117; regression guard for EI-28715010811839096 / migration 1631).
 *
 * WHY. The default listScorecards read excludes superseded cards with a correlated
 * NOT EXISTS over harness_shared.engineer_issues. Before migration 1631 the planner
 * served that probe by BitmapAnd-ing work_items_obs_rubric_ref_v2_idx (every card of
 * the rubric) with work_items_obs_supersedes_v2_idx on EVERY outer row, which costs
 * O(rubric size) per row. Measured on the live box 2026-11-13: 8.4 s for
 * scorecards:list { rubricRef:'grading-integrity' } at ~9,500 cards, past the
 * statement timeout (pg 57014), so no grading-integrity audit could settle.
 *
 * HOW. Same method as issues-list-query-plan.integration.test.ts: capture the EXACT
 * statement listScorecards sends (postgres.js `debug` hook, with its bound
 * parameters) and EXPLAIN it, so the guard pins the real code path rather than a
 * hand-copied query. The schema comes from createOrgTestDb (every migration, the
 * real engineer_issues view).
 *
 * WHAT IS ASSERTED, AND WHAT IS NOT. Earlier versions asserted the planner's CHOICE
 * of index under default settings. That choice depends on live statistics (483k rows,
 * shares measured 2026-11-13) that a synthetic fixture did not reproduce across three
 * fixture sizes (attempt audit on WI-6554700010048117, thread-post 1227104), so this
 * guard asserts the invariant instead: the probe plan contains no BitmapAnd that reads
 * the rubric-wide index. Two further cases keep it honest without relying on seeded
 * statistics: (1) the detector recognises the verbatim pre-1631 plan from the
 * migration header, so the invariant is not vacuous; (2) with only bitmap scans
 * allowed (SET LOCAL inside a rolled-back transaction), the real probe statement
 * reaches the 1631 index, and cannot once that index is dropped in the same
 * transaction. Case (2) fails if the index expressions drift from the query's, which
 * is the property migration 1631 relies on.
 *
 * NOT ASSERTED: reproducing the pre-1631 BitmapAnd itself on the fixture. Run 4
 * (2026-11-14, rolled-back DROP INDEX plus enable_* switches, rubrics at 2% and 45% of
 * the table) never produced it: without the index the planner took a single bitmap
 * scan of the supersedes index. The live 8.4 s plan came from production statistics.
 * The fixture stays under ANALYZE's 30,000-row sample so its statistics are
 * deterministic.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import type { OrgTestDb } from '../test/_org-test-db';

const PROBE_INDEX = 'work_items_obs_supersedes_rubric_probe_idx';
const PRIMARY_INDEX = 'work_items_scorecard_created_keyset_idx';
const SPEC_SERIES_INDEX = 'work_items_obs_spec_quality_series_idx';
const RUBRIC_WIDE_INDEX = 'work_items_obs_rubric_ref_v2_idx';
const SUPERSEDES_INDEX = 'work_items_obs_supersedes_v2_idx';
const RUBRIC = 'test-superseder-plan-shape';
const OTHER_RUBRIC = 'test-superseder-plan-shape-other';
// A rubric that is a small share of the table, as grading-integrity is live (~2%).
const SMALL_RUBRIC = 'test-superseder-plan-shape-small';
const SOURCE_HIVE = 'papercusp';
const TARGET_ROWS = 5_000;
const OTHER_ROWS = 5_000;
const SMALL_ROWS = 200;
const SUPERSEDERS = 20;
const SMALL_SUPERSEDERS = 5;
const OTHER_SUPERSEDERS = 1_000;
const BASE_MS = 1_790_000_000_000;

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});

const { listScorecards } = await import('./scorecards');
const { issuesScopeWorkspace } = await import('./issues-engineer');
const { createOrgTestDb } = await import('../test/_org-test-db');

interface PlanNode {
  'Node Type': string;
  'Index Name'?: string;
  'Relation Name'?: string;
  Alias?: string;
  Plans?: PlanNode[];
}
const flatten = (node: PlanNode): PlanNode[] => [node, ...(node.Plans ?? []).flatMap(flatten)];

/** A BitmapAnd that reads the rubric-wide index: the O(rubric size)-per-row shape. */
const rubricWideBitmapAnds = (nodes: PlanNode[]): PlanNode[] =>
  nodes.filter((n) => n['Node Type'] === 'BitmapAnd' && flatten(n).some((c) => c['Index Name'] === RUBRIC_WIDE_INDEX));

const describePlan = (nodes: PlanNode[]): string =>
  nodes.map((n) => (n['Index Name'] ? `${n['Node Type']}(${n['Index Name']})` : n['Node Type'])).join(' > ');

/** The pre-1631 production plan, transcribed from the header of migration 1631. */
const PRE_1631_PLAN: PlanNode = {
  'Node Type': 'Limit',
  Plans: [
    {
      'Node Type': 'Nested Loop',
      Plans: [
        { 'Node Type': 'Index Scan', 'Index Name': RUBRIC_WIDE_INDEX },
        {
          'Node Type': 'Bitmap Heap Scan',
          Plans: [
            {
              'Node Type': 'BitmapAnd',
              Plans: [
                { 'Node Type': 'Bitmap Index Scan', 'Index Name': RUBRIC_WIDE_INDEX },
                { 'Node Type': 'Bitmap Index Scan', 'Index Name': SUPERSEDES_INDEX },
              ],
            },
          ],
        },
      ],
    },
  ],
};

/** Nested-loop probe with bitmap scans only: the access paths a per-row probe can take. */
const BITMAP_ONLY = ['enable_hashjoin = off', 'enable_mergejoin = off', 'enable_indexscan = off', 'enable_indexonlyscan = off'];
const usesIndex = (nodes: PlanNode[], index: string) => nodes.some((n) => n['Index Name'] === index);

const targetId = (g: number) => `EI-psp-${String(g).padStart(5, '0')}`;
const supersederId = (g: number) => `EI-psp-sup-${String(g).padStart(2, '0')}`;

let db: OrgTestDb;
let traced: postgres.Sql;
const captured: { query: string; params: unknown[] }[] = [];

/** Run the production-shaped read once and return the superseder-excluding statement it sent. */
async function captureListScorecards(rubricRef: string | undefined, limit: number, sourceHive: string | null = SOURCE_HIVE) {
  captured.length = 0;
  let rows;
  try {
    rows = await listScorecards({ rubricRef, sourceHive: sourceHive ?? undefined, limit });
  } catch (error) {
    const statement = captured.find((c) => /AS superseder/.test(c.query));
    if (statement) {
      const plan = await db.adminSql.unsafe(`EXPLAIN (FORMAT JSON) ${statement.query}`, statement.params as never[]);
      console.error('listScorecards failed; exact SQL and planner diagnostics', JSON.stringify({ statement, plan }));
    }
    throw error;
  }
  const statement = captured.find(
    (c) => /NOT EXISTS/.test(c.query) && /AS superseder/.test(c.query) && /ORDER BY scorecard\.created_at DESC/.test(c.query),
  );
  expect(statement, 'listScorecards sent no superseder-excluding statement').toBeDefined();
  return { rows, statement: statement! };
}

async function explain(sql: postgres.Sql | postgres.TransactionSql, statement: { query: string; params: unknown[] }) {
  const explained = await sql.unsafe(`EXPLAIN (FORMAT JSON) ${statement.query}`, statement.params as never[]);
  const plan = (explained[0] as Record<string, unknown>)['QUERY PLAN'] as { Plan: PlanNode }[];
  return flatten(plan[0]!.Plan);
}

class Rollback extends Error {}

/** EXPLAIN under a regime, optionally without one tested index; always rolled back. */
async function explainUnder(statement: { query: string; params: unknown[] }, settings: string[], dropIndex: string | false) {
  let nodes: PlanNode[] = [];
  try {
    await db.adminSql.begin(async (tx) => {
      if (dropIndex) await tx.unsafe(`DROP INDEX harness_shared.${dropIndex}`);
      for (const s of settings) await tx.unsafe(`SET LOCAL ${s}`);
      nodes = await explain(tx, statement);
      throw new Rollback();
    });
  } catch (err) {
    if (!(err instanceof Rollback)) throw err;
  }
  return nodes;
}

beforeAll(async () => {
  db = await createOrgTestDb();
  console.info('scorecard migration fixture', JSON.stringify({ database: db.dbName, disposable: true }));
  for (const index of [PROBE_INDEX, PRIMARY_INDEX, SPEC_SERIES_INDEX]) {
    const [state] = await db.adminSql`
      SELECT i.indisvalid, i.indisready, pg_get_indexdef(i.indexrelid) AS definition
        FROM pg_index i
       WHERE i.indexrelid = to_regclass(${'harness_shared.' + index})`;
    expect(state, `migrated fixture is missing ${index}`).toBeDefined();
    expect(state!.indisvalid && state!.indisready, `${index}: ${JSON.stringify(state)}`).toBe(true);
  }
  const ws = issuesScopeWorkspace();
  const card = (rubricRef: string) =>
    JSON.stringify({
      observation: {
        rubricRef,
        sourceHive: SOURCE_HIVE,
        ratings: { 'plan-shape': { rating: 'pass', evidence: 'seeded plan-shape fixture' } },
      },
    });
  // Scorecards of the audited rubric, oldest first.
  await db.adminSql`
    INSERT INTO harness_shared.work_items
      (workspace_id, harness_slug, feature_id, item_kind, status, admission, title, summary, created_ts, updated_ts, payload)
    SELECT ${ws}, 'papercusp', 'EI-psp-' || lpad(g::text, 5, '0'), 'change', 'done', 'admitted', 'scorecard ' || g, '',
           ${BASE_MS}::bigint + g * 1000::bigint, ${BASE_MS}::bigint + g * 1000::bigint, ${card(RUBRIC)}::text::jsonb
      FROM generate_series(1, ${TARGET_ROWS}) AS g`;
  // A second rubric of the same size, interleaved in time, so the rubric-wide index
  // holds several rubrics the way it does on the live corpus.
  await db.adminSql`
    INSERT INTO harness_shared.work_items
      (workspace_id, harness_slug, feature_id, item_kind, status, admission, title, summary, created_ts, updated_ts, payload)
    SELECT ${ws}, 'papercusp', 'EI-psp-o-' || lpad(g::text, 5, '0'), 'change', 'done', 'admitted', 'other ' || g, '',
           ${BASE_MS}::bigint + g * 1000::bigint + 500, ${BASE_MS}::bigint + g * 1000::bigint + 500, ${card(OTHER_RUBRIC)}::text::jsonb
      FROM generate_series(1, ${OTHER_ROWS}) AS g`;
  // A small rubric (~2% of the table) with a few superseders of its own.
  await db.adminSql`
    INSERT INTO harness_shared.work_items
      (workspace_id, harness_slug, feature_id, item_kind, status, admission, title, summary, created_ts, updated_ts, payload)
    SELECT ${ws}, 'papercusp', 'EI-psp-s-' || lpad(g::text, 5, '0'), 'change', 'done', 'admitted', 'small ' || g, '',
           ${BASE_MS}::bigint + g * 1000::bigint + 300, ${BASE_MS}::bigint + g * 1000::bigint + 300, ${card(SMALL_RUBRIC)}::text::jsonb
      FROM generate_series(1, ${SMALL_ROWS}) AS g`;
  await db.adminSql`
    INSERT INTO harness_shared.work_items
      (workspace_id, harness_slug, feature_id, item_kind, status, admission, title, summary, created_ts, updated_ts, payload)
    SELECT ${ws}, 'papercusp', 'EI-psp-ssup-' || lpad(g::text, 2, '0'), 'change', 'done', 'admitted', 'small superseder ' || g, '',
           ${BASE_MS}::bigint + (${SMALL_ROWS}::int + g) * 1000::bigint + 300, ${BASE_MS}::bigint + (${SMALL_ROWS}::int + g) * 1000::bigint + 300,
           jsonb_set(${card(SMALL_RUBRIC)}::text::jsonb, '{observation,supersedes}', to_jsonb('EI-psp-s-' || lpad(g::text, 5, '0')))
      FROM generate_series(1, ${SMALL_SUPERSEDERS}) AS g`;
  // Superseders, newer than every target: superseder g replaces target TARGET_ROWS - SUPERSEDERS + g.
  await db.adminSql`
    INSERT INTO harness_shared.work_items
      (workspace_id, harness_slug, feature_id, item_kind, status, admission, title, summary, created_ts, updated_ts, payload)
    SELECT ${ws}, 'papercusp', 'EI-psp-sup-' || lpad(g::text, 2, '0'), 'change', 'done', 'admitted', 'superseder ' || g, '',
           ${BASE_MS}::bigint + (${TARGET_ROWS}::int + g) * 1000::bigint, ${BASE_MS}::bigint + (${TARGET_ROWS}::int + g) * 1000::bigint,
           jsonb_set(${card(RUBRIC)}::text::jsonb, '{observation,supersedes}',
                     to_jsonb('EI-psp-' || lpad((${TARGET_ROWS - SUPERSEDERS}::int + g)::text, 5, '0')))
      FROM generate_series(1, ${SUPERSEDERS}) AS g`;
  // Superseders of the OTHER rubric, so the supersedes index holds many keys, as live.
  await db.adminSql`
    INSERT INTO harness_shared.work_items
      (workspace_id, harness_slug, feature_id, item_kind, status, admission, title, summary, created_ts, updated_ts, payload)
    SELECT ${ws}, 'papercusp', 'EI-psp-osup-' || lpad(g::text, 5, '0'), 'change', 'done', 'admitted', 'other superseder ' || g, '',
           ${BASE_MS}::bigint + (${OTHER_ROWS}::int + g) * 1000::bigint + 700, ${BASE_MS}::bigint + (${OTHER_ROWS}::int + g) * 1000::bigint + 700,
           jsonb_set(${card(OTHER_RUBRIC)}::text::jsonb, '{observation,supersedes}', to_jsonb('EI-psp-o-' || lpad(g::text, 5, '0')))
      FROM generate_series(1, ${OTHER_SUPERSEDERS}) AS g`;
  await db.adminSql`ANALYZE harness_shared.work_items`;

  traced = postgres(db.adminDsn, {
    max: 2,
    prepare: false,
    onnotice: () => {},
    debug: (_connection, query, params) => {
      captured.push({ query, params: params as unknown[] });
    },
  });
  h.sql = traced;
}, 180_000);

afterAll(async () => {
  await traced?.end({ timeout: 5 });
  await db?.cleanup();
});

describe('listScorecards superseder probe plan shape (migration 1631)', () => {
  it('still excludes superseded cards — the page skips the 20 superseded targets', async () => {
    const { rows } = await captureListScorecards(RUBRIC, 25);
    const expected = [
      ...Array.from({ length: SUPERSEDERS }, (_, i) => supersederId(SUPERSEDERS - i)),
      ...Array.from({ length: 5 }, (_, i) => targetId(TARGET_ROWS - SUPERSEDERS - i)),
    ];
    expect(rows.map((r) => r.issueId)).toEqual(expected);
  });

  it.each([
    [RUBRIC, 1],
    [RUBRIC, 25],
    [SMALL_RUBRIC, 1],
    [SMALL_RUBRIC, 25],
  ])('the %s probe at limit %s has no rubric-wide BitmapAnd', async (rubricRef, limit) => {
    const { statement } = await captureListScorecards(rubricRef, limit);
    const nodes = await explain(db.adminSql, statement);
    expect(rubricWideBitmapAnds(nodes), `rubric-wide BitmapAnd in the probe: ${describePlan(nodes)}`).toHaveLength(0);
  });

  it('the detector recognises the verbatim pre-1631 production plan', () => {
    expect(rubricWideBitmapAnds(flatten(PRE_1631_PLAN))).toHaveLength(1);
    // A BitmapAnd over two other indexes is not the rubric-wide shape.
    const unrelated: PlanNode = {
      'Node Type': 'BitmapAnd',
      Plans: [
        { 'Node Type': 'Bitmap Index Scan', 'Index Name': SUPERSEDES_INDEX },
        { 'Node Type': 'Bitmap Index Scan', 'Index Name': PROBE_INDEX },
      ],
    };
    expect(rubricWideBitmapAnds(flatten(unrelated))).toHaveLength(0);
  });

  it.each([SMALL_RUBRIC, RUBRIC])(
    'the %s probe reaches the 1631 index when only bitmap scans are allowed, and cannot without it',
    async (rubricRef) => {
      const { statement } = await captureListScorecards(rubricRef, 1);
      const withIndex = await explainUnder(statement, BITMAP_ONLY, false);
      const withoutIndex = await explainUnder(statement, BITMAP_ONLY, PROBE_INDEX);
      expect(usesIndex(withIndex, PROBE_INDEX), `with the index: ${describePlan(withIndex)}`).toBe(true);
      expect(rubricWideBitmapAnds(withIndex), `with the index: ${describePlan(withIndex)}`).toHaveLength(0);
      expect(usesIndex(withoutIndex, PROBE_INDEX), `without the index: ${describePlan(withoutIndex)}`).toBe(false);
      // The DROP above was rolled back, so the index still exists for later cases.
      const [idx] = await db.adminSql`SELECT to_regclass(${'harness_shared.' + PROBE_INDEX}) AS r`;
      expect(idx!.r).not.toBeNull();
    },
  );
});

describe('listScorecards primary scan and full probes (WI-6554700010049082 / migrations 1633-1634)', () => {
  beforeAll(async () => {
    // Isolate this population from migration 1631's existing probe fixture.
    // Both populations stay below ANALYZE's full 30,000-row sample.
    const ws = issuesScopeWorkspace();
    await db.adminSql`
      INSERT INTO harness_shared.work_items
        (workspace_id, harness_slug, feature_id, item_kind, status, admission, title, summary, created_ts, updated_ts, payload)
      SELECT ${ws}, 'papercusp', 'EI-psp-plain-' || lpad(g::text, 5, '0'), 'change', 'done', 'admitted', 'ordinary issue ' || g, '',
             ${BASE_MS}::bigint + g * 1000::bigint + 900, ${BASE_MS}::bigint + g * 1000::bigint + 900, '{}'::jsonb
        FROM generate_series(1, 12000) AS g`;
    // Sixteen hashes per plan across 100 series exercise the full production
    // spec-quality probe. Ordinary rubrics alone miss its per-row BitmapAnd.
    await db.adminSql`
      INSERT INTO harness_shared.work_items
        (workspace_id, harness_slug, feature_id, item_kind, status, admission, title, summary, created_ts, updated_ts, payload)
      SELECT ${ws}, 'papercusp', 'EI-psp-spec-' || lpad(g::text, 5, '0'), 'change', 'done', 'admitted', 'spec quality ' || g, '',
             ${BASE_MS}::bigint + (6000 + g) * 1000::bigint, ${BASE_MS}::bigint + (6000 + g) * 1000::bigint,
             jsonb_build_object('observation', jsonb_build_object(
               'rubricRef', 'spec-quality', 'sourceHive', ${SOURCE_HIVE}::text,
               'subject', jsonb_build_object('kind', 'plan', 'ref',
                 'spec-set:activation:' || lpad(g::text, 64, '0') || ':' || lpad(((g - 1) % 100)::text, 16, '0')),
               'ratings', jsonb_build_object('plan-shape', jsonb_build_object('rating', 'pass', 'evidence', 'seeded spec series'))))
        FROM generate_series(1, 1600) AS g`;
    await db.adminSql`ANALYZE harness_shared.work_items`;
  });

  afterAll(async () => {
    await db.adminSql`DELETE FROM harness_shared.work_items
      WHERE workspace_id = ${issuesScopeWorkspace()}
        AND (feature_id LIKE 'EI-psp-plain-%' OR feature_id LIKE 'EI-psp-spec-%')`;
    await db.adminSql`ANALYZE harness_shared.work_items`;
  });

  it.each([undefined, RUBRIC, SMALL_RUBRIC])('uses an indexed primary scan for rubric %s', async (rubricRef) => {
    const { statement } = await captureListScorecards(rubricRef, rubricRef ? 25 : 501, rubricRef ? SOURCE_HIVE : null);
    const nodes = await explain(db.adminSql, statement);
    const primary = nodes.filter((node) => node['Relation Name'] === 'work_items' && node.Alias === 'work_items');
    expect(primary, `missing primary scan: ${describePlan(nodes)}`).toHaveLength(1);
    expect(primary[0]!['Node Type'], `primary scan: ${describePlan(nodes)}`).not.toBe('Seq Scan');
    expect(
      nodes.filter((node) => node['Relation Name'] === 'work_items' && node['Node Type'] === 'Seq Scan'),
      `the superseder probe must not repeatedly scan the issue population: ${describePlan(nodes)}`,
    ).toHaveLength(0);
    if (!rubricRef) {
      expect(primary[0]!['Index Name'], `default list: ${describePlan(nodes)}`).toBe(PRIMARY_INDEX);
      expect(usesIndex(nodes, SPEC_SERIES_INDEX), `spec-quality probe: ${describePlan(nodes)}`).toBe(true);
      expect(rubricWideBitmapAnds(nodes), `full-query rubric-wide BitmapAnd: ${describePlan(nodes)}`).toHaveLength(0);
      console.info('full production scorecard statement', JSON.stringify(statement));
    }
  });

  it('the default production query reaches the ordered partial index, and cannot after it is dropped', async () => {
    const { statement } = await captureListScorecards(undefined, 501, null);
    const withIndex = await explain(db.adminSql, statement);
    const withoutIndex = await explainUnder(statement, [], PRIMARY_INDEX);
    expect(usesIndex(withIndex, PRIMARY_INDEX), describePlan(withIndex)).toBe(true);
    expect(usesIndex(withoutIndex, PRIMARY_INDEX), describePlan(withoutIndex)).toBe(false);
    const [idx] = await db.adminSql`SELECT to_regclass(${'harness_shared.' + PRIMARY_INDEX}) AS r`;
    expect(idx!.r).not.toBeNull();
  });

  it('the full spec-quality probe reaches its series index, and cannot after it is dropped', async () => {
    const { rows, statement } = await captureListScorecards('spec-quality', 500);
    expect(rows).toHaveLength(100);
    const withIndex = await explain(db.adminSql, statement);
    const withoutIndex = await explainUnder(statement, [], SPEC_SERIES_INDEX);
    expect(usesIndex(withIndex, SPEC_SERIES_INDEX), describePlan(withIndex)).toBe(true);
    expect(usesIndex(withoutIndex, SPEC_SERIES_INDEX), describePlan(withoutIndex)).toBe(false);
    const [idx] = await db.adminSql`SELECT to_regclass(${'harness_shared.' + SPEC_SERIES_INDEX}) AS r`;
    expect(idx!.r).not.toBeNull();
  });
});
