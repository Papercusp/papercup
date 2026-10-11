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
import { RRF_K_DEFAULT } from '@papercusp/rrf';
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

/** The lexical leg for one query over one corpus. */
export async function lexicalLeg(sql: Sql, req: LexicalLegRequest): Promise<LexicalLeg> {
  if ((await lexicalEngine(sql, req.table)) === 'bm25') {
    return bm25Leg(sql, bm25Corpus(req.table), req.query, req.alias);
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

export type Bm25HealthStatus = 'ok' | 'degraded' | 'off';

export interface Bm25Health {
  status: Bm25HealthStatus;
  flagOn: boolean;
  libraryLoaded: boolean;
  extensionInstalled: boolean;
  /** Registered corpora whose table exists here but whose BM25 index is missing or invalid. */
  missingIndexes: string[];
  presentIndexes: string[];
  /** One line naming what is wrong, for the health surface. */
  reason: string | null;
}

/**
 * The BM25 health verdict (D-003 §4): `degraded` when the flag is on but lexical search is
 * (partly) falling back to ts_rank — the library is not loaded, the extension is not
 * installed, or a registered corpus whose table exists has no valid BM25 index.
 */
export async function bm25Health(sql: Sql): Promise<Bm25Health> {
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
  const status: Bm25HealthStatus = !flagOn ? 'off' : reason ? 'degraded' : 'ok';
  return { status, flagOn, libraryLoaded, extensionInstalled, missingIndexes, presentIndexes, reason };
}
