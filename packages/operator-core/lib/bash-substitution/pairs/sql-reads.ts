/**
 * Equivalence pairs — the SQL corpus (plan `sql-escape-tool-routing-2026-08-12`,
 * P-009). The first pairs in this registry whose evidence is queries rather than
 * shell commands; the machinery they run on is P-007's.
 *
 * ── WHY THESE TWO FIRST ──────────────────────────────────────────────────────
 * D-005's census of 14 days of agent-written `dev:pg_query` calls ranked the
 * addressable traffic by DISTINCT AGENTS, and the top of that list was not a
 * papercusp table at all — it was `information_schema`:
 *
 *     information_schema.tables    228 calls / 105 agents
 *     information_schema.columns   216 calls /  93 agents
 *
 * More distinct agents than any papercusp relation except `work_items` and
 * `routines`, and both entirely absent from `TOOL_ROUTING_BY_TABLE`. They are
 * also the purest possible statement of this plan's thesis — that the lever is
 * ROUTING, not capability — because the tool that answers them is the SAME TOOL
 * the agent is already calling. `dev:pg_query { describe }` has shipped this
 * capability the whole time; 105 agents hand-wrote the catalog query instead,
 * because nothing ever told them the mode existed.
 *
 * ── WHAT NARROWING IS DOING HERE (D-008, applied to a second corpus) ─────────
 * Neither pair claims every read of its relation, and the exclusions are not
 * gaps — they are the boundary of what `describe` can FAITHFULLY express. A
 * cross-table column search and a `table_name IN (…)` list are real questions
 * that this tool answers only with a superset, and routing them here would be
 * worse than the SQL they replace: the agent would get a plausible answer to a
 * question they did not ask. Those shapes fall OUTSIDE the pattern rather than
 * dragging the verdict down, exactly as `postgres.psql-select` handles a
 * `$VAR`-connection psql.
 */

import { describeRelationFromColumnsQuery, describePatternFromTablesQuery } from './sql-reads-helpers';
import type { CoverageResult, SqlSubstitutionPair } from '../types';

/**
 * P-009a — `SELECT column_name … FROM information_schema.columns WHERE
 * table_schema='X' AND table_name='Y'`: the columns of ONE relation.
 *
 * 216 atoms across 93 agents, and the sample is strikingly uniform: a
 * schema+table equality pair, projecting some subset of column_name / data_type /
 * is_nullable / udt_name. `dev:pg_query { describe: "X.Y" }` returns exactly
 * that, plus the indexes, constraints and column COMMENTs the hand-written query
 * does not reach at all.
 *
 * NARROWED to a single-table equality with no column-level predicate. The two
 * excluded shapes are both real and both genuinely unserved:
 *  - `table_name IN ('a','b')` — describe takes one relation per call;
 *  - `WHERE column_name ILIKE '%checkpoint%'` (with or without a table) — a
 *    column SEARCH across relations, which describe cannot express at all. It is
 *    the one shape here that would be actively harmed by a nudge, since describe
 *    would return every column of one table and the agent asked about one column
 *    across many.
 */
export const informationSchemaColumns: SqlSubstitutionPair = {
  id: 'sql.information-schema-columns',
  intentLabel: 'relation-column-introspection',
  corpus: 'sql',
  relation: 'information_schema.columns',
  // A single-table equality, and NOT a column-name search. The lookahead is what
  // keeps the cross-relation column hunt outside the population; without it the
  // fixture would carry a shape the tool cannot answer and the verdict would be
  // `needs-widening` for a reason that is not about this intent.
  sqlShape: /^(?!.*\bcolumn_name\s*(?:i?like|~|~\*|=\s*any)\b)(?=.*\btable_name\s*=\s*')/is,
  toolName: 'dev:pg_query',
  advisoryText:
    "dev:pg_query { describe: \"schema.table\" } returns that relation's columns with their types, nullability and COMMENTs, plus its indexes and constraints — one call, no information_schema query to write.",
  routing: {
    want: "one relation's columns and their types",
    use: '`dev:pg_query { describe: "schema.table" }` (same tool — also returns indexes, constraints and column comments)',
    insteadOf:
      "a hand-written `SELECT column_name, data_type FROM information_schema.columns WHERE table_schema='…' AND table_name='…'`. ⚠ A column SEARCH across relations (`column_name ILIKE '%x%'`) has no describe form — keep querying the catalog for that",
  },
  expectedVerdict: 'equivalent',
  cover(atom: string): CoverageResult {
    const target = describeRelationFromColumnsQuery(atom);
    if (!target) {
      return { covered: false, reason: 'no single schema-qualified table equality to resolve into a describe target' };
    }
    if (/\btable_name\s+in\s*\(/i.test(atom)) {
      return { covered: false, reason: 'lists several tables; dev:pg_query { describe } takes one relation per call' };
    }
    // `… AND column_name IN ('a','b')` — a named subset of ONE relation's
    // columns, and 5 of the 20 sampled atoms are this. describe returns the
    // relation's FULL column list, which contains the answer: the question is
    // "do these columns exist / what are their types", and a complete structured
    // description of that one relation answers it exactly. Recorded as covered
    // WITH the difference stated in the expression, rather than silently — a
    // superset is only acceptable when the reader can see that it is one.
    if (/\bcolumn_name\s+in\s*\(/i.test(atom)) {
      return { covered: true, expression: `dev:pg_query { describe: "${target}" } // returns every column, including those` };
    }
    return { covered: true, expression: `dev:pg_query { describe: "${target}" }` };
  },
};

/**
 * P-009b — `SELECT table_name FROM information_schema.tables WHERE table_name
 * ILIKE '%frag%'`: FINDING a relation whose name you half-remember.
 *
 * 228 atoms across 105 agents — the widest-reach cluster in the whole SQL corpus.
 * The dominant shape is a substring hunt (`%coord%`, `%rubric%`, `%checkpoint%`),
 * with a schema listing (`table_schema='harness_shared'`) second.
 *
 * `listRelations` (the engine behind `describe`) translates a psql glob into
 * `lower(schema.name) LIKE … OR lower(name) LIKE …`, so `describe: "*coord*"`
 * IS the substring hunt and `describe: "harness_shared.*"` IS the schema
 * listing — including the case-insensitivity, which it gets by lowering both
 * sides rather than by ILIKE. It also excludes `pg_catalog` and
 * `information_schema` itself, which is what most of these queries hand-write as
 * a `NOT IN` clause.
 *
 * Verified against the implementation (`pg-read-query.ts` listRelations), not
 * against the tool's description — the D-001 discipline, since the description is
 * what would have let an unfaithful claim through.
 */
export const informationSchemaTables: SqlSubstitutionPair = {
  id: 'sql.information-schema-tables',
  intentLabel: 'relation-name-lookup',
  corpus: 'sql',
  relation: 'information_schema.tables',
  // A QUOTED predicate on the relation name or its schema, and nothing reading
  // the server/connection. Both exclusions were measured, not guessed: the
  // corpus carries a `SELECT current_setting('port') … FROM information_schema
  // .tables` (a connection question wearing a catalog query's clothes) and an
  // atom whose literals arrived unquoted, which no translation can resolve
  // without guessing. Per D-008 they fall outside rather than dragging a verdict
  // about relation-name lookup.
  sqlShape:
    /^(?!.*\b(?:current_setting|inet_server_port|current_database)\s*\()(?!.*\btable_(?:name|schema)\s+in\s*\()(?!.*\btable_name\s+i?like\s*'[^']*'.*\btable_name\s+i?like\s*')(?=.*\btable_(?:name|schema)\s*(?:=|i?like)\s*')/is,
  toolName: 'dev:pg_query',
  advisoryText:
    'dev:pg_query { describe: "*fragment*" } finds relations by name fragment (the glob becomes a case-insensitive LIKE over schema.name), and { describe: "schema.*" } lists a schema — the same answer without the information_schema query.',
  routing: {
    want: 'to FIND a relation whose name you half-remember',
    use: '`dev:pg_query { describe: "*fragment*" }` — glob matched case-insensitively against `schema.name`; `{ describe: "schema.*" }` lists one schema',
    insteadOf:
      "a hand-written `SELECT table_name FROM information_schema.tables WHERE table_name ILIKE '%fragment%'`. ⚠ Names only, one glob per call — an explicit `table_name IN (…)` list, a `table_type` filter, or anything else the catalog holds still wants information_schema",
  },
  expectedVerdict: 'equivalent',
  cover(atom: string): CoverageResult {
    // Anything reaching past the relation NAME is a catalog question describe
    // does not answer, whatever else the query also does.
    if (/\btable_type\b/i.test(atom)) {
      return { covered: false, reason: 'filters or projects table_type; describe reports a relation KIND, not the catalog column' };
    }
    if (/\b(?:current_setting|inet_server_port|current_database)\s*\(/i.test(atom)) {
      return { covered: false, reason: 'also reads server/connection settings, which no describe call returns' };
    }
    // Anchored TIGHTLY to the predicate. A looser `table_name … IN (` (which is
    // what this was first written as) matches the projection's `table_name`
    // against the WHERE clause's `table_schema NOT IN (…)` several tokens later,
    // and reports a set-membership question about a query that asks nothing of
    // the kind. Caught because the reason printed did not describe the atom.
    if (/\btable_name\s+in\s*\(/i.test(atom)) {
      return { covered: false, reason: 'asks for an explicit list of names; a glob cannot express set membership' };
    }
    if (/\btable_name\s+i?like\s*'[^']*'[\s\S]*\btable_name\s+i?like\s*'/i.test(atom)) {
      return { covered: false, reason: 'searches several name fragments at once; describe takes one glob per call' };
    }
    const pattern = describePatternFromTablesQuery(atom);
    if (!pattern) {
      return { covered: false, reason: 'no name fragment or schema to translate into a describe glob' };
    }
    return { covered: true, expression: `dev:pg_query { describe: "${pattern}" }` };
  },
};

/** Every pair in the SQL corpus, in registry order. */
export const SQL_READ_PAIRS: SqlSubstitutionPair[] = [informationSchemaColumns, informationSchemaTables];
