/**
 * rank.ts — the one lexical-ranking seam (plan bm25-lexical-search-evoke-adoption-2026-10-10
 * P-005, decision D-003 §4).
 *
 * A call site that ranks rows of a registered corpus by a free-text query asks this module
 * for its lexical leg and splices the returned fragments into its own SELECT:
 *
 *   const leg = await lexicalLeg(sql, {
 *     table: 'code_recipes', query,
 *     legacy: { score: sql`ts_rank_cd(title_tsv, ${tq})`, match: sql`title_tsv @@ ${tq}` },
 *   });
 *   sql`SELECT id, ${leg.score} AS rank FROM harness_shared.code_recipes
 *        WHERE status = 'active' AND ${leg.match} ORDER BY ${leg.order}, id LIMIT ${limit}`
 *
 * ENGINE CHOICE, per call: BM25 (pg_textsearch) when the BM25_LEXICAL_RANKING flag is on
 * AND the corpus's BM25 index is present and valid in this database with the library
 * loaded; otherwise the caller's legacy ts_rank fragments, unchanged. The fallback is never
 * silent: `bm25Health` (the P-004 health check) reports `degraded` whenever the flag is on
 * and an expected index, the extension or the library is missing.
 *
 * BM25 SHAPE (measured on pg_textsearch 1.5.1, see migration 1447):
 *  - `<expr> <@> to_bm25query(q, '<schema>.<index>')` is a NEGATIVE distance, so
 *    score = -distance and ORDER BY the distance ascending, written as the bare operator
 *    expression so the planner can drive the scan from the BM25 index.
 *  - the index name must be schema-qualified: an unqualified name fails "index does not
 *    exist" whenever the plan is not that index scan.
 *  - a filtered index scan also returns NON-matching rows at distance 0, so `match`
 *    keeps `distance < 0`.
 *  - the query text is tokenized by the index's text config; operators such as `&` or `(`
 *    are ignored, so any user string is safe to pass.
 */
import type { PendingQuery, Row, Sql } from 'postgres';
import { getFlag } from '@papercusp/flags/server';
import { FLAGS } from '@papercusp/flags';
import { pinModuleState } from '@papercusp/module-singleton';
import { RRF_K_DEFAULT, rrfCombine } from '@papercusp/rrf';
import { BM25_CORPORA, bm25Corpus, renderBm25TextExpr, type Bm25Corpus, type Bm25CorpusTable } from './corpora';

/** A postgres.js SQL fragment, spliced with `${fragment}` into a tagged template. */
export type SqlFragment = PendingQuery<Row[]>;

export type LexicalEngine = 'bm25' | 'legacy';

export interface LexicalLeg {
  engine: LexicalEngine;
  /** Relevance, higher is better. Not comparable across engines. */
  score: SqlFragment;
  /** WHERE predicate: the row matches the query. */
  match: SqlFragment;
  /** ORDER BY body, best first (append the caller's tie-breakers after it). */
  order: SqlFragment;
}

/** The caller's existing ts_rank ranking, used verbatim when BM25 is unavailable. */
export interface LegacyLexicalRank {
  score: SqlFragment;
  match: SqlFragment;
}

export interface LexicalLegRequest {
  table: Bm25CorpusTable;
  query: string;
  /** Table alias in the caller's FROM clause, when it has one. */
  alias?: string;
  legacy: LegacyLexicalRank;
  /**
   * `'websearch'` when the caller's legacy match parses the query with
   * `websearch_to_tsquery` and documents its syntax (quoted phrases, OR, -negation).
   * BM25 tokenizes the query and ignores that syntax, so it would turn `-draft` into a
   * positive match. When the query uses any of those operators, the BM25 leg therefore
   * keeps the legacy predicate as its match filter and BM25 only orders the rows.
   * A plain query gets BM25's own any-term match. Plan D-007.
   */
  querySyntax?: 'websearch';
}

/**
 * Whether `query` uses `websearch_to_tsquery` operator syntax: a double quote (phrase), the
 * word `or` between terms, or a `-` that starts a term (negation).
 */
export function usesWebsearchOperators(query: string): boolean {
  return /"/.test(query) || /(^|\s)-\S/.test(query) || /\S\s+or\s+\S/i.test(query);
}

const SCHEMA = 'harness_shared';
const AVAILABILITY_TTL_MS = 60_000;

interface AvailabilityEntry {
  indexes: ReadonlySet<string>;
  checkedAt: number;
}

const state = pinModuleState('@papercusp/operator-core.lexical-bm25-availability', () => ({
  bySql: new WeakMap<object, AvailabilityEntry>(),
}));

/**
 * Valid, ready BM25 indexes in harness_shared, by name. Empty when the pg_textsearch
 * library is not loaded in this server (an index left behind after the preload was
 * removed cannot be scanned). Never throws: a failed catalog read is "nothing available".
 */
export async function readBm25Indexes(sql: Sql): Promise<ReadonlySet<string>> {
  try {
    const rows = await sql<{ name: string }[]>`
      SELECT c.relname AS name
        FROM pg_index i
        JOIN pg_class c ON c.oid = i.indexrelid
        JOIN pg_am a ON a.oid = c.relam
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE a.amname = 'bm25'
         AND n.nspname = ${SCHEMA}
         AND i.indisvalid AND i.indisready
         AND current_setting('pg_textsearch.library_version', true) IS NOT NULL`;
    return new Set(rows.map(r => r.name));
  } catch {
    return new Set();
  }
}

/** `readBm25Indexes`, remembered per connection pool for a minute. */
export async function bm25IndexesFor(sql: Sql): Promise<ReadonlySet<string>> {
  const now = Date.now();
  const hit = state.bySql.get(sql);
  if (hit && now - hit.checkedAt < AVAILABILITY_TTL_MS) return hit.indexes;
  const indexes = await readBm25Indexes(sql);
  state.bySql.set(sql, { indexes, checkedAt: now });
  return indexes;
}

/** Forget remembered availability (after creating or dropping an index, and in tests). */
export function resetBm25Availability(sql?: Sql): void {
  if (sql) state.bySql.delete(sql);
  else state.bySql = new WeakMap();
}

export async function bm25FlagOn(): Promise<boolean> {
  return getFlag(FLAGS.BM25_LEXICAL_RANKING, 'system').catch(() => true);
}

/** Which engine ranks `table` right now. */
export async function lexicalEngine(sql: Sql, table: Bm25CorpusTable): Promise<LexicalEngine> {
  if (!(await bm25FlagOn())) return 'legacy';
  return (await bm25IndexesFor(sql)).has(bm25Corpus(table).indexName) ? 'bm25' : 'legacy';
}

/** The BM25 fragments for one corpus; exported for tests and the bench. */
export function bm25Leg(sql: Sql, corpus: Bm25Corpus, query: string, alias?: string): LexicalLeg {
  const expr = sql.unsafe(renderBm25TextExpr(corpus, alias));
  const index = sql.unsafe(`'${SCHEMA}.${corpus.indexName}'`);
  const distance = () => sql`(${expr}) <@> to_bm25query(${query}::text, ${index})`;
  return {
    engine: 'bm25',
    score: sql`(-(${distance()}))::float8`,
    match: sql`(${distance()}) < 0`,
    order: distance(),
  };
}

/**
 * The BM25 leg when BM25 ranks `table` right now, else `null`. For call sites whose
 * legacy query is too structured to pass as two fragments (sources.ts `lexicalSql`):
 * they keep their own legacy branch and switch to these fragments when non-null.
 */
export async function bm25LegIfAvailable(
  sql: Sql,
  table: Bm25CorpusTable,
  query: string,
  alias?: string,
): Promise<LexicalLeg | null> {
  return (await lexicalEngine(sql, table)) === 'bm25' ? bm25Leg(sql, bm25Corpus(table), query, alias) : null;
}

/**
 * The tsquery for `ts_headline` over a leg's rows. BM25 returns rows that match only SOME
 * query terms, and ts_headline's fragment mode highlights nothing in a row that does not
 * satisfy its tsquery, so under BM25 the headline uses an OR of the query's terms. The
 * legacy engine keeps the AND query its rows were matched with.
 */
export function headlineTsQuery(sql: Sql, engine: LexicalEngine, query: string): SqlFragment {
  const orTerms = query.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length >= 2).join(' | ');
  return engine === 'bm25' && orTerms
    ? sql`to_tsquery('english', ${orTerms})`
    : sql`plainto_tsquery('english', ${query})`;
}

/** The lexical leg for one query over one corpus. */
export async function lexicalLeg(sql: Sql, req: LexicalLegRequest): Promise<LexicalLeg> {
  if ((await lexicalEngine(sql, req.table)) === 'bm25') {
    const leg = bm25Leg(sql, bm25Corpus(req.table), req.query, req.alias);
    if (req.querySyntax === 'websearch' && usesWebsearchOperators(req.query)) {
      return { ...leg, match: sql`(${leg.match}) AND (${req.legacy.match})` };
    }
    return leg;
  }
  return {
    engine: 'legacy',
    score: req.legacy.score,
    match: req.legacy.match,
    order: sql`${req.legacy.score} DESC`,
  };
}

/**
 * One leg's reciprocal-rank-fusion term, as a SELECT-list expression: `1 / (k + rank)` for
 * rows the leg matches, ranked by `score` among them (best first), else 0. Summing a lexical
 * term and a vector term fuses the legs by POSITION ONLY, so the fused order cannot depend on
 * a leg's score scale: BM25's unbounded score and ts_rank's [0,1) fuse identically. Use it
 * wherever a call site would otherwise add a lexical score and a cosine with weights
 * (plan bm25-lexical-search-evoke-adoption-2026-10-10 D-004). The window covers every row
 * the query returns before LIMIT, so the WHERE clause must admit both legs' candidates.
 */
export function rrfTerm(sql: Sql, matched: SqlFragment, score: SqlFragment): SqlFragment {
  const k = sql.unsafe(String(RRF_K_DEFAULT));
  return sql`(CASE WHEN ${matched}
                THEN 1.0 / (${k} + rank() OVER (ORDER BY (CASE WHEN ${matched} THEN ${score} END) DESC NULLS LAST))
                ELSE 0 END)`;
}

/** One best-first result list from one corpus, for `fuseByPosition`. */
export interface PositionedList<T> {
  name: string;
  rows: readonly T[];
  /** Identity of a row within the fused result. */
  key: (row: T) => string;
}

export interface PositionFusedRow<T> {
  row: T;
  /** Reciprocal-rank-fusion score: the merged order, comparable across lists. */
  score: number;
  /** Name of the list the row came from. */
  list: string;
  /** 1-based position of the row in that list. */
  position: number;
}

/**
 * Merge best-first result lists from DIFFERENT corpora into one ranking by position
 * (reciprocal rank fusion), never by raw score. A lexical score is not comparable across
 * corpora (each BM25 index has its own IDF statistics) or across engines (BM25 is unbounded,
 * ts_rank sits in [0,1)), so sorting the union by score lets whichever list happens to use
 * the larger scale take every slot. Equal positions keep the lists' input order. Keys are
 * scoped by list, so rows of different corpora that share an id stay distinct.
 * Plan bm25-lexical-search-evoke-adoption-2026-10-10 D-006.
 */
export function fuseByPosition<T>(lists: ReadonlyArray<PositionedList<T>>): Array<PositionFusedRow<T>> {
  const inputs = lists.map(({ name, rows, key }) => ({
    name,
    list: rows.map((row, idx) => ({
      key: `${name}\u0000${key(row)}`,
      score: 0,
      row: { row, list: name, position: idx + 1 },
    })),
  }));
  return rrfCombine(inputs).map(fused => ({ ...fused.row, score: fused.score }));
}

/**
 * The largest AND-match set for which a source runs its EXACT list beside the BM25
 * list (plan bm25-lexical-search-evoke-adoption-2026-10-10, R-13, D-016).
 *
 * Why an exact list exists at all: BM25 (pg_textsearch 1.5.1: `to_bm25query` only, no
 * AND, phrase or proximity operator) ranks a verbatim fragment of a long document far
 * down when the fragment's terms are individually common. Measured 2026-10-11 on
 * work_items for the five R-13 fragment losses: BM25 lexical rank 11, 60, 286, 402 and
 * >500, where `plainto_tsquery` AND + `ts_rank_cd` (cover density rewards adjacent
 * terms) ranks the same targets 1, 1, 2, 2, 1. A BM25 top-K rerank cannot repair it
 * affordably: a top-1000 index scan alone costs 124-232 ms against R-2's 50 ms p95.
 *
 * Why a cap: ranking the AND set reads every match's tsvector, so the cap bounds the
 * cost; below it, the exact list is legacy's ranking exactly. Measured 2026-10-11: the
 * five work-item losses had AND sets of 8, 9, 35, 609 and 1,656 rows (5-66 ms warm);
 * the one session-turn loss left at a 2,000 cap had 3,925 (gate probe 21-25 ms, list
 * 73-80 ms warm), so the cap is 5,000. The gate probe costs about the same at 2,000
 * and 5,000; a non-selective query ('the gate is red': over 10,000) is skipped, and
 * BM25 + cosine carry it.
 */
export const EXACT_LIST_MAX_AND_ROWS = 5000;

/**
 * Merge a source's EXACT list (legacy AND + `ts_rank_cd`) with its BM25 list for the
 * SAME corpus by reciprocal-rank fusion, keyed by row identity so a row both lists
 * found is counted once with both contributions. Ties keep the exact list's order
 * (it is passed first), and each returned row's `rank` is its fused score, so the
 * caller's best-first order and its scores agree. Returns at most `limit` rows.
 */
export function mergeExactAndBm25<T extends { rank: number }>(
  exact: readonly T[],
  bm25: readonly T[],
  key: (row: T) => string,
  limit: number,
): T[] {
  const fused = rrfCombine([
    { name: 'exact', list: exact.map(row => ({ key: key(row), score: row.rank, row })) },
    { name: 'bm25', list: bm25.map(row => ({ key: key(row), score: row.rank, row })) },
  ]);
  return fused.slice(0, Math.max(0, limit)).map(f => ({ ...f.row, rank: f.score }));
}

export type Bm25HealthStatus = 'ok' | 'degraded' | 'off';

/** R-2's p95 budget for a lexical query on the work-item corpus. */
export const BM25_P95_BUDGET_MS = 50;

/**
 * Canary queries for the latency measurement: ordinary words with long posting lists, so
 * the probe sees a realistic slow case rather than a rare-term fast one. Fixed, so two
 * measurements are comparable.
 */
export const BM25_LATENCY_CANARY_QUERIES = [
  'search ranking', 'test failure', 'plan item', 'agent session',
  'migration index', 'release gate', 'memory recall', 'work item',
] as const;

export interface Bm25Latency {
  corpusIndex: string;
  samplesMs: number[];
  p50Ms: number;
  p95Ms: number;
  budgetMs: number;
  measuredAt: number;
}

/** Nearest-rank percentile; `samples` need not be sorted. */
export function percentileMs(samples: readonly number[], p: number): number {
  if (!samples.length) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1]!;
}

/**
 * Time the canary queries through the seam's own BM25 fragments (top-10, as callers run
 * them). `null` when the corpus has no usable BM25 index here, so there is nothing to time.
 */
export async function measureBm25Latency(
  sql: Sql,
  table: Bm25CorpusTable = 'work_items',
  queries: readonly string[] = BM25_LATENCY_CANARY_QUERIES,
): Promise<Bm25Latency | null> {
  const corpus = bm25Corpus(table);
  if (!(await readBm25Indexes(sql)).has(corpus.indexName)) return null;
  const from = sql.unsafe(`${SCHEMA}.${corpus.table}`);
  const run = (query: string) => {
    const leg = bm25Leg(sql, corpus, query);
    return sql`SELECT ${leg.score} AS score FROM ${from} WHERE ${leg.match} ORDER BY ${leg.order} LIMIT 10`;
  };
  // One untimed query first: with eight samples p95 is the slowest one, and a cold first
  // query (planning, index metapage reads) would otherwise be judged as steady-state latency.
  if (queries[0] !== undefined) await run(queries[0]);
  const samplesMs: number[] = [];
  for (const query of queries) {
    const started = performance.now();
    await run(query);
    samplesMs.push(performance.now() - started);
  }
  return {
    corpusIndex: corpus.indexName,
    samplesMs,
    p50Ms: percentileMs(samplesMs, 50),
    p95Ms: percentileMs(samplesMs, 95),
    budgetMs: BM25_P95_BUDGET_MS,
    measuredAt: Date.now(),
  };
}

export interface Bm25Health {
  status: Bm25HealthStatus;
  flagOn: boolean;
  libraryLoaded: boolean;
  extensionInstalled: boolean;
  /** Registered corpora whose table exists here but whose BM25 index is missing or invalid. */
  missingIndexes: string[];
  presentIndexes: string[];
  /** The latency measurement judged against the budget, when the caller supplied one. */
  latency: Bm25Latency | null;
  /** One line naming what is wrong, for the health surface. */
  reason: string | null;
}

/**
 * The BM25 health verdict (D-003 §4, plan item P-004): `degraded` when the flag is on but
 * lexical search is (partly) falling back to ts_rank — the library is not loaded, the
 * extension is not installed, or a registered corpus whose table exists has no valid BM25
 * index — or when a supplied latency measurement's p95 exceeds its budget (R-2).
 */
export async function bm25Health(sql: Sql, opts: { latency?: Bm25Latency | null } = {}): Promise<Bm25Health> {
  const flagOn = await bm25FlagOn();
  const [probe] = await sql<{ library: boolean; extension: boolean; tables: string[] }[]>`
    SELECT current_setting('pg_textsearch.library_version', true) IS NOT NULL AS library,
           EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_textsearch') AS extension,
           coalesce(array_agg(c.relname) FILTER (WHERE c.relname IS NOT NULL), '{}') AS tables
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = ${SCHEMA} AND c.relkind IN ('r', 'p')
       AND c.relname = ANY (${BM25_CORPORA.map(c => c.table)}::text[])`;
  const tables = new Set(probe?.tables ?? []);
  const present = await readBm25Indexes(sql);
  const expected = BM25_CORPORA.filter(c => tables.has(c.table)).map(c => c.indexName);
  const missingIndexes = expected.filter(name => !present.has(name));
  const presentIndexes = expected.filter(name => present.has(name));
  const libraryLoaded = probe?.library ?? false;
  const extensionInstalled = probe?.extension ?? false;
  let reason: string | null = null;
  if (!libraryLoaded) reason = 'pg_textsearch is not in shared_preload_libraries';
  else if (!extensionInstalled) reason = 'the pg_textsearch extension is not installed (run harness_shared.bm25_ensure_indexes())';
  else if (missingIndexes.length) reason = `BM25 index missing: ${missingIndexes.join(', ')}`;
  const latency = opts.latency ?? null;
  if (!reason && latency && latency.p95Ms > latency.budgetMs) {
    reason = `lexical p95 ${latency.p95Ms.toFixed(1)}ms on ${latency.corpusIndex} exceeds the ${latency.budgetMs}ms budget`;
  }
  const status: Bm25HealthStatus = !flagOn ? 'off' : reason ? 'degraded' : 'ok';
  return { status, flagOn, libraryLoaded, extensionInstalled, missingIndexes, presentIndexes, latency, reason };
}
