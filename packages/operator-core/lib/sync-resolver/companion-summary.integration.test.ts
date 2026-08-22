// @vitest-environment node
/**
 * Real-Postgres proof for the shared bounded-list companion-summary contract.
 *
 * Run:
 *   cd packages/operator-core && npx vitest run --config vitest.integration.config.ts lib/sync-resolver/companion-summary.integration.test.ts
 *
 * The production helper is intentionally SQL-agnostic; every domain owns its
 * columns and indexes. This fixture supplies a representative mutable corpus
 * (text search, JSONB, multi-select facets, and keyset ordering) and proves the
 * reusable seam can satisfy the contract with one aggregate round trip.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { randomBytes } from 'node:crypto';
import { getTestPg } from '@papercusp/test-config/pg';
import type {
  CompanionListSummary,
  CompanionSummaryAggregateRow,
  FacetSelection,
} from '@papercusp/facets';
import {
  createCompanionListQueryPair,
  LIST_READ_BUDGET_MS,
  type BoundedListPage,
} from './bounded-list-read';
import { PAYLOAD_BUDGET_BYTES } from './sync-read-audit';
import { readListHasMore, readListMeta } from './list-meta';

interface WireArgs {
  workspace: string;
  q?: string;
  states?: string[];
  kinds?: string[];
  roles?: string[];
  cursor?: string | null;
  limit?: number;
}

interface NormalizedArgs {
  workspace: string;
  q: string | null;
  states: string[];
  kinds: string[];
  roles: string[];
  cursor: Cursor | null;
  limit: number;
}

interface Cursor {
  updatedAt: number;
  id: number;
}

interface ItemRow {
  id: number;
  state: string;
  kind: string;
  title: string;
  body: string;
  role: string;
  updatedAt: number;
}

interface CompiledPredicate {
  args: NormalizedArgs;
  fingerprint: string;
}

const schema = `p2_companion_${randomBytes(5).toString('hex')}`;
const table = `${schema}.items`;
let sql: Sql;
let summarySqlCalls = 0;
let rowsSqlCalls = 0;

const uniq = (values: readonly string[] | undefined): string[] =>
  [...new Set(values ?? [])].filter(Boolean).sort();

function decodeCursor(raw: string | null | undefined): Cursor | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<Cursor>;
    return Number.isSafeInteger(parsed.updatedAt) && Number.isSafeInteger(parsed.id)
      ? { updatedAt: parsed.updatedAt!, id: parsed.id! }
      : null;
  } catch {
    return null;
  }
}

function normalizeArgs(args: WireArgs): NormalizedArgs {
  return {
    workspace: args.workspace,
    q: args.q?.trim() ? args.q.trim() : null,
    states: uniq(args.states),
    kinds: uniq(args.kinds),
    roles: uniq(args.roles),
    cursor: decodeCursor(args.cursor),
    limit: Math.min(Math.max(args.limit ?? 100, 1), 100),
  };
}

const encodeCursor = (row: Pick<ItemRow, 'updatedAt' | 'id'>): string =>
  JSON.stringify({ updatedAt: row.updatedAt, id: row.id });

function selectionOf(args: NormalizedArgs): FacetSelection {
  const entries: Array<[string, ReadonlySet<string>]> = [];
  if (args.states.length) entries.push(['state', new Set(args.states)]);
  if (args.kinds.length) entries.push(['kind', new Set(args.kinds)]);
  if (args.roles.length) entries.push(['role', new Set(args.roles)]);
  return new Map(entries);
}

async function readPage(
  predicate: CompiledPredicate,
): Promise<BoundedListPage<ItemRow>> {
  rowsSqlCalls += 1;
  const a = predicate.args;
  const rows = await sql<ItemRow[]>`
    SELECT id,
           state,
           kind,
           title,
           body,
           attrs->>'role' AS role,
           updated_at::int AS "updatedAt"
      FROM ${sql(table)}
     WHERE workspace = ${a.workspace}
       AND (${a.q}::text IS NULL OR search_document @@ plainto_tsquery('simple', ${a.q ?? ''}))
       AND (${a.states.length}::int = 0 OR state = ANY(${a.states}::text[]))
       AND (${a.kinds.length}::int = 0 OR kind = ANY(${a.kinds}::text[]))
       AND (${a.roles.length}::int = 0 OR attrs->>'role' = ANY(${a.roles}::text[]))
       AND (
         ${a.cursor?.updatedAt ?? null}::bigint IS NULL
         OR (updated_at, id) < (${a.cursor?.updatedAt ?? null}::bigint, ${a.cursor?.id ?? null}::int)
       )
     ORDER BY updated_at DESC, id DESC
     LIMIT ${a.limit + 1}`;
  const hasMore = rows.length > a.limit;
  const pageRows = hasMore ? rows.slice(0, a.limit) : rows;
  return {
    rows: pageRows,
    previousCursor: a.cursor ? JSON.stringify(a.cursor) : null,
    nextCursor: hasMore && pageRows.length > 0 ? encodeCursor(pageRows[pageRows.length - 1]) : null,
    hasMore,
  };
}

interface AggregateDbRow {
  kind: 'totals' | 'facet';
  facet: string | null;
  label: string | null;
  value: string | null;
  count: number | null;
  total: number | null;
  matched: number | null;
}

async function readSummaryRows(
  predicate: CompiledPredicate,
): Promise<readonly CompanionSummaryAggregateRow[]> {
  summarySqlCalls += 1;
  const a = predicate.args;
  // One statement, one driver call. Each facet CTE drops only its own
  // dimension and retains q + every other active dimension.
  const rows = await sql<AggregateDbRow[]>`
    WITH scoped AS MATERIALIZED (
      SELECT state, kind, attrs, search_document
        FROM ${sql(table)}
       WHERE workspace = ${a.workspace}
    ),
    totals AS (
      SELECT count(*)::int AS n FROM scoped
    ),
    matched AS (
      SELECT count(*)::int AS n
        FROM scoped
       WHERE (${a.q}::text IS NULL OR search_document @@ plainto_tsquery('simple', ${a.q ?? ''}))
         AND (${a.states.length}::int = 0 OR state = ANY(${a.states}::text[]))
         AND (${a.kinds.length}::int = 0 OR kind = ANY(${a.kinds}::text[]))
         AND (${a.roles.length}::int = 0 OR attrs->>'role' = ANY(${a.roles}::text[]))
    ),
    state_facets AS (
      SELECT state AS value, count(*)::int AS n
        FROM scoped
       WHERE (${a.q}::text IS NULL OR search_document @@ plainto_tsquery('simple', ${a.q ?? ''}))
         AND (${a.kinds.length}::int = 0 OR kind = ANY(${a.kinds}::text[]))
         AND (${a.roles.length}::int = 0 OR attrs->>'role' = ANY(${a.roles}::text[]))
       GROUP BY state
    ),
    kind_facets AS (
      SELECT kind AS value, count(*)::int AS n
        FROM scoped
       WHERE (${a.q}::text IS NULL OR search_document @@ plainto_tsquery('simple', ${a.q ?? ''}))
         AND (${a.states.length}::int = 0 OR state = ANY(${a.states}::text[]))
         AND (${a.roles.length}::int = 0 OR attrs->>'role' = ANY(${a.roles}::text[]))
       GROUP BY kind
    ),
    role_facets AS (
      SELECT attrs->>'role' AS value, count(*)::int AS n
        FROM scoped
       WHERE (${a.q}::text IS NULL OR search_document @@ plainto_tsquery('simple', ${a.q ?? ''}))
         AND (${a.states.length}::int = 0 OR state = ANY(${a.states}::text[]))
         AND (${a.kinds.length}::int = 0 OR kind = ANY(${a.kinds}::text[]))
         AND attrs->>'role' IS NOT NULL
       GROUP BY attrs->>'role'
    )
    SELECT 'totals'::text AS kind,
           NULL::text AS facet,
           NULL::text AS label,
           NULL::text AS value,
           NULL::int AS count,
           totals.n AS total,
           matched.n AS matched
      FROM totals CROSS JOIN matched
    UNION ALL
    SELECT 'facet', 'state', 'State', value, n, NULL, NULL FROM state_facets
    UNION ALL
    SELECT 'facet', 'kind', 'Kind', value, n, NULL, NULL FROM kind_facets
    UNION ALL
    SELECT 'facet', 'role', 'Role', value, n, NULL, NULL FROM role_facets`;

  return rows.map((row): CompanionSummaryAggregateRow => {
    if (row.kind === 'totals') {
      return { kind: 'totals', total: row.total ?? 0, matched: row.matched ?? 0 };
    }
    return {
      kind: 'facet',
      facet: row.facet ?? '',
      label: row.label ?? undefined,
      value: row.value ?? '',
      count: row.count ?? 0,
    };
  });
}

const pair = createCompanionListQueryPair({
  domain: 'fixtureItems',
  rowsQueryName: 'fixtureItems.byWorkspace',
  argsSchema: { parse: (input: unknown) => input as WireArgs },
  backingTables: [table],
  normalizeArgs,
  buildPredicate: (args): CompiledPredicate => ({ args, fingerprint: JSON.stringify(args) }),
  readPage: ({ predicate }) => readPage(predicate),
  readSummaryAggregateRows: ({ predicate }) => readSummaryRows(predicate),
  summarySelection: selectionOf,
});

const summaryFor = async (args: WireArgs): Promise<CompanionListSummary> =>
  (await pair.summaryEntry.resolve(args))[0] as CompanionListSummary;

const rowsFor = async (args: WireArgs): Promise<ItemRow[]> =>
  (await pair.rowsEntry.resolve(args)) as ItemRow[];

beforeAll(async () => {
  const uri = await getTestPg();
  sql = postgres(uri, { max: 2, prepare: false, onnotice: () => {} });
  await sql.unsafe(`CREATE SCHEMA "${schema}"`);
  await sql.unsafe(`
    CREATE TABLE "${schema}".items (
      id serial PRIMARY KEY,
      workspace text NOT NULL,
      state text NOT NULL,
      kind text NOT NULL,
      title text NOT NULL,
      body text NOT NULL,
      attrs jsonb NOT NULL,
      updated_at bigint NOT NULL,
      search_document tsvector GENERATED ALWAYS AS (
        to_tsvector('simple', coalesce(title, '') || ' ' || coalesce(body, ''))
      ) STORED
    )`);
  await sql.unsafe(`CREATE INDEX p2_items_keyset_idx ON "${schema}".items (workspace, updated_at DESC, id DESC)`);
  await sql.unsafe(`CREATE INDEX p2_items_search_idx ON "${schema}".items USING gin (search_document)`);
  await sql.unsafe(`CREATE INDEX p2_items_attrs_idx ON "${schema}".items USING gin (attrs jsonb_path_ops)`);
  await sql.unsafe(`
    INSERT INTO "${schema}".items (workspace, state, kind, title, body, attrs, updated_at)
    SELECT
      'ws-1',
      (ARRAY['open', 'blocked', 'done'])[1 + (g % 3)],
      (ARRAY['bug', 'change'])[1 + (g % 2)],
      CASE WHEN g = 1205 THEN 'deep-only-match' ELSE 'ordinary item ' || g END,
      'body ' || g,
      jsonb_build_object('role', (ARRAY['builder', 'reviewer'])[1 + (g % 2)]),
      2000000 - g
    FROM generate_series(1, 1205) AS g`);
}, 60_000);

afterAll(async () => {
  if (!sql) return;
  await sql.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await sql.end({ timeout: 5 });
});

describe('companion summary contract — real Postgres', () => {
  it('uses one aggregate round trip with AND-across / OR-within drill-down parity and stays inside sync budgets', async () => {
    const args: WireArgs = {
      workspace: 'ws-1',
      states: ['open', 'blocked'],
      kinds: ['bug'],
      roles: ['reviewer'],
      limit: 37,
    };
    const beforeCalls = summarySqlCalls;
    const started = performance.now();
    const summary = await summaryFor(args);
    const elapsedMs = performance.now() - started;

    expect(summarySqlCalls - beforeCalls).toBe(1);
    expect(elapsedMs).toBeLessThan(LIST_READ_BUDGET_MS);
    expect(Buffer.byteLength(JSON.stringify([summary]), 'utf8')).toBeLessThan(PAYLOAD_BUDGET_BYTES);
    expect(summary.total).toBe(1205);

    const [expectedMatched] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM ${sql(table)}
       WHERE workspace = 'ws-1'
         AND state = ANY(${['open', 'blocked']}::text[])
         AND kind = 'bug'
         AND attrs->>'role' = 'reviewer'`;
    expect(summary.matched).toBe(expectedMatched.n);

    const stateFacet = summary.facets.find((facet) => facet.key === 'state')!;
    const [allStatesForOtherFilters] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM ${sql(table)}
       WHERE workspace = 'ws-1'
         AND kind = 'bug'
         AND attrs->>'role' = 'reviewer'`;
    expect(stateFacet.values.reduce((sum, value) => sum + value.count, 0)).toBe(
      allStatesForOtherFilters.n,
    );

    const kindFacet = summary.facets.find((facet) => facet.key === 'kind')!;
    const [allKindsForOtherFilters] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM ${sql(table)}
       WHERE workspace = 'ws-1'
         AND state = ANY(${['open', 'blocked']}::text[])
         AND attrs->>'role' = 'reviewer'`;
    expect(kindFacet.values.reduce((sum, value) => sum + value.count, 0)).toBe(
      allKindsForOtherFilters.n,
    );
  });

  it('preserves zero-match truth and the reset path as one response row', async () => {
    const response = await pair.summaryEntry.resolve({ workspace: 'ws-1', q: 'does-not-exist' });
    expect(response).toHaveLength(1);
    expect(response[0]).toEqual({ total: 1205, matched: 0, facets: [] });
  });

  it('finds a match beyond page one because filtering happens before the cap', async () => {
    const rows = await rowsFor({ workspace: 'ws-1', q: 'deep-only-match', limit: 25 });
    const summary = await summaryFor({ workspace: 'ws-1', q: 'deep-only-match', limit: 25 });
    expect(rows.map((row) => row.title)).toEqual(['deep-only-match']);
    expect(summary).toMatchObject({ total: 1205, matched: 1 });
    expect(readListHasMore(rows)).toBe(false);
  });

  it('preserves keyset cursor/cap metadata and terminates after row growth stops', async () => {
    const beforeCalls = rowsSqlCalls;
    const first = await rowsFor({ workspace: 'ws-1', limit: 50 });
    expect(first).toHaveLength(50);
    expect(readListHasMore(first)).toBe(true);
    const cursor = readListMeta(first)?.nextCursor as string;
    const second = await rowsFor({ workspace: 'ws-1', limit: 50, cursor });
    expect(second).toHaveLength(50);
    const firstIds = new Set(first.map((row) => row.id));
    expect(second.some((row) => firstIds.has(row.id))).toBe(false);
    expect(rowsSqlCalls - beforeCalls).toBe(2);

    const [oldest] = await sql<{ id: number; updatedAt: number }[]>`
      SELECT id, updated_at::int AS "updatedAt"
        FROM ${sql(table)}
       WHERE workspace = 'ws-1'
       ORDER BY updated_at ASC, id ASC
       LIMIT 1`;
    const exhausted = await rowsFor({ workspace: 'ws-1', limit: 50, cursor: encodeCursor(oldest) });
    expect(exhausted).toEqual([]);
    expect(readListHasMore(exhausted)).toBe(false);
  });

  it('allows only transient row/summary disagreement and converges after one paired invalidation cycle', async () => {
    await sql`
      INSERT INTO ${sql(table)} (workspace, state, kind, title, body, attrs, updated_at)
      VALUES ('ws-1', 'open', 'bug', 'converge-probe', 'first', ${JSON.stringify({ role: 'builder' })}::jsonb, 3000001)`;
    const args = { workspace: 'ws-1', q: 'converge-probe', limit: 10 };
    const beforeWriteRows = await rowsFor(args);
    expect(beforeWriteRows).toHaveLength(1);

    // A live write lands between the independent named queries: adjacent
    // snapshots may disagree until the paired invalidation refetches both.
    await sql`
      INSERT INTO ${sql(table)} (workspace, state, kind, title, body, attrs, updated_at)
      VALUES ('ws-1', 'blocked', 'change', 'converge-probe', 'second', ${JSON.stringify({ role: 'reviewer' })}::jsonb, 3000002)`;
    const racedSummary = await summaryFor(args);
    expect(racedSummary.matched).toBe(2);
    expect(beforeWriteRows.length).not.toBe(racedSummary.matched);

    const refreshed = new Map<string, unknown[]>();
    for (const name of pair.invalidationQueryNames) {
      refreshed.set(
        name,
        name === pair.rowsQueryName
          ? await pair.rowsEntry.resolve(args)
          : await pair.summaryEntry.resolve(args),
      );
    }
    const convergedRows = refreshed.get(pair.rowsQueryName) as ItemRow[];
    const convergedSummary = (refreshed.get(pair.summaryQueryName) as CompanionListSummary[])[0];
    expect(convergedRows).toHaveLength(2);
    expect(convergedSummary.matched).toBe(convergedRows.length);
  });

  it('keeps search and JSONB predicates backed by real indexes', async () => {
    await sql.unsafe('SET enable_seqscan = off');
    try {
      const searchPlan = await sql.unsafe<Array<Record<string, string>>>(`
        EXPLAIN SELECT id FROM "${schema}".items
         WHERE search_document @@ plainto_tsquery('simple', 'deep-only-match')`);
      const jsonbPlan = await sql.unsafe<Array<Record<string, string>>>(`
        EXPLAIN SELECT id FROM "${schema}".items
         WHERE attrs @> '{"role":"reviewer"}'::jsonb`);
      expect(searchPlan.map((row) => row['QUERY PLAN']).join('\n')).toContain('p2_items_search_idx');
      expect(jsonbPlan.map((row) => row['QUERY PLAN']).join('\n')).toContain('p2_items_attrs_idx');
    } finally {
      await sql.unsafe('RESET enable_seqscan');
    }
  });
});
